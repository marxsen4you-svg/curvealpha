/**
 * Exact cost model for one round trip.
 *
 * Proportional costs (curve fees and price impact) are not modelled here as
 * percentages: they are computed exactly by src/math/curve.ts against the
 * live curve state. This module adds the fixed per-transaction costs, which
 * dominate at small sizes and which most bots ignore:
 *
 *   base fee      5 000 lamports per signature (one signer per tx)
 *   priority fee  ceil(cuPrice * cuLimit / 1 000 000), charged on the
 *                 requested limit, not on what the tx consumed
 *   Jito tip      paid only if the bundle lands
 *   ATA rent      locked while holding, refunded when the account is closed
 *                 (the final sell tx closes it), so it is capital at work,
 *                 not a cost, but it must be available up front
 */
import {
  type CurveState,
  type FeeSchedule,
  type GlobalParams,
  applyBuy,
  rawBuyTokens,
  sellSolFromTokens,
  simulateV3Buy,
} from "../math/curve.js";

export const BASE_FEE_PER_SIGNATURE = 5_000n;
/** Token-2022 ATA with the ImmutableOwner extension (170 bytes). Replaced by a live rent query at startup. */
export const DEFAULT_ATA_RENT = 2_074_080n;

export interface TxCostInputs {
  cuPriceMicroLamports: bigint;
  buyCuLimit: bigint;
  sellCuLimit: bigint;
  entryTipLamports: bigint;
  exitTipLamports: bigint;
  ataRentLamports: bigint;
}

export function priorityFee(cuPriceMicroLamports: bigint, cuLimit: bigint): bigint {
  const p = cuPriceMicroLamports * cuLimit;
  return (p + 999_999n) / 1_000_000n;
}

export function entryFixedCost(c: TxCostInputs): bigint {
  return BASE_FEE_PER_SIGNATURE + priorityFee(c.cuPriceMicroLamports, c.buyCuLimit) + c.entryTipLamports;
}

export function exitFixedCostPerTx(c: TxCostInputs): bigint {
  return BASE_FEE_PER_SIGNATURE + priorityFee(c.cuPriceMicroLamports, c.sellCuLimit) + c.exitTipLamports;
}

/** Fixed lamports burned by a round trip that exits in `sellTxCount` transactions. */
export function roundTripFixedCost(c: TxCostInputs, sellTxCount: number): bigint {
  return entryFixedCost(c) + BigInt(Math.max(1, sellTxCount)) * exitFixedCostPerTx(c);
}

/** Lamports that must be in the wallet to open a position of `stake`. */
export function capitalRequired(c: TxCostInputs, stake: bigint): bigint {
  return stake + entryFixedCost(c) + c.ataRentLamports;
}

export interface Breakeven {
  tokens: bigint;
  /** Net SOL from selling everything right after buying (impact and fees both ways). */
  immediateExitLamports: bigint;
  /** SOL other traders must net into the curve before a full exit returns stake plus fixed costs. */
  breakevenInflowLamports: bigint | null;
  /** Spot price multiple (vs. the pre-buy spot) at the breakeven point, scaled by 1e6. */
  breakevenPriceMultipleE6: bigint | null;
}

/**
 * How much the curve must move for this trade to break even, solved exactly
 * by integer bisection on other traders' net inflow.
 */
export function breakeven(
  global: GlobalParams,
  schedule: FeeSchedule,
  mintSupply: bigint,
  curve: CurveState,
  stake: bigint,
  fixedCost: bigint,
): Breakeven {
  const buy = simulateV3Buy(global, schedule, mintSupply, curve, stake);
  if (!buy) {
    return { tokens: 0n, immediateExitLamports: 0n, breakevenInflowLamports: null, breakevenPriceMultipleE6: null };
  }
  const target = stake + fixedCost;
  const proceedsAfterInflow = (x: bigint): bigint => {
    // other traders buy x net lamports of tokens after us (their tokens leave the curve)
    let s = buy.after;
    if (x > 0n) {
      const t = rawBuyTokens(x, s.virtualTokenReserves, s.virtualSolReserves);
      if (t > s.realTokenReserves) return -1n;
      s = applyBuy(s, t, x);
    }
    return sellSolFromTokens(global, schedule, mintSupply, s, buy.tokens);
  };
  const immediate = proceedsAfterInflow(0n);
  if (immediate >= target) {
    return { tokens: buy.tokens, immediateExitLamports: immediate, breakevenInflowLamports: 0n, breakevenPriceMultipleE6: 1_000_000n };
  }
  let lo = 0n;
  let hi = 200_000_000_000n; // beyond graduation; capped by realTokenReserves inside
  if (proceedsAfterInflow(hi) < target) {
    // find the largest inflow the curve can absorb before completing
    let a = 0n;
    let b = hi;
    while (b - a > 1n) {
      const m = (a + b) / 2n;
      if (proceedsAfterInflow(m) >= 0n) a = m;
      else b = m;
    }
    if (proceedsAfterInflow(a) < target) {
      return { tokens: buy.tokens, immediateExitLamports: immediate, breakevenInflowLamports: null, breakevenPriceMultipleE6: null };
    }
    hi = a;
  }
  while (hi - lo > 1n) {
    const m = (lo + hi) / 2n;
    if (proceedsAfterInflow(m) >= target) hi = m;
    else lo = m;
  }
  const t = rawBuyTokens(hi, buy.after.virtualTokenReserves, buy.after.virtualSolReserves);
  const s = applyBuy(buy.after, t, hi);
  // price multiple vs pre-buy spot: (vS'/vT') / (vS/vT)
  const mult =
    (s.virtualSolReserves * curve.virtualTokenReserves * 1_000_000n) /
    (s.virtualTokenReserves * curve.virtualSolReserves);
  return { tokens: buy.tokens, immediateExitLamports: immediate, breakevenInflowLamports: hi, breakevenPriceMultipleE6: mult };
}
