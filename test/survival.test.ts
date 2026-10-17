import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS, type Params, resolveParams, countParams } from "../src/config/params.js";
import { CapitalSurvivalEngine, type Candidate } from "../src/risk/survival.js";
import { kellyStake, type Outcome } from "../src/risk/kelly.js";
import { breakeven, capitalRequired, priorityFee, roundTripFixedCost } from "../src/risk/costs.js";
import { MAINNET_GLOBAL, curveSchedule } from "./helpers/gen.js";
import { rng } from "./helpers/gen.js";

const SOL = 1e9;
const T0 = Date.UTC(2026, 9, 17, 12, 0, 0);

function engine(equitySol: number, p: Params = DEFAULT_PARAMS) {
  return new CapitalSurvivalEngine(() => p, equitySol * SOL, T0);
}

/** A strongly favorable but heavy-tailed sample: most lose, a few win big. */
function goodOutcomes(n = 200): Outcome[] {
  const r = rng(7);
  return Array.from({ length: n }, () => {
    const u = r();
    const multiple = u < 0.55 ? 0.55 : u < 0.8 ? 1.3 : u < 0.95 ? 2.4 : 6;
    return { multiple, sellTxCount: multiple > 1 ? 3 : 1 };
  });
}

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    mint: "Mint1111111111111111111111111111111111111111",
    alphaScore: 92,
    horizonSec: 30,
    outcomes: goodOutcomes(),
    entryFixedLamports: 5_000 + 300 + 10_000,
    exitFixedLamportsPerTx: 5_000 + 300 + 10_000,
    entryTipLamports: 10_000,
    ataRentLamports: 2_074_080,
    spendableLamports: 100 * SOL,
    seed: 1234,
    ...over,
  };
}

describe("parameters", () => {
  it("defaults validate and expose at least 60 tunables", () => {
    expect(() => resolveParams({})).not.toThrow();
    expect(countParams()).toBeGreaterThanOrEqual(60);
  });
  it("rejects inconsistent ladders and out of range risk", () => {
    expect(() => resolveParams({ exits: { tpFractions: [0.5, 0.5, 0.5, 0.5] } })).toThrow();
    expect(() => resolveParams({ risk: { maxRiskPerTradePct: 0.05 } })).toThrow();
    expect(() => resolveParams({ exits: { tpLevels: [2, 1.5, 4, 8] } })).toThrow();
  });
});

describe("Kelly with fixed costs", () => {
  it("matches the closed form for a binary bet when fixed costs are zero", () => {
    // p = 0.6 to win b = 1 (multiple 2), else lose all: f* = p - q/b = 0.2
    const outcomes: Outcome[] = [];
    for (let i = 0; i < 600; i++) outcomes.push({ multiple: 2, sellTxCount: 1 });
    for (let i = 0; i < 400; i++) outcomes.push({ multiple: 0, sellTxCount: 1 });
    const s = kellyStake({
      outcomes,
      bankrollLamports: 1e9,
      entryFixedLamports: 0,
      exitFixedLamportsPerTx: 0,
      maxStakeLamports: 1e9,
      multipleCap: 1000,
    });
    expect(s / 1e9).toBeCloseTo(0.2, 3);
  });

  it("fixed costs shrink the optimum and can remove it entirely", () => {
    const outcomes: Outcome[] = [];
    for (let i = 0; i < 52; i++) outcomes.push({ multiple: 1.5, sellTxCount: 1 });
    for (let i = 0; i < 48; i++) outcomes.push({ multiple: 0.5, sellTxCount: 1 });
    const base = { outcomes, bankrollLamports: 0.5e9, maxStakeLamports: 0.5e9, multipleCap: 1000 };
    const free = kellyStake({ ...base, entryFixedLamports: 0, exitFixedLamportsPerTx: 0 });
    const costly = kellyStake({ ...base, entryFixedLamports: 2_000_000, exitFixedLamportsPerTx: 2_000_000 });
    expect(free).toBeGreaterThan(0);
    expect(costly).toBe(0);
  });
});

