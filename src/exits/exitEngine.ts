/**
 * Quantitative exit engine: the primary source of realized edge.
 *
 * On a power-law payoff most tokens die and a few run. The ladder sells
 * enough on the way up to recover the stake early and leaves a small runner
 * for the tail; everything else is about cutting the losers fast.
 *
 * Every trigger is evaluated on the exact liquidation value of the tokens
 * still held, the lamports a sell would actually return right now after fees
 * and price impact, computed with the bit-exact curve math. Multiples are
 * integers scaled by 1e6; no float price enters a sell decision.
 *
 * Triggers, in priority order:
 *   1. dev / creator dump since entry       sell all, emergency tip
 *   2. curve complete (migration)           sell all on PumpSwap, or hold
 *   3. hard stop loss                       sell all
 *   4. hard maximum hold time               sell all
 *   5. trailing stop after the first rung   sell all
 *   6. momentum decay before the first rung sell all
 *   7. take-profit rung reached             sell that rung's share
 *   8. worthless remainder                  burn and close (recovers ATA rent)
 */
import type { Params } from "../config/params.js";
import { type CurveState, type FeeSchedule, type GlobalParams, sellSolFromTokens } from "../math/curve.js";
import { realSolAt } from "../score/factors.js";
import { TokenBook, type TokenRecord } from "../ingest/tokens.js";

export const E6 = 1_000_000n;

export interface ExitState {
  mint: string;
  stakeLamports: bigint;
  initialTokens: bigint;
  remainingTokens: bigint;
  openedAtMs: number;
  tpDone: boolean[];
  peakMultipleE6: bigint;
  peakInflowRate: number;
  creatorHeldAtEntry: bigint;
  creatorSoldAtEntry: bigint;
  realizedLamports: bigint;
  sellTxCount: number;
  closed: boolean;
}

export type ExitAction =
  | { kind: "sell"; tokens: bigint; reason: string; urgency: "normal" | "emergency"; venue: "curve" | "amm"; rung?: number }
  | { kind: "burnClose"; reason: string };

export interface CurveCtx {
  global: GlobalParams;
  schedule: FeeSchedule;
  mintSupply: bigint;
}

export function openExitState(mint: string, stake: bigint, tokens: bigint, rec: TokenRecord, nowMs: number, p: Params): ExitState {
  return {
    mint,
    stakeLamports: stake,
    initialTokens: tokens,
    remainingTokens: tokens,
    openedAtMs: nowMs,
    tpDone: p.exits.tpLevels.map(() => false),
    peakMultipleE6: 0n,
    peakInflowRate: 0,
    creatorHeldAtEntry: TokenBook.creatorHeld(rec),
    creatorSoldAtEntry: rec.creatorSoldTokens,
    realizedLamports: 0n,
    sellTxCount: 0,
    closed: false,
  };
}

/** Lamports a full sell of `tokens` returns on this curve right now (0 if unsellable). */
export function liquidationValue(ctx: CurveCtx, curve: CurveState, tokens: bigint): bigint {
  if (tokens === 0n || curve.complete || curve.virtualTokenReserves === 0n) return 0n;
  const v = sellSolFromTokens(ctx.global, ctx.schedule, ctx.mintSupply, curve, tokens);
  return v > 0n ? v : 0n;
}

/** Liquidation value of the remainder per lamport of its share of the stake, scaled 1e6. */
export function remainderMultipleE6(s: ExitState, ctx: CurveCtx, curve: CurveState): bigint {
  if (s.remainingTokens === 0n) return 0n;
  const costShare = (s.stakeLamports * s.remainingTokens) / s.initialTokens;
  if (costShare === 0n) return 0n;
  return (liquidationValue(ctx, curve, s.remainingTokens) * E6) / costShare;
}

const toE6 = (x: number) => BigInt(Math.round(x * 1e6));

