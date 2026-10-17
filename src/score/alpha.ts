/**
 * Multi-horizon Alpha Score: a weighted fusion of the seven factors, 0 to 100.
 *
 * Tokens are scored at fixed ages (params.scoring.evalHorizonsSec), so a
 * score always compares like with like. Vetoes run first and are absolute.
 * Unavailable factors are dropped and the remaining weights renormalized; if
 * less than half of the total weight is available the token is not scored at
 * all, because a score built from a minority of the evidence is not a score.
 */
import type { Params } from "../config/params.js";
import { progressBps, type GlobalParams } from "../math/curve.js";
import type { TokenRecord } from "../ingest/tokens.js";
import {
  creatorFactor,
  holdersFactor,
  microstructureFactor,
  smartMoneyFactor,
  socialFactor,
  trajectoryFactor,
  velocityFactor,
  type CorpusEntry,
  type CreatorStats,
  type FactorResult,
  type SocialReading,
} from "./factors.js";

export const FACTORS = ["creator", "microstructure", "holders", "velocity", "smartMoney", "social", "trajectory"] as const;
export type FactorName = (typeof FACTORS)[number];

export interface ScoreContext {
  creatorStats: CreatorStats | null;
  funders: Map<string, string | null>;
  smartTop: Map<string, number>;
  recentNames: string[];
  social: SocialReading | null;
  corpus: CorpusEntry[];
  global: GlobalParams;
}

export interface AlphaResult {
  mint: string;
  horizonSec: number;
  vetoed: string | null;
  score: number | null;
  /** Share of total weight backed by available factors. */
  coverage: number;
  factors: Record<FactorName, FactorResult>;
  contributions: Partial<Record<FactorName, number>>;
  elapsedMs: number;
}

export function vetoes(rec: TokenRecord, global: GlobalParams): string | null {
  if (!rec.quoteIsSol) return "quote is not SOL";
  if (rec.isMayhem) return "mayhem mode curve";
  if (rec.isCashback) return "cashback coin (v3 instructions unsupported)";
  if (rec.gap) return "data gap: an event for this mint was dropped";
  if (rec.tainted) return "data tainted by a dead slot";
  if (rec.curve.complete) return "curve complete";
  if (progressBps(global, rec.curve) > 9_000n) return "more than 90 % of the curve sold";
  const bought = rec.creatorBoughtTokens;
  if (bought > 0n && rec.creatorSoldTokens * 2n >= bought) return "creator has sold half or more";
  return null;
}

export function scoreToken(rec: TokenRecord, horizonSec: number, nowMs: number, ctx: ScoreContext, p: Params): AlphaResult {
  const t0 = performance.now();
  const factors: Record<FactorName, FactorResult> = {
    creator: creatorFactor(rec, ctx.creatorStats, p),
    microstructure: microstructureFactor(rec, ctx.funders, p),
    holders: holdersFactor(rec, nowMs),
    velocity: velocityFactor(rec, nowMs, p),
    smartMoney: smartMoneyFactor(rec, ctx.smartTop, p),
    social: socialFactor(rec, ctx.recentNames, ctx.social),
    trajectory: trajectoryFactor(rec, nowMs, ctx.corpus, p),
  };
  const veto = vetoes(rec, ctx.global);
  const w = p.scoring.weights;
  const total = FACTORS.reduce((a, f) => a + w[f], 0);
  let avail = 0;
  let acc = 0;
  const contributions: Partial<Record<FactorName, number>> = {};
  for (const f of FACTORS) {
    const v = factors[f].value;
    if (v === null || w[f] === 0) continue;
    avail += w[f];
    acc += w[f] * v;
  }
  for (const f of FACTORS) {
    const v = factors[f].value;
    if (v !== null && avail > 0) contributions[f] = (100 * w[f] * v) / avail;
  }
  const coverage = total > 0 ? avail / total : 0;
  const score = veto || coverage < 0.5 || avail === 0 ? null : (100 * acc) / avail;
  return {
    mint: rec.mint,
    horizonSec,
    vetoed: veto ?? (coverage < 0.5 ? `coverage ${(coverage * 100).toFixed(0)} % of factor weight` : null),
    score,
    coverage,
    factors,
    contributions,
    elapsedMs: performance.now() - t0,
  };
}