describe("Capital Survival Engine", () => {
  it("approves a strong candidate and respects the per-trade risk cap", () => {
    const e = engine(3);
    const d = e.decide(candidate(), T0);
    expect(d.approved).toBe(true);
    expect(d.stakeLamports).toBeLessThanOrEqual(0.0125 * 3 * SOL);
    expect(d.tipBudgetLamports).toBeGreaterThan(0);
    expect(d.trace.evLowerLamports!).toBeGreaterThan(d.trace.minEdgeLamports!);
  });

  it("refuses the same edge at 0.5 SOL when realistic tips make fixed costs dominate", () => {
    const heavy = { entryFixedLamports: 1_500_000, exitFixedLamportsPerTx: 1_000_000, entryTipLamports: 1_000_000 };
    expect(engine(0.5).decide(candidate(heavy), T0).approved).toBe(false);
    expect(engine(50).decide(candidate(heavy), T0).approved).toBe(true);
  });

  it("never approves when the outcome sample has negative expectation", () => {
    const r = rng(99);
    for (let k = 0; k < 40; k++) {
      const outcomes: Outcome[] = Array.from({ length: 150 }, () => ({
        multiple: r() < 0.97 ? r() * 1.4 : 1 + r() * 4,
        sellTxCount: 1,
      }));
      const mean = outcomes.reduce((a, o) => a + o.multiple, 0) / outcomes.length;
      if (mean >= 1) continue;
      expect(engine(5).decide(candidate({ outcomes }), T0).approved).toBe(false);
    }
  });

  it("refuses without enough evidence, below threshold, and at the concurrency limit", () => {
    const e = engine(3);
    expect(e.decide(candidate({ outcomes: goodOutcomes(20) }), T0).reasons[0]).toMatch(/^evidence/);
    expect(e.decide(candidate({ alphaScore: 60 }), T0).reasons[0]).toMatch(/^alpha/);
    e.setOpenPositions(2);
    expect(e.decide(candidate(), T0).reasons[0]).toMatch(/^concurrency/);
  });

  it("raises the threshold and shrinks size as drawdown deepens", () => {
    const e = engine(4);
    const normal = e.decide(candidate(), T0);
    const e2 = engine(4);
    e2.updateEquity(4.4 * SOL, T0);
    e2.updateEquity(4.4 * SOL, T0 + 86_400_000); // new day starts at 4.4
    e2.updateEquity(4.4 * SOL * 0.885, T0 + 86_400_000 + 1_000); // 11.5% drawdown, 11.5% day loss
    expect(e2.mode(T0 + 86_400_000 + 1_000)).toBe("CAUTION");
    const caution = e2.decide(candidate(), T0 + 86_400_000 + 2_000);
    expect(caution.trace.threshold).toBeGreaterThan(normal.trace.threshold);
    expect(caution.trace.survivalMultiplier).toBe(DEFAULT_PARAMS.risk.cautionSizeMult);

    const e3 = engine(4);
    e3.updateEquity(5 * SOL, T0);
    e3.updateEquity(5 * SOL, T0 + 86_400_000);
    e3.updateEquity(4.6 * SOL, T0 + 2 * 86_400_000);
    e3.updateEquity(4.6 * SOL * 0.95, T0 + 3 * 86_400_000);
    e3.updateEquity(3.9 * SOL, T0 + 4 * 86_400_000); // 22% below the 5 SOL peak
    expect(e3.mode(T0 + 4 * 86_400_000)).toBe("SURVIVAL");
    const surv = e3.decide(candidate({ alphaScore: 99 }), T0 + 4 * 86_400_000);
    expect(surv.trace.survivalMultiplier).toBe(DEFAULT_PARAMS.risk.survivalSizeMult);
    expect(surv.trace.threshold).toBeGreaterThan(caution.trace.threshold);
  });

  it("trips the daily loss breaker, halts 24 h, survives a restart, then recovers", () => {
    const e = engine(2);
    e.updateEquity(2 * SOL * 0.87, T0 + 60_000); // -13 % today
    expect(e.mode(T0 + 60_000)).toBe("HALTED");
    expect(e.decide(candidate({ alphaScore: 100 }), T0 + 60_000).reasons[0]).toMatch(/^halted/);

    const snap = e.snapshot(T0 + 60_000);
    const restarted = new CapitalSurvivalEngine(() => DEFAULT_PARAMS, 1, T0 + 120_000);
    restarted.restore(snap);
    expect(restarted.mode(T0 + 120_000)).toBe("HALTED");

    const later = T0 + 60_000 + 24 * 3_600_000 + 1;
    restarted.updateEquity(2 * SOL * 0.87, later);
    expect(restarted.mode(later)).not.toBe("HALTED");
  });

  it("halts below the bankroll floor until cleared by the operator", () => {
    const e2 = engine(0.24);
    e2.updateEquity(0.24 * SOL, T0 + 2);
    expect(e2.mode(T0 + 2)).toBe("HALTED");
    expect(e2.snapshot(T0 + 2).haltReason).toMatch(/floor/);
    e2.clearHalt();
    e2.updateEquity(0.3 * SOL, T0 + 3);
    expect(e2.mode(T0 + 3)).not.toBe("HALTED");
  });

  it("consumes the daily risk budget", () => {
    const e = engine(3);
    const d1 = e.decide(candidate(), T0);
    e.recordOpen(d1.stakeLamports);
    e.recordOpen(d1.stakeLamports);
    e.recordOpen(d1.stakeLamports);
    e.recordOpen(d1.stakeLamports);
    const d2 = e.decide(candidate(), T0);
    expect(d2.trace.dailyBudgetStake).toBeLessThan(d1.trace.dailyBudgetStake);
  });

  it("is deterministic and replays exactly from the logged snapshot", () => {
    const e = engine(3);
    const snap = e.snapshot(T0);
    const c = candidate();
    const d = e.decide(c, T0);
    const r = CapitalSurvivalEngine.replay(DEFAULT_PARAMS, snap, c, T0);
    expect(r).toEqual(d);
  });
});

