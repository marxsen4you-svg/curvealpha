/**
 * Sizing decisions are logged and replayed bit for bit, so a faster Kelly
 * implementation must return exactly what the original did. The original is
 * kept here verbatim as the reference.
 */
import { describe, expect, it } from "vitest";
import { bootstrapEvLower, bootstrapKellyStake, kellyStake, mulberry32, quantile, type Outcome, type SizingInputs } from "../src/risk/kelly.js";
import { rng } from "./helpers/gen.js";

// ------------------------------------------------------------ reference
function refPnl(o: Outcome, stake: number, entryFixed: number, exitFixedPerTx: number, cap: number): number {
  const m = Math.min(o.multiple, cap);
  return stake * (m - 1) - entryFixed - Math.max(1, o.sellTxCount) * exitFixedPerTx;
}
function refGrowth(inp: SizingInputs, stake: number, sample: Outcome[] = inp.outcomes): number {
  let acc = 0;
  for (const o of sample) {
    const x = 1 + refPnl(o, stake, inp.entryFixedLamports, inp.exitFixedLamportsPerTx, inp.multipleCap) / inp.bankrollLamports;
    if (x <= 0) return -Infinity;
    acc += Math.log(x);
  }
  return acc / sample.length;
}
function refMeanPnl(inp: SizingInputs, stake: number, sample: Outcome[] = inp.outcomes): number {
  let acc = 0;
  for (const o of sample) acc += refPnl(o, stake, inp.entryFixedLamports, inp.exitFixedLamportsPerTx, inp.multipleCap);
  return acc / sample.length;
}
function refKelly(inp: SizingInputs, sample: Outcome[] = inp.outcomes): number {
  const hi0 = Math.min(inp.maxStakeLamports, inp.bankrollLamports * 0.999);
  if (hi0 <= 0 || sample.length === 0) return 0;
  const phi = (Math.sqrt(5) - 1) / 2;
  let a = 0;
  let b = hi0;
  let c = b - phi * (b - a);
  let d = a + phi * (b - a);
  let gc = refGrowth(inp, c, sample);
  let gd = refGrowth(inp, d, sample);
  for (let i = 0; i < 80 && b - a > 1; i++) {
    if (gc >= gd) {
      b = d;
      d = c;
      gd = gc;
      c = b - phi * (b - a);
      gc = refGrowth(inp, c, sample);
    } else {
      a = c;
      c = d;
      gc = gd;
      d = a + phi * (b - a);
      gd = refGrowth(inp, d, sample);
    }
  }
  const s = (a + b) / 2;
  const best = refGrowth(inp, s, sample) > refGrowth(inp, hi0, sample) ? s : hi0;
  return refGrowth(inp, best, sample) > 0 ? best : 0;
}
function refResample(xs: Outcome[], r: () => number): Outcome[] {
  const out = new Array<Outcome>(xs.length);
  for (let i = 0; i < xs.length; i++) out[i] = xs[Math.floor(r() * xs.length)]!;
  return out;
}
function refBootKelly(inp: SizingInputs, samples: number, q: number, seed: number) {
  const r = mulberry32(seed);
  const stakes: number[] = [];
  for (let i = 0; i < samples; i++) stakes.push(refKelly(inp, refResample(inp.outcomes, r)));
  return { stake: quantile(stakes, q), medianStake: quantile(stakes, 0.5) };
}
function refBootEv(inp: SizingInputs, stake: number, samples: number, q: number, seed: number): number {
  const r = mulberry32(seed ^ 0x9e3779b9);
  const means: number[] = [];
  for (let i = 0; i < samples; i++) means.push(refMeanPnl(inp, stake, refResample(inp.outcomes, r)));
  return quantile(means, q);
}

// ------------------------------------------------------------ cases
function cases(): SizingInputs[] {
  const r = rng(99);
  const out: SizingInputs[] = [];
  for (let k = 0; k < 12; k++) {
    const n = [20, 60, 200, 800][k % 4]!;
    const outcomes = Array.from({ length: n }, () => {
      const u = r();
      const multiple = u < 0.1 ? 0 : u < 0.6 ? r() * 0.9 : u < 0.9 ? 1 + r() : 2 + r() * r() * 80;
      return { multiple, sellTxCount: Math.floor(r() * 5) };
    });
    out.push({
      outcomes,
      bankrollLamports: [0.5e9, 2e9, 5e9][k % 3]!,
      entryFixedLamports: 5_000 + Math.floor(r() * 300_000),
      exitFixedLamportsPerTx: 5_000 + Math.floor(r() * 300_000),
      maxStakeLamports: [0.01e9, 0.1e9, 1e9][k % 3]!,
      multipleCap: [10, 50, 1000][k % 3]!,
    });
  }
  return out;
}

describe("Kelly sizing is bit-identical to the reference", () => {
  it("kellyStake", () => {
    for (const c of cases()) expect(Object.is(kellyStake(c), refKelly(c))).toBe(true);
  });
  it("bootstrapKellyStake", () => {
    for (const [i, c] of cases().entries()) {
      const a = bootstrapKellyStake(c, 60, 0.25, 1000 + i);
      const b = refBootKelly(c, 60, 0.25, 1000 + i);
      expect(Object.is(a.stake, b.stake) && Object.is(a.medianStake, b.medianStake)).toBe(true);
    }
  });
  it("bootstrapEvLower", () => {
    for (const [i, c] of cases().entries()) {
      const stake = c.maxStakeLamports / 3;
      expect(Object.is(bootstrapEvLower(c, stake, 60, 0.2, 7 + i), refBootEv(c, stake, 60, 0.2, 7 + i))).toBe(true);
    }
  });
});
