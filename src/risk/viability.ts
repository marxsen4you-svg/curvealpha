/**
 * What a small bankroll is up against, computed exactly.
 *
 * For each bankroll the largest stake the per-trade risk cap allows is
 * bought on a representative curve (10 SOL already raised) and the table
 * shows what the fixed transaction costs and the curve's own fees and price
 * impact take, and how far the curve must move before a full exit returns
 * the stake. The curve part uses the exact program arithmetic; the fixed part
 * uses the tip and compute price you pass in.
 */
import { applyBuy, rawBuyTokens, type CurveState, type FeeSchedule, type GlobalParams } from "../math/curve.js";
import { breakeven, priorityFee, BASE_FEE_PER_SIGNATURE } from "./costs.js";
import { DEFAULT_PARAMS } from "../config/params.js";

export const REFERENCE_GLOBAL: GlobalParams = {
  initialVirtualTokenReserves: 1_073_000_000_000_000n,
  initialVirtualSolReserves: 30_000_000_000n,
  initialRealTokenReserves: 793_100_000_000_000n,
  tokenTotalSupply: 1_000_000_000_000_000n,
  feeBasisPoints: 95n,
  creatorFeeBasisPoints: 30n,
  creatorFeeConfigurable: false,
  poolMigrationFee: 15_000_001n,
};

/** Publicly reported curve rate (Sept 2026); the engine itself reads the live table. */
export const REPORTED_CURVE_SCHEDULE: FeeSchedule = {
  feeTiers: [{ marketCapLamportsThreshold: 0n, lpFeeBps: 0n, protocolFeeBps: 95n, creatorFeeBps: 30n }],
};

export function referenceCurve(raisedLamports: bigint, g = REFERENCE_GLOBAL): CurveState {
  const init: CurveState = {
    virtualTokenReserves: g.initialVirtualTokenReserves,
    virtualSolReserves: g.initialVirtualSolReserves,
    realTokenReserves: g.initialRealTokenReserves,
    realSolReserves: 0n,
    tokenTotalSupply: g.tokenTotalSupply,
    complete: false,
    hasCreator: true,
    isMayhemMode: false,
    isCashbackCoin: false,
    creatorFeeBps: 0n,
  };
  const t = rawBuyTokens(raisedLamports, init.virtualTokenReserves, init.virtualSolReserves);
  return applyBuy(init, t, raisedLamports);
}

export interface ViabilityRow {
  bankrollSol: number;
  stakeSol: number;
  fixedRoundTripSol: number;
  fixedPctOfStake: number;
  immediateExitPctLost: number;
  breakevenPriceMultiple: number | null;
}

export function viabilityRows(
  tipLamports: bigint,
  cuPriceMicroLamports: bigint,
  bankrollsSol = [0.5, 1, 2, 3, 5],
  sellTxs = 3,
  schedule = REPORTED_CURVE_SCHEDULE,
): ViabilityRow[] {
  const g = REFERENCE_GLOBAL;
  const curve = referenceCurve(10_000_000_000n);
  const e = DEFAULT_PARAMS.execution;
  const entry = BASE_FEE_PER_SIGNATURE + priorityFee(cuPriceMicroLamports, BigInt(e.paperBuyCuLimit)) + tipLamports;
  const exit = BASE_FEE_PER_SIGNATURE + priorityFee(cuPriceMicroLamports, BigInt(e.paperSellCuLimit)) + tipLamports;
  const fixed = entry + BigInt(sellTxs) * exit;
  return bankrollsSol.map((b) => {
    const stake = BigInt(Math.floor(b * 1e9 * DEFAULT_PARAMS.risk.maxRiskPerTradePct));
    const be = breakeven(g, schedule, g.tokenTotalSupply, curve, stake, fixed);
    return {
      bankrollSol: b,
      stakeSol: Number(stake) / 1e9,
      fixedRoundTripSol: Number(fixed) / 1e9,
      fixedPctOfStake: Number((fixed * 1_000_000n) / stake) / 10_000,
      immediateExitPctLost: Number(((stake - be.immediateExitLamports) * 1_000_000n) / stake) / 10_000,
      breakevenPriceMultiple: be.breakevenPriceMultipleE6 === null ? null : Number(be.breakevenPriceMultipleE6) / 1e6,
    };
  });
}

export function viabilityTable(tipLamports: bigint, cuPriceMicroLamports: bigint): string {
  const rows = viabilityRows(tipLamports, cuPriceMicroLamports);
  const head = `Tip ${tipLamports} lamports per tx, compute price ${cuPriceMicroLamports} micro-lamports/CU, 1 buy + 3 sells, curve at 10 SOL raised.\n`;
  const cols = "bankroll  stake(1.25%)  fixed costs  fixed % of stake  curve fees+impact if sold at once  price move to break even";
  const lines = rows.map(
    (r) =>
      `${r.bankrollSol.toFixed(1).padStart(8)}  ${r.stakeSol.toFixed(5).padStart(12)}  ${r.fixedRoundTripSol.toFixed(5).padStart(11)}  ${(r.fixedPctOfStake.toFixed(2) + "%").padStart(16)}  ${(r.immediateExitPctLost.toFixed(2) + "%").padStart(33)}  ${r.breakevenPriceMultiple === null ? "n/a".padStart(24) : (r.breakevenPriceMultiple.toFixed(4) + "x").padStart(24)}`,
  );
  return [head, cols, ...lines].join("\n");
}
