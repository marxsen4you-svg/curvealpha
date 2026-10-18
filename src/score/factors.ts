/**
 * The seven Alpha Score factors. Each returns a value in [0, 1] or null when
 * the data needed to compute it honestly is not available (a null factor is
 * dropped and the remaining weights renormalized; it is never imputed).
 * Every factor also returns the raw measurements behind it for the audit log.
 *
 * These are pure functions of the token record and context, so a logged
 * decision can be recomputed exactly.
 */
import type { Params } from "../config/params.js";
import { solToComplete } from "../math/curve.js";
import type { TokenRecord } from "../ingest/tokens.js";

export interface FactorResult {
  value: number | null;
  detail: Record<string, number | string | boolean | null>;
}

export interface CreatorStats {
  launches: number;
  graduations: number;
  medianTimeToPeakSec: number | null;
  medianFirstSellSec: number | null;
  selfBuyRate: number;
}

export interface CorpusEntry {
  mint: string;
  createdMs: number;
  /** Real SOL in the curve at 5 s checkpoints since creation (SOL, display precision). */
  inflow: number[];
  /** Spot price (lamports per token unit) at the same checkpoints. */
  price: number[];
  /** Highest spot price seen after each checkpoint. */
  maxAfter: number[];
  graduated: boolean;
}

export const CHECKPOINT_SEC = 5;
export const CHECKPOINTS = 24; // 5 s .. 120 s

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sol = (l: bigint) => Number(l) / 1e9;

/** Real SOL in the curve at time t (ms) from the trade tape. */
export function realSolAt(rec: TokenRecord, tMs: number): number {
  let v = 0n;
  for (const t of rec.trades) {
    if (t.tMs > tMs) break;
    v = t.rS;
  }
  return sol(v);
}

export function priceAt(rec: TokenRecord, tMs: number): number {
  let p = Number(rec.curve.virtualSolReserves) / Number(rec.curve.virtualTokenReserves);
  let first = true;
  for (const t of rec.trades) {
    if (t.tMs > tMs) break;
    p = Number(t.vS) / Number(t.vT);
    first = false;
  }
  if (first) return 30_000_000_000 / 1_073_000_000_000_000;
  return p;
}

// ------------------------------------------------------------ 1. creator

export function creatorFactor(rec: TokenRecord, stats: CreatorStats | null, p: Params): FactorResult {
  const bought = rec.creatorBoughtTokens;
  const soldFrac = bought > 0n ? Number(rec.creatorSoldTokens) / Number(bought) : rec.creatorSoldTokens > 0n ? 1 : 0;
  const detail: FactorResult["detail"] = {
    launches: stats?.launches ?? 0,
    graduations: stats?.graduations ?? 0,
    medianFirstSellSec: stats?.medianFirstSellSec ?? null,
    soldFractionThisToken: soldFrac,
    selfBuy: rec.creatorSelfBuy,
  };
  if (!stats || stats.launches < p.scoring.creatorMinLaunches) {
    // an unknown creator is neither rewarded nor punished beyond a cautious midpoint
    return { value: clamp01(0.4 * (1 - soldFrac)), detail: { ...detail, known: false } };
  }
  // graduation rate shrunk toward a 1 % base rate with a prior weight of 5 launches
  const base = 0.01;
  const k = 5;
  const rate = (stats.graduations + base * k) / (stats.launches + k);
  detail.shrunkGradRate = rate;
  let v = clamp01(Math.log10(rate / base) / Math.log10(20)); // 1 % -> 0, 20 % -> 1
  if (stats.launches >= 20 && stats.graduations === 0) v = 0; // serial launcher
  if (stats.medianFirstSellSec !== null && stats.medianFirstSellSec < 60) v *= 0.3; // habitual fast dumper
  v *= 1 - soldFrac;
  return { value: clamp01(v), detail: { ...detail, known: true } };
}

// ----------------------------------------------------- 2. microstructure

export function microstructureFactor(
  rec: TokenRecord,
  funders: Map<string, string | null>,
  p: Params,
): FactorResult {
  const n = p.scoring.microFirstBuys;
  const buys = rec.trades.filter((t) => t.isBuy && t.user !== rec.creator).slice(0, n);
  if (buys.length < 5) return { value: null, detail: { firstBuys: buys.length } };
  const bundled = buys.filter((t) => t.slot <= rec.createdSlot + 1).length / buys.length;
  const creationSlotBuyers = new Set(buys.filter((t) => t.slot === rec.createdSlot).map((t) => t.user)).size;
  // wallets whose whole balance was about the size of this one buy were funded for it
  const exactFunded =
    buys.filter((t) => t.preBal !== null && t.preBal <= (t.sol * 1_013n) / 1_000n + 5_000_000n).length / buys.length;
  const resolved = buys.map((t) => funders.get(t.user)).filter((f) => f !== undefined);
  let funderConcentration: number | null = null;
  if (resolved.length >= Math.ceil(buys.length / 2)) {
    const counts = new Map<string, number>();
    for (const f of resolved) if (f) counts.set(f, (counts.get(f) ?? 0) + 1);
    const top = Math.max(0, ...counts.values());
    funderConcentration = top >= 2 ? top / resolved.length : 0;
  }
  const parts: Array<[number, number]> = [
    [0.4, bundled],
    [0.3, exactFunded],
  ];
  if (funderConcentration !== null) parts.push([0.3, funderConcentration]);
  const wsum = parts.reduce((a, [w]) => a + w, 0);
  const penalty = parts.reduce((a, [w, x]) => a + w * x, 0) / wsum;
  return {
    value: clamp01(1 - penalty),
    detail: { firstBuys: buys.length, bundled, creationSlotBuyers, exactFunded, funderConcentration },
  };
}

