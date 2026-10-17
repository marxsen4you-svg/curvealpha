/**
 * Exact pump.fun bonding curve arithmetic.
 *
 * Every function here reproduces the integer arithmetic of the pump program
 * (as mirrored by pump.fun's own @pump-fun/pump-sdk 4.1.0) using native
 * bigint: floor division where the program floors, ceiling division where it
 * ceils, the same order of operations, the same clamps. Nothing is ever
 * converted to floating point. test/curve.diff.test.ts proves equality
 * against the official SDK on randomized states; crates/curve-core proves a
 * second independent implementation (Rust, u128) against shared vectors.
 *
 * Units: lamports for SOL, raw base units (6 decimals) for tokens.
 *
 * Fees are NOT a flat 1.25 %. Since the pump-fees program went live they are
 * selected by market cap from a tier table held in the FeeConfig account, and
 * a per-coin creator rate can override the schedule creator rate. The table
 * must be read from chain at startup (see src/chain/accounts.ts). The
 * publicly reported curve rate in September 2026 was 95 bps protocol + 30 bps
 * creator (1.25 %); a curve tops out near 411 SOL of market cap at
 * graduation, so a single tier usually applies, but the code never assumes
 * either the rate or the tier.
 */

export const BPS_DENOM = 10_000n;
export const ONE_BILLION_SUPPLY = 1_000_000_000_000_000n;

export interface FeeTier {
  marketCapLamportsThreshold: bigint;
  lpFeeBps: bigint;
  protocolFeeBps: bigint;
  creatorFeeBps: bigint;
}

/** The SOL tier table from the pump-fees FeeConfig for the pump program. */
export interface FeeSchedule {
  feeTiers: FeeTier[];
}

/** The fields of the pump Global account the arithmetic depends on. */
export interface GlobalParams {
  initialVirtualTokenReserves: bigint;
  initialVirtualSolReserves: bigint;
  initialRealTokenReserves: bigint;
  tokenTotalSupply: bigint;
  /** Fallback protocol rate used only when no FeeConfig exists. */
  feeBasisPoints: bigint;
  /** Fallback creator rate used only when no FeeConfig exists. */
  creatorFeeBasisPoints: bigint;
  /** While true, a nonzero curve creatorFeeBps replaces the schedule creator rate. */
  creatorFeeConfigurable: boolean;
  /** Lamports withheld from the raised SOL at migration. */
  poolMigrationFee: bigint;
}

/** A decoded SOL-quoted bonding curve. */
export interface CurveState {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  /** False when the stored creator is the zero key (no creator fee is charged). */
  hasCreator: boolean;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  /** The coin's own creator rate; 0 means "use the schedule". */
  creatorFeeBps: bigint;
}

export interface FeeRates {
  protocolFeeBps: bigint;
  creatorFeeBps: bigint;
}

// ---------------------------------------------------------------- helpers

export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new RangeError("ceilDiv: divisor must be positive");
  if (a < 0n) throw new RangeError("ceilDiv: dividend must be non-negative");
  return (a + b - 1n) / b;
}

/** Program fee: ceil(amount * bps / 10 000). */
export function fee(amount: bigint, bps: bigint): bigint {
  return ceilDiv(amount * bps, BPS_DENOM);
}

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/** Market cap in lamports: virtualSol * supply / virtualToken (floor). */
export function marketCapLamports(
  mintSupply: bigint,
  virtualSolReserves: bigint,
  virtualTokenReserves: bigint,
): bigint {
  if (virtualTokenReserves === 0n) {
    throw new RangeError("marketCap: virtual token reserves are zero");
  }
  return (virtualSolReserves * mintSupply) / virtualTokenReserves;
}

/** pump-fees-math calculate_fee_tier. */
export function feeTierFor(feeTiers: FeeTier[], marketCap: bigint): FeeTier {
  const first = feeTiers[0];
  if (!first) throw new Error("Fee tiers cannot be empty");
  if (marketCap < first.marketCapLamportsThreshold) return first;
  for (let i = feeTiers.length - 1; i >= 0; i--) {
    const tier = feeTiers[i]!;
    if (marketCap >= tier.marketCapLamportsThreshold) return tier;
  }
  return first;
}

/**
 * The protocol and creator rates a trade on this curve pays, given the
 * supply figure the specific code path uses (see the callers).
 */
export function feeRates(
  global: GlobalParams,
  schedule: FeeSchedule | null,
  mintSupply: bigint,
  curve: CurveState,
): FeeRates {
  let rates: FeeRates;
  if (schedule) {
    const mc = marketCapLamports(
      mintSupply,
      curve.virtualSolReserves,
      curve.virtualTokenReserves,
    );
    const tier = feeTierFor(schedule.feeTiers, mc);
    rates = { protocolFeeBps: tier.protocolFeeBps, creatorFeeBps: tier.creatorFeeBps };
  } else {
    rates = {
      protocolFeeBps: global.feeBasisPoints,
      creatorFeeBps: global.creatorFeeBasisPoints,
    };
  }
  if (global.creatorFeeConfigurable && curve.creatorFeeBps !== 0n) {
    rates = { protocolFeeBps: rates.protocolFeeBps, creatorFeeBps: curve.creatorFeeBps };
  }
  return rates;
}

