/**
 * Log-optimal (Kelly) sizing on an empirical, heavy-tailed outcome sample,
 * with fixed costs inside the objective.
 *
 * Textbook Kelly sizes a bet whose payoff scales with the stake. A pump.fun
 * round trip also burns fixed lamports (tx fees, priority fees, tips) that do
 * not scale. For outcome i with net proceeds multiple m_i (after curve fees
 * and price impact) and fixed cost F_i, staking s from bankroll B changes it by
 *
 *     pnl_i(s) = s * (m_i - 1) - F_i
 *
 * and the growth rate is g(s) = mean_i ln(1 + pnl_i(s) / B). g is concave in
 * s, so a golden section search finds its maximum. Because F_i > 0, g(0+) is
 * negative: a trade must beat NOT trading (g = 0), not just have positive
 * expectation. For small bankrolls this is what forces the engine to refuse.
 *
 * Heavy tails make the sample mean unstable (one 40x outlier can dominate a
 * sample), so every estimate is bootstrapped and a low quantile is used, and
 * multiples are winsorized at a cap before anything is estimated.
 */

export interface Outcome {
  /** Net SOL returned per SOL staked, after curve fees and impact, before fixed costs. */
  multiple: number;
  /** Sell transactions the exit used (each pays fixed costs). */
  sellTxCount: number;
}

export interface SizingInputs {
  outcomes: Outcome[];
  bankrollLamports: number;
  entryFixedLamports: number;
  exitFixedLamportsPerTx: number;
  maxStakeLamports: number;
  multipleCap: number;
}

export function pnl(o: Outcome, stake: number, entryFixed: number, exitFixedPerTx: number, cap: number): number {
  const m = Math.min(o.multiple, cap);
  return stake * (m - 1) - entryFixed - Math.max(1, o.sellTxCount) * exitFixedPerTx;
}

export function growth(inp: SizingInputs, stake: number, sample: Outcome[] = inp.outcomes): number {
  let acc = 0;
  for (const o of sample) {
    const x = 1 + pnl(o, stake, inp.entryFixedLamports, inp.exitFixedLamportsPerTx, inp.multipleCap) / inp.bankrollLamports;
    if (x <= 0) return -Infinity;
    acc += Math.log(x);
  }
  return acc / sample.length;
}

export function meanPnl(inp: SizingInputs, stake: number, sample: Outcome[] = inp.outcomes): number {
  let acc = 0;
  for (const o of sample) acc += pnl(o, stake, inp.entryFixedLamports, inp.exitFixedLamportsPerTx, inp.multipleCap);
  return acc / sample.length;
}

/** Stake in [0, maxStake] maximizing g; returns 0 when no stake beats not trading. */
export function kellyStake(inp: SizingInputs, sample: Outcome[] = inp.outcomes): number {
  const hi0 = Math.min(inp.maxStakeLamports, inp.bankrollLamports * 0.999);
  if (hi0 <= 0 || sample.length === 0) return 0;
  const phi = (Math.sqrt(5) - 1) / 2;
  let a = 0;
  let b = hi0;
  let c = b - phi * (b - a);
  let d = a + phi * (b - a);
  let gc = growth(inp, c, sample);
  let gd = growth(inp, d, sample);
  for (let i = 0; i < 80 && b - a > 1; i++) {
    if (gc >= gd) {
      b = d;
      d = c;
      gd = gc;
      c = b - phi * (b - a);
      gc = growth(inp, c, sample);
    } else {
      a = c;
      c = d;
      gc = gd;
      d = a + phi * (b - a);
      gd = growth(inp, d, sample);
    }
  }
  const s = (a + b) / 2;
  const best = growth(inp, s, sample) > growth(inp, hi0, sample) ? s : hi0;
  return growth(inp, best, sample) > 0 ? best : 0;
}

/** Deterministic PRNG so a logged decision can be replayed bit for bit. */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

function resample(xs: Outcome[], r: () => number): Outcome[] {
  const out = new Array<Outcome>(xs.length);
  for (let i = 0; i < xs.length; i++) out[i] = xs[Math.floor(r() * xs.length)]!;
  return out;
}

export interface BootstrapResult {
  /** Quantile q of the bootstrapped Kelly stake. */
  stake: number;
  /** All bootstrapped stakes' median, for the audit log. */
  medianStake: number;
}

export function bootstrapKellyStake(inp: SizingInputs, samples: number, q: number, seed: number): BootstrapResult {
  const r = mulberry32(seed);
  const stakes: number[] = [];
  for (let i = 0; i < samples; i++) stakes.push(kellyStake(inp, resample(inp.outcomes, r)));
  return { stake: quantile(stakes, q), medianStake: quantile(stakes, 0.5) };
}

/** Lower bootstrap quantile of the mean P&L at a given stake. */
export function bootstrapEvLower(inp: SizingInputs, stake: number, samples: number, q: number, seed: number): number {
  const r = mulberry32(seed ^ 0x9e3779b9);
  const means: number[] = [];
  for (let i = 0; i < samples; i++) means.push(meanPnl(inp, stake, resample(inp.outcomes, r)));
  return quantile(means, q);
}