// --------------------------------------------------------- 3. holders

export function holdersFactor(rec: TokenRecord, nowMs: number): FactorResult {
  const buys = rec.trades.filter((t) => t.isBuy);
  const buyers = new Set(buys.map((t) => t.user));
  if (buys.length < 5) return { value: null, detail: { buys: buys.length } };
  const ageSec = Math.max(1, (nowMs - rec.createdAtMs) / 1000);
  // round trips within 10 s by the same wallet are wash volume
  const lastBuy = new Map<string, number>();
  let washVol = 0;
  let vol = 0;
  for (const t of rec.trades) {
    vol += Number(t.sol);
    if (t.isBuy) lastBuy.set(t.user, t.tMs);
    else {
      const b = lastBuy.get(t.user);
      if (b !== undefined && t.tMs - b <= 10_000) washVol += 2 * Number(t.sol);
    }
  }
  const wash = vol > 0 ? Math.min(1, washVol / vol) : 0;
  // concentration of the token supply sold so far among the top 10 non-creator holders
  const held = [...rec.holders.entries()].filter(([w, v]) => w !== rec.creator && v > 0n).map(([, v]) => Number(v));
  const totalHeld = held.reduce((a, b) => a + b, 0);
  held.sort((a, b) => b - a);
  const top10 = totalHeld > 0 ? held.slice(0, 10).reduce((a, b) => a + b, 0) / totalHeld : 1;
  // sybil swarms buy near identical sizes: low dispersion of log sizes is a warning
  const logs = buys.map((t) => Math.log(Number(t.sol) + 1));
  const mean = logs.reduce((a, b) => a + b, 0) / logs.length;
  const sd = Math.sqrt(logs.reduce((a, b) => a + (b - mean) ** 2, 0) / logs.length);
  const dispersion = clamp01(sd / 1.2);
  const breadth = clamp01(Math.log1p(buyers.size / ageSec * 30) / Math.log1p(30));
  const v = breadth * (1 - wash) * (1 - Math.max(0, top10 - 0.5)) * (0.5 + 0.5 * dispersion);
  return {
    value: clamp01(v),
    detail: { uniqueBuyers: buyers.size, ageSec, washShare: wash, top10Share: top10, sizeDispersion: dispersion, breadth },
  };
}

// --------------------------------------------------------- 4. velocity

export function velocityFactor(rec: TokenRecord, nowMs: number, p: Params): FactorResult {
  const w = p.scoring.velocityWindowSec * 1000;
  const now = realSolAt(rec, nowMs);
  const prev = realSolAt(rec, nowMs - w);
  const prev2 = realSolAt(rec, nowMs - 2 * w);
  const rate = (now - prev) / (w / 1000); // SOL per second
  const prevRate = (prev - prev2) / (w / 1000);
  const accel = prevRate > 0 ? rate / prevRate : rate > 0 ? 2 : 0;
  const recent = rec.trades.filter((t) => t.tMs > nowMs - w);
  const nb = recent.filter((t) => t.isBuy).length;
  const ns = recent.length - nb;
  const imbalance = recent.length > 0 ? (nb - ns) / recent.length : 0;
  const toComplete = sol(solToComplete(rec.curve));
  const etaSec = rate > 0 ? toComplete / rate : null;
  // 0.15 SOL/s sustained inflow maps to 0.5
  const level = clamp01(rate / (rate + 0.15));
  const v = level * clamp01(0.5 + 0.25 * Math.log2(Math.max(accel, 0.25)) + 0.25) * clamp01(0.5 + imbalance / 2);
  return {
    value: clamp01(v),
    detail: { inflowSolPerSec: rate, accel, buySellImbalance: imbalance, solToComplete: toComplete, etaToGraduationSec: etaSec },
  };
}

// ------------------------------------------------------- 5. smart money

export function smartMoneyFactor(rec: TokenRecord, top: Map<string, number>, p: Params): FactorResult {
  if (top.size < Math.min(50, p.scoring.smartTopK)) return { value: null, detail: { rankedWallets: top.size } };
  const early = rec.trades.filter((t) => t.isBuy).slice(0, p.scoring.microFirstBuys);
  let weight = 0;
  let hits = 0;
  for (const t of new Map(early.map((x) => [x.user, x])).values()) {
    const rank = top.get(t.user);
    if (rank !== undefined) {
      hits++;
      weight += 1 - rank / top.size; // rank 0 is best
    }
  }
  return { value: clamp01(1 - Math.exp(-weight / 1.5)), detail: { smartBuyers: hits, weightedOverlap: weight } };
}