/** Supply used for fee tier selection on the fee-charging paths. */
function feeSupply(curve: CurveState, mintSupply: bigint): bigint {
  return curve.isMayhemMode ? mintSupply : ONE_BILLION_SUPPLY;
}

/** Total fee on `amount` lamports, each component ceiled separately. */
export function tradeFee(
  global: GlobalParams,
  schedule: FeeSchedule | null,
  mintSupply: bigint,
  curve: CurveState,
  amount: bigint,
): bigint {
  const r = feeRates(global, schedule, feeSupply(curve, mintSupply), curve);
  return fee(amount, r.protocolFeeBps) + (curve.hasCreator ? fee(amount, r.creatorFeeBps) : 0n);
}

export function isMigrated(curve: CurveState): boolean {
  return (
    curve.realSolReserves === 0n &&
    curve.virtualSolReserves === 0n &&
    curve.realTokenReserves === 0n &&
    curve.virtualTokenReserves === 0n
  );
}

// ------------------------------------------------- raw constant product legs

/** Lamports (pre fee) to take `tokens` out: tokens*vS/(vT-tokens) + 1. */
export function rawBuyCost(tokens: bigint, vT: bigint, vS: bigint): bigint {
  if (tokens >= vT) throw new RangeError("rawBuyCost: tokens exceed virtual reserves");
  return (tokens * vS) / (vT - tokens) + 1n;
}

/** Tokens out for `net` lamports in: net*vT/(vS+net). */
export function rawBuyTokens(net: bigint, vT: bigint, vS: bigint): bigint {
  return (net * vT) / (vS + net);
}

/** Lamports (pre fee) out for selling `tokens`: tokens*vS/(vT+tokens). */
export function rawSellProceeds(tokens: bigint, vT: bigint, vS: bigint): bigint {
  return (tokens * vS) / (vT + tokens);
}

// ------------------------------------------------ v1 / v2 (legacy) quoting

/**
 * Tokens a buy of `solAmount` lamports (fees included) receives on the
 * v1/v2 path (`buy_exact_sol_in`, `buy_exact_quote_in_v2`).
 * Mirrors getBuyTokenAmountFromSolAmount for an existing curve.
 */
export function buyTokensFromSol(
  global: GlobalParams,
  schedule: FeeSchedule | null,
  mintSupply: bigint,
  curve: CurveState,
  solAmount: bigint,
): bigint {
  if (solAmount === 0n) return 0n;
  if (curve.virtualTokenReserves === 0n) return 0n;
  // This path selects the tier with the caller's supply, not the fee supply.
  const r = feeRates(global, schedule, mintSupply, curve);
  const totalBps = r.protocolFeeBps + (curve.hasCreator ? r.creatorFeeBps : 0n);
  const inputAmount = ((solAmount - 1n) * BPS_DENOM) / (totalBps + BPS_DENOM);
  const tokens = rawBuyTokens(inputAmount, curve.virtualTokenReserves, curve.virtualSolReserves);
  return min(tokens, curve.realTokenReserves);
}

/** Lamports (fees included) to buy `tokens` on the v1/v2 path. */
export function buySolFromTokens(
  global: GlobalParams,
  schedule: FeeSchedule | null,
  mintSupply: bigint,
  curve: CurveState,
  tokens: bigint,
): bigint {
  if (tokens === 0n) return 0n;
  if (curve.virtualTokenReserves === 0n) return 0n;
  const take = min(tokens, curve.realTokenReserves);
  const cost = rawBuyCost(take, curve.virtualTokenReserves, curve.virtualSolReserves);
  return cost + tradeFee(global, schedule, mintSupply, curve, cost);
}

/**
 * Lamports received (after fees) for selling `tokens` (v1, v2 and v3 price
 * alike). Can be negative for dust amounts, where the separately ceiled fees
 * exceed the gross output; the program rejects such a sell, and callers treat
 * any result <= 0 as unsellable.
 */
export function sellSolFromTokens(
  global: GlobalParams,
  schedule: FeeSchedule | null,
  mintSupply: bigint,
  curve: CurveState,
  tokens: bigint,
): bigint {
  if (tokens === 0n) return 0n;
  if (curve.virtualTokenReserves === 0n) return 0n;
  const gross = rawSellProceeds(tokens, curve.virtualTokenReserves, curve.virtualSolReserves);
  return gross - tradeFee(global, schedule, mintSupply, curve, gross);
}