export function evaluateExit(s: ExitState, rec: TokenRecord, ctx: CurveCtx, p: Params, nowMs: number, exitFixedPerTx: bigint): ExitAction | null {
  if (s.closed || s.remainingTokens === 0n) return null;
  const e = p.exits;
  const all = s.remainingTokens;

  // 1. creator dumping since we entered
  const soldSinceEntry = rec.creatorSoldTokens - s.creatorSoldAtEntry;
  if (s.creatorHeldAtEntry > 0n && soldSinceEntry > 0n) {
    const fracE6 = (soldSinceEntry * E6) / s.creatorHeldAtEntry;
    if (fracE6 >= toE6(e.devSellExitFraction)) {
      return { kind: "sell", tokens: all, reason: `creator sold ${(Number(fracE6) / 1e4).toFixed(1)}% of their tokens`, urgency: "emergency", venue: rec.curve.complete ? "amm" : "curve" };
    }
  }

  // 2. migration
  if (rec.curve.complete) {
    if (e.migrationAction === "exit") return { kind: "sell", tokens: all, reason: "curve complete: exit on PumpSwap", urgency: "normal", venue: "amm" };
    return null;
  }

  const m = remainderMultipleE6(s, ctx, rec.curve);
  if (m > s.peakMultipleE6) s.peakMultipleE6 = m;
  const ageSec = (nowMs - s.openedAtMs) / 1000;

  // 8. dust: a remainder worth less than the fee to sell it is burned and its account closed
  const value = liquidationValue(ctx, rec.curve, all);
  if (value <= exitFixedPerTx) {
    if (ageSec >= e.momentumMinHoldSec || m <= toE6(1 - e.stopLossPct)) {
      return { kind: "burnClose", reason: `remainder worth ${value} lamports, below the ${exitFixedPerTx} lamport cost to sell it` };
    }
  }

  // 3. stop loss
  if (m <= toE6(1 - e.stopLossPct)) {
    return { kind: "sell", tokens: all, reason: `stop: liquidation multiple ${(Number(m) / 1e6).toFixed(3)}`, urgency: "emergency", venue: "curve" };
  }
  // 4. max hold
  if (ageSec >= e.maxHoldSec) {
    return { kind: "sell", tokens: all, reason: `max hold ${e.maxHoldSec}s reached`, urgency: "normal", venue: "curve" };
  }
  const firstRungDone = s.tpDone[0] === true;
  // 5. trailing stop once the stake is partly recovered
  if (firstRungDone && s.peakMultipleE6 > 0n) {
    const floor = (s.peakMultipleE6 * toE6(1 - e.trailingFromPeakPct)) / E6;
    if (m <= floor) {
      return { kind: "sell", tokens: all, reason: `trailing stop: ${(Number(m) / 1e6).toFixed(3)} vs peak ${(Number(s.peakMultipleE6) / 1e6).toFixed(3)}`, urgency: "normal", venue: "curve" };
    }
  }
  // 6. momentum decay before the first rung
  const w = e.momentumWindowSec * 1000;
  const rate = (realSolAt(rec, nowMs) - realSolAt(rec, nowMs - w)) / e.momentumWindowSec;
  if (rate > s.peakInflowRate) s.peakInflowRate = rate;
  if (!firstRungDone && ageSec >= e.momentumMinHoldSec && s.peakInflowRate > 0 && rate < e.momentumDecayRatio * s.peakInflowRate) {
    return { kind: "sell", tokens: all, reason: `momentum decayed to ${rate.toFixed(4)} SOL/s from a peak of ${s.peakInflowRate.toFixed(4)}`, urgency: "normal", venue: "curve" };
  }
  // 7. take-profit ladder, measured on the remainder's liquidation multiple
  for (let i = 0; i < e.tpLevels.length; i++) {
    if (s.tpDone[i]) continue;
    if (m >= toE6(e.tpLevels[i]!)) {
      const share = (s.initialTokens * toE6(e.tpFractions[i]!)) / E6;
      const tokens = share > all ? all : share;
      if (tokens > 0n) return { kind: "sell", tokens, reason: `take profit rung ${i + 1} at ${e.tpLevels[i]}x`, urgency: "normal", venue: "curve", rung: i };
      s.tpDone[i] = true;
    }
    break; // rungs fire in order
  }
  return null;
}

/** Record a completed sell against the exit state. */
export function applyExitFill(s: ExitState, action: ExitAction, tokensSold: bigint, lamportsOut: bigint): void {
  s.remainingTokens -= tokensSold;
  s.realizedLamports += lamportsOut;
  if (action.kind === "sell") {
    s.sellTxCount++;
    if (action.rung !== undefined) s.tpDone[action.rung] = true;
  }
  if (action.kind === "burnClose" || s.remainingTokens <= 0n) {
    s.remainingTokens = 0n;
    s.closed = true;
  }
}