// ----------------------------------------------------------- 6. social

// every score compares a name against the last hour's launches; their trigram sets are built once
const TRIGRAM_CACHE_MAX = 50_000;
const trigramCache = new Map<string, Set<string>>();

function trigrams(s: string): Set<string> {
  const hit = trigramCache.get(s);
  if (hit) return hit;
  const x = ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= x.length; i++) out.add(x.slice(i, i + 3));
  if (trigramCache.size >= TRIGRAM_CACHE_MAX) trigramCache.delete(trigramCache.keys().next().value!);
  trigramCache.set(s, out);
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export interface SocialReading {
  mentions: number;
  mentionsPrevWindow: number;
}

export function socialFactor(rec: TokenRecord, recentNames: string[], x: SocialReading | null): FactorResult {
  const me = trigrams(`${rec.name} ${rec.symbol}`);
  let maxSim = 0;
  let copycats = 0;
  for (const n of recentNames) {
    const s = jaccard(me, trigrams(n));
    if (s > maxSim) maxSim = s;
    if (s > 0.8) copycats++;
  }
  const novelty = 1 - maxSim;
  const detail: FactorResult["detail"] = { novelty, copycats, xMentions: x?.mentions ?? null };
  if (!x) return { value: clamp01(novelty * (copycats > 3 ? 0.5 : 1)), detail: { ...detail, xAvailable: false } };
  const vel = 1 - Math.exp(-x.mentions / 6);
  const accel = x.mentionsPrevWindow > 0 ? x.mentions / x.mentionsPrevWindow : x.mentions > 0 ? 2 : 1;
  const v = 0.7 * vel * clamp01(0.5 + 0.25 * Math.log2(Math.max(accel, 0.25)) + 0.25) + 0.3 * novelty;
  return { value: clamp01(v), detail: { ...detail, xAvailable: true, xAccel: accel } };
}

// ------------------------------------------------------- 7. trajectory

/** Inflow vector of a live token at 5 s checkpoints up to its age. */
export function inflowVector(rec: TokenRecord, nowMs: number): number[] {
  const n = Math.min(CHECKPOINTS, Math.floor((nowMs - rec.createdAtMs) / 1000 / CHECKPOINT_SEC));
  const out: number[] = [];
  for (let i = 1; i <= n; i++) out.push(realSolAt(rec, rec.createdAtMs + i * CHECKPOINT_SEC * 1000));
  return out;
}

/** log1p of an entry's inflow path, computed once per entry and cached on it. */
export function logInflow(c: CorpusEntry): Float64Array {
  const cached = (c as CorpusEntry & { _log?: Float64Array })._log;
  if (cached) return cached;
  const a = Float64Array.from(c.inflow, (x) => Math.log1p(x));
  (c as CorpusEntry & { _log?: Float64Array })._log = a;
  return a;
}

export function trajectoryFactor(rec: TokenRecord, nowMs: number, corpus: CorpusEntry[], p: Params): FactorResult {
  if (corpus.length < p.scoring.trajectoryMinCorpus) return { value: null, detail: { corpus: corpus.length } };
  const v = inflowVector(rec, nowMs);
  const h = v.length;
  if (h < 2) return { value: null, detail: { checkpoints: h } };
  const q = Float64Array.from(v, (x) => Math.log1p(x));
  const k = p.scoring.trajectoryK;
  const winMult = p.scoring.trajectoryWinMultiple;
  // bounded selection of the k nearest (log scale: 1 vs 2 SOL matters more than 60 vs 61),
  // with early abandonment once a partial distance exceeds the current k-th best
  const bestD = new Float64Array(k).fill(Infinity);
  const bestWin = new Uint8Array(k);
  let worst = 0; // index of the largest distance kept
  let comparable = 0;
  let baseWins = 0;
  for (const c of corpus) {
    if (c.inflow.length < h) continue;
    comparable++;
    const win = c.maxAfter[h - 1]! / c.price[h - 1]! >= winMult;
    if (win) baseWins++;
    const lc = logInflow(c);
    const limit = bestD[worst]!;
    let d = 0;
    for (let i = 0; i < h && d < limit; i++) {
      const e = q[i]! - lc[i]!;
      d += e * e;
    }
    if (d < limit) {
      bestD[worst] = d;
      bestWin[worst] = win ? 1 : 0;
      for (let j = 0; j < k; j++) if (bestD[j]! > bestD[worst]!) worst = j;
    }
  }
  if (comparable < k) return { value: null, detail: { comparable } };
  let wins = 0;
  let sumD = 0;
  for (let j = 0; j < k; j++) {
    wins += bestWin[j]!;
    sumD += bestD[j]!;
  }
  const base = baseWins / comparable;
  const prior = 5;
  const shrunk = (wins + base * prior) / (k + prior);
  const value = clamp01(0.5 + (shrunk - base) / (2 * Math.max(base, 0.05)));
  return {
    value,
    detail: { checkpoints: h, neighbours: k, neighbourWinRate: wins / k, baseWinRate: base, meanDist: sumD / k },
  };
}