// ----------------------------------------------------------- v3 quoting

/** Rates on the v3 path: always the FeeConfig schedule, creator zero without a creator. */
export function v3Rates(
  global: GlobalParams,
  schedule: FeeSchedule,
  mintSupply: bigint,
  curve: CurveState,
): FeeRates {
  const r = feeRates(global, schedule, feeSupply(curve, mintSupply), curve);
  return {
    protocolFeeBps: r.protocolFeeBps,
    creatorFeeBps: curve.hasCreator ? r.creatorFeeBps : 0n,
  };
}

export function v3Fees(amount: bigint, r: FeeRates): bigint {
  return fee(amount, r.protocolFeeBps) + fee(amount, r.creatorFeeBps);
}

/** pump exact_quote_in_fees: the net lamports a budget leaves after fees. */
export function v3ExactQuoteInNet(budget: bigint, r: FeeRates): bigint {
  const totalBps = r.protocolFeeBps + r.creatorFeeBps;
  let net = totalBps === 0n ? budget : (budget * BPS_DENOM) / (totalBps + BPS_DENOM);
  const cost = net + v3Fees(net, r);
  if (cost > budget) net -= cost - budget;
  return net;
}

/** Reserves migrate_v2 would deposit once the curve leg completes the curve. */
export function poolToBe(
  global: GlobalParams,
  curve: CurveState,
  curveBaseTokenBalance: bigint,
  curveTokens: bigint,
  curveNetSol: bigint,
): { base: bigint; quote: bigint } {
  const raised = curve.realSolReserves + curveNetSol;
  const base = curveBaseTokenBalance - curveTokens;
  const quote = raised - global.poolMigrationFee;
  if (base <= 0n || quote <= 0n) {
    throw new RangeError(`Empty pool-to-be (base ${base}, quote ${quote})`);
  }
  return { base, quote };
}

/**
 * Lamports (fees included) `buy_v3` charges for `tokens`, crossing into the
 * pool-to-be when the request exceeds the remaining curve supply.
 */
export function v3BuySolFromTokens(
  global: GlobalParams,
  schedule: FeeSchedule,
  mintSupply: bigint,
  curve: CurveState,
  tokens: bigint,
  curveBaseTokenBalance: bigint,
): bigint {
  const remaining = curve.realTokenReserves;
  if (tokens === 0n || curve.complete || curve.virtualTokenReserves === 0n) return 0n;
  const r = v3Rates(global, schedule, mintSupply, curve);
  const curveTokens = min(tokens, remaining);
  const curveNet = rawBuyCost(curveTokens, curve.virtualTokenReserves, curve.virtualSolReserves);
  const curveTotal = curveNet + v3Fees(curveNet, r);
  if (tokens <= remaining || curve.isMayhemMode) return curveTotal;

  const pastCurve = tokens - remaining;
  const pool = poolToBe(global, curve, curveBaseTokenBalance, remaining, curveNet);
  if (pool.base <= pastCurve) {
    throw new RangeError("buy_v3 takes the whole pool-to-be (NotEnoughTokensToBuy)");
  }
  // pump-amm buy_quote: ceil(Q * out / (B - out))
  const legNet = (pool.quote * pastCurve + (pool.base - pastCurve) - 1n) / (pool.base - pastCurve);
  return curveTotal + legNet + v3Fees(legNet, r);
}

/**
 * Tokens `buy_exact_quote_in_v3` delivers for a `budget` (fees included),
 * including the post-completion leg (synthetic migration) when the budget
 * crosses the remaining curve supply.
 */
export function v3BuyTokensFromSol(
  global: GlobalParams,
  schedule: FeeSchedule,
  mintSupply: bigint,
  curve: CurveState,
  budget: bigint,
  curveBaseTokenBalance: bigint,
): bigint {
  if (budget === 0n || curve.complete || curve.virtualTokenReserves === 0n) return 0n;
  const r = v3Rates(global, schedule, mintSupply, curve);
  const net = v3ExactQuoteInNet(budget, r);
  if (net <= 1n) return 0n;
  const tokens = rawBuyTokens(net - 1n, curve.virtualTokenReserves, curve.virtualSolReserves);
  const remaining = curve.realTokenReserves;
  if (tokens <= remaining || curve.isMayhemMode) return min(tokens, remaining);

  const curveNet = rawBuyCost(remaining, curve.virtualTokenReserves, curve.virtualSolReserves);
  const budgetLeft = budget - (curveNet + v3Fees(curveNet, r));
  if (budgetLeft <= 0n) return remaining;
  const totalBps = r.protocolFeeBps + r.creatorFeeBps;
  const afterFees = totalBps === 0n ? budgetLeft : (budgetLeft * BPS_DENOM) / (totalBps + BPS_DENOM);
  if (afterFees < 2n) return remaining;
  const legNet = v3ExactQuoteInNet(budgetLeft, r);
  const pool = poolToBe(global, curve, curveBaseTokenBalance, remaining, curveNet);
  // pump-amm buy_exact_quote_in: floor((in - 1) * B / (Q + in - 1))
  const legTokens = ((legNet - 1n) * pool.base) / (pool.quote + legNet - 1n);
  return remaining + legTokens;
}

