/**
 * PumpSwap exit quoting for simulated positions after graduation.
 *
 * Live exits on PumpSwap are quoted and built by the official
 * @pump-fun/pump-swap-sdk against the live pool account (src/exec/live.ts).
 * Paper and shadow positions only need a value at the moment of migration:
 * the pool the migration deposits holds the curve's reserved tokens and the
 * raised SOL less the migration fee. This module prices a sell into that
 * pool with PumpSwap's constant product and its market cap fee tier. It is a
 * model of a pool that does not exist yet when the decision is made, and is
 * labelled as an estimate wherever its result is stored.
 */
import { ceilDiv, feeTierFor, type CurveState, type FeeSchedule, type GlobalParams } from "../math/curve.js";

export interface PoolReserves {
  base: bigint;
  quote: bigint;
}

/** Reserves migrate_v2 deposits for a completed SOL curve. */
export function poolAtMigration(global: GlobalParams, curve: CurveState, curveBaseTokenBalance: bigint): PoolReserves {
  return {
    base: curveBaseTokenBalance,
    quote: curve.realSolReserves > global.poolMigrationFee ? curve.realSolReserves - global.poolMigrationFee : 0n,
  };
}

/** Net lamports for selling `tokens` into a canonical pump pool. */
export function ammSellQuote(pool: PoolReserves, tokens: bigint, ammSchedule: FeeSchedule, supply: bigint): bigint {
  if (pool.base === 0n || pool.quote === 0n || tokens === 0n) return 0n;
  const gross = (pool.quote * tokens) / (pool.base + tokens);
  const mc = (pool.quote * supply) / pool.base;
  const t = feeTierFor(ammSchedule.feeTiers, mc);
  const fees =
    ceilDiv(gross * t.lpFeeBps, 10_000n) + ceilDiv(gross * t.protocolFeeBps, 10_000n) + ceilDiv(gross * t.creatorFeeBps, 10_000n);
  return gross > fees ? gross - fees : 0n;
}