describe("exact cost model", () => {
  it("priority fee is charged on the requested limit and ceiled", () => {
    expect(priorityFee(1000n, 120_000n)).toBe(120n);
    expect(priorityFee(1n, 1n)).toBe(1n);
    const c = { cuPriceMicroLamports: 1000n, buyCuLimit: 150_000n, sellCuLimit: 120_000n, entryTipLamports: 10_000n, exitTipLamports: 10_000n, ataRentLamports: 2_074_080n };
    expect(roundTripFixedCost(c, 3)).toBe(5_000n + 150n + 10_000n + 3n * (5_000n + 120n + 10_000n));
    expect(capitalRequired(c, 10_000_000n)).toBe(10_000_000n + 15_150n + 2_074_080n);
  });

  it("breakeven needs inflow, more of it when fixed costs are larger", () => {
    const g = MAINNET_GLOBAL;
    const curve = {
      virtualTokenReserves: 900_000_000_000_000n,
      virtualSolReserves: (g.initialVirtualTokenReserves * g.initialVirtualSolReserves) / 900_000_000_000_000n,
      realTokenReserves: 900_000_000_000_000n - 279_900_000_000_000n,
      realSolReserves: 0n,
      tokenTotalSupply: g.tokenTotalSupply,
      complete: false,
      hasCreator: true,
      isMayhemMode: false,
      isCashbackCoin: false,
      creatorFeeBps: 0n,
    };
    curve.realSolReserves = curve.virtualSolReserves - g.initialVirtualSolReserves;
    const cheap = breakeven(g, curveSchedule(), g.tokenTotalSupply, curve, 50_000_000n, 30_000n);
    const dear = breakeven(g, curveSchedule(), g.tokenTotalSupply, curve, 50_000_000n, 3_000_000n);
    expect(cheap.immediateExitLamports < 50_000_000n).toBe(true);
    expect(cheap.breakevenInflowLamports! > 0n).toBe(true);
    expect(dear.breakevenInflowLamports! > cheap.breakevenInflowLamports!).toBe(true);
    expect(dear.breakevenPriceMultipleE6! > 1_000_000n).toBe(true);
  });
});