// ----------------------------------------------------- state transitions

/**
 * Curve state after a buy that took `tokens` for `netSol` net lamports into
 * the curve (fees excluded), as the program applies it.
 */
export function applyBuy(curve: CurveState, tokens: bigint, netSol: bigint): CurveState {
  const realTokenReserves = curve.realTokenReserves - tokens;
  return {
    ...curve,
    virtualTokenReserves: curve.virtualTokenReserves - tokens,
    virtualSolReserves: curve.virtualSolReserves + netSol,
    realTokenReserves,
    realSolReserves: curve.realSolReserves + netSol,
    complete: realTokenReserves === 0n,
  };
}

/** Curve state after a sell of `tokens` that paid out `grossSol` before fees. */
export function applySell(curve: CurveState, tokens: bigint, grossSol: bigint): CurveState {
  return {
    ...curve,
    virtualTokenReserves: curve.virtualTokenReserves + tokens,
    virtualSolReserves: curve.virtualSolReserves - grossSol,
    realTokenReserves: curve.realTokenReserves + tokens,
    realSolReserves: curve.realSolReserves - grossSol,
  };
}

/**
 * Exact on-curve execution of a v3 exact-in buy that stays on the curve:
 * tokens out, net SOL into reserves, fees paid, and the resulting state.
 * Returns null when the budget would cross into the pool-to-be; callers that
 * want the crossing quote use v3BuyTokensFromSol.
 */
export function simulateV3Buy(
  global: GlobalParams,
  schedule: FeeSchedule,
  mintSupply: bigint,
  curve: CurveState,
  budget: bigint,
): { tokens: bigint; netSol: bigint; fees: bigint; after: CurveState } | null {
  if (budget === 0n || curve.complete || curve.virtualTokenReserves === 0n) return null;
  const r = v3Rates(global, schedule, mintSupply, curve);
  const net = v3ExactQuoteInNet(budget, r);
  if (net <= 1n) return null;
  const tokens = rawBuyTokens(net - 1n, curve.virtualTokenReserves, curve.virtualSolReserves);
  if (tokens > curve.realTokenReserves || tokens === 0n) return null;
  // The program charges the exact constant-product cost of the tokens it
  // delivers, which can be below the net budget because of floor rounding.
  const netSol = rawBuyCost(tokens, curve.virtualTokenReserves, curve.virtualSolReserves);
  const fees = v3Fees(netSol, r);
  return { tokens, netSol, fees, after: applyBuy(curve, tokens, netSol) };
}

/** Exact sell: gross out of reserves, fees, net to seller, resulting state. */
export function simulateSell(
  global: GlobalParams,
  schedule: FeeSchedule | null,
  mintSupply: bigint,
  curve: CurveState,
  tokens: bigint,
): { grossSol: bigint; fees: bigint; netSol: bigint; after: CurveState } {
  const grossSol = rawSellProceeds(tokens, curve.virtualTokenReserves, curve.virtualSolReserves);
  const fees = tradeFee(global, schedule, mintSupply, curve, grossSol);
  return { grossSol, fees, netSol: grossSol - fees, after: applySell(curve, tokens, grossSol) };
}

// -------------------------------------------------------- derived figures

/** Net lamports still needed in the curve to buy out every real token. */
export function solToComplete(curve: CurveState): bigint {
  if (curve.complete || curve.realTokenReserves === 0n) return 0n;
  return rawBuyCost(curve.realTokenReserves, curve.virtualTokenReserves, curve.virtualSolReserves);
}

/** Fraction of the real token supply already sold, in basis points (floor). */
export function progressBps(global: GlobalParams, curve: CurveState): bigint {
  const sold = global.initialRealTokenReserves - curve.realTokenReserves;
  if (sold <= 0n) return 0n;
  return (sold * BPS_DENOM) / global.initialRealTokenReserves;
}

/**
 * Spot price as an exact rational: lamports per raw token = vS / vT.
 * Returned as a numerator and denominator so decisions never round it.
 */
export function spotPrice(curve: CurveState): { num: bigint; den: bigint } {
  return { num: curve.virtualSolReserves, den: curve.virtualTokenReserves };
}

/**
 * Display-only float of a ratio. Never used in a buy, sell, sizing or EV
 * decision; those use the integer functions above.
 */
export function ratioToNumber(num: bigint, den: bigint, scale = 1_000_000_000n): number {
  return Number((num * scale) / den) / Number(scale);
}
