/**
 * Hot-reloadable hyperparameters.
 *
 * Everything an operator might tune lives here, validated by one schema.
 * The file data/params.json is watched; a valid edit takes effect on the next
 * decision and is written to the parameter audit trail with the full diff; an
 * invalid edit is rejected and the previous parameters stay in force.
 * Infrastructure settings (endpoints, key path) are not hot-reloadable and
 * live in src/config/settings.ts.
 */
import { z } from "zod";

const pct = z.number().min(0).max(1);
const pos = z.number().positive();
const int = z.number().int().nonnegative();

export const ParamsSchema = z
  .object({
    risk: z.object({
      /** Max loss a single trade may cause, as a fraction of bankroll. */
      maxRiskPerTradePct: z.number().min(0.001).max(0.015),
      /** Fraction of the stake assumed lost in the adverse case (1 = a rug can take everything). */
      lossGivenAdverse: z.number().min(0.1).max(1),
      /** Hard cap on stake as a fraction of bankroll, whatever the risk math says. */
      maxPositionPct: pct,
      maxConcurrentPositions: int.max(10),
      /** Realized plus unrealized loss since the UTC day start that trips the breaker. */
      dailyLossLimitPct: z.number().min(0.05).max(0.15),
      haltHours: pos,
      /** Sum of risk opened per UTC day, as a fraction of day-start equity. */
      dailyRiskBudgetPct: pct,
      kellyFraction: z.number().min(0.05).max(0.5),
      kellyBootstrapSamples: int.min(50).max(5000),
      /** Quantile of the bootstrapped Kelly stake that is used (lower = more conservative). */
      kellyBootstrapQuantile: z.number().min(0.05).max(0.5),
      /** Quantile of the bootstrapped mean P&L the EV gate must clear. */
      evBootstrapQuantile: z.number().min(0.05).max(0.5),
      /** EV lower bound, net of every cost, must exceed this fraction of the stake. */
      minEdgePct: z.number().min(0).max(1),
      /** No trade until the comparable outcome sample has at least this many members. */
      minOutcomeSamples: int.min(20),
      /** Outcome multiples are winsorized at this cap before any estimate (understates the tail on purpose). */
      outcomeMultipleCap: z.number().min(2).max(1000),
      cautionDrawdownPct: pct,
      survivalDrawdownPct: pct,
      cautionSizeMult: pct,
      survivalSizeMult: pct,
      cautionThresholdAdd: z.number().min(0).max(50),
      survivalThresholdAdd: z.number().min(0).max(50),
      /** Extra alpha threshold points per unit of drawdown from peak. */
      drawdownThresholdSlope: z.number().min(0).max(200),
      /** Halt all trading when equity falls below this many SOL. */
      bankrollFloorSol: z.number().min(0),
    }),
    scoring: z.object({
      baseAlphaThreshold: z.number().min(0).max(100),
      smallBankrollSol: pos,
      smallBankrollThresholdAdd: z.number().min(0).max(50),
      weights: z.object({
        creator: z.number().min(0),
        microstructure: z.number().min(0),
        holders: z.number().min(0),
        velocity: z.number().min(0),
        smartMoney: z.number().min(0),
        social: z.number().min(0),
        trajectory: z.number().min(0),
      }),
      /** Seconds after creation at which a token is scored. */
      evalHorizonsSec: z.array(pos).min(1),
      microFirstBuys: int.min(5),
      fundingLookupMaxWallets: int,
      fundingLookupBudgetMs: int,
      velocityWindowSec: pos,
      trajectoryK: int.min(3),
      trajectoryMinCorpus: int,
      trajectoryWinMultiple: z.number().min(1),
      smartMinTrades: int.min(1),
      smartTopK: int.min(1),
      creatorMinLaunches: int.min(1),
      noveltyLookbackMin: pos,
      socialWindowSec: pos,
      /** Every token scoring at or above this gets a shadow position (counterfactual outcome). */
      shadowMinScore: z.number().min(0).max(100),
      shadowNominalSol: pos,
      /** Hard ceiling on scoring latency; a slower score is discarded, never traded. */
      scoreDeadlineMs: int.min(50),
    }),
    exits: z.object({
      tpLevels: z.array(z.number().gt(1)).min(1),
      tpFractions: z.array(pct).min(1),
      stopLossPct: z.number().min(0.05).max(0.95),
      maxHoldSec: pos,
      momentumWindowSec: pos,
      /** Exit when inflow over the window falls below this fraction of its peak. */
      momentumDecayRatio: pct,
      momentumMinHoldSec: int,
      /** Exit everything when the creator sells at least this fraction of their tokens. */
      devSellExitFraction: pct,
      /** After the first take profit, exit the rest if price falls this far from its peak. */
      trailingFromPeakPct: pct,
      migrationAction: z.enum(["exit", "hold"]),
    }),
    execution: z.object({
      slippageBps: int.max(5000),
      cuMarginPct: z.number().min(0.05).max(0.5),
      cuPriceMicroLamports: int,
      tipPercentile: z.enum(["p25", "p50", "p75", "p95", "p99", "ema50"]),
      exitTipPercentile: z.enum(["p25", "p50", "p75", "p95", "p99", "ema50"]),
      tipCeilingFracOfEdge: z.number().min(0.5).max(0.7),
      minTipLamports: int.min(1000),
      paperLatencyMs: int,
      /** Compute limits charged to paper trades (live trades measure by simulation). */
      paperBuyCuLimit: int.max(1_400_000),
      paperSellCuLimit: int.max(1_400_000),
      bundleTimeoutMs: int.min(1000),
      maxBuyRetries: int.max(3),
      useBam: z.boolean(),
    }),
    ingest: z.object({
      queueCapacity: int.min(1000),
      reconnectBaseMs: int.min(50),
      reconnectMaxMs: int.min(1000),
      fromSlotRewind: int.max(500),
      pingIntervalSec: pos,
      tokenStateTtlSec: pos,
      tradeRetentionDays: pos,
    }),
  })
  .superRefine((p, ctx) => {
    if (p.exits.tpLevels.length !== p.exits.tpFractions.length) {
      ctx.addIssue({ code: "custom", message: "exits.tpLevels and exits.tpFractions must have the same length" });
    }
    const sum = p.exits.tpFractions.reduce((a, b) => a + b, 0);
    if (sum > 1 + 1e-9) ctx.addIssue({ code: "custom", message: "exits.tpFractions must sum to at most 1" });
    for (let i = 1; i < p.exits.tpLevels.length; i++) {
      if (p.exits.tpLevels[i]! <= p.exits.tpLevels[i - 1]!) {
        ctx.addIssue({ code: "custom", message: "exits.tpLevels must be strictly increasing" });
      }
    }
    if (p.risk.survivalDrawdownPct <= p.risk.cautionDrawdownPct) {
      ctx.addIssue({ code: "custom", message: "risk.survivalDrawdownPct must exceed risk.cautionDrawdownPct" });
    }
    const w = p.scoring.weights;
    if (w.creator + w.microstructure + w.holders + w.velocity + w.smartMoney + w.social + w.trajectory <= 0) {
      ctx.addIssue({ code: "custom", message: "at least one scoring weight must be positive" });
    }
  });

export type Params = z.infer<typeof ParamsSchema>;

/** Defaults tuned for 0.5 to 5 SOL bankrolls; README explains each choice. */
export const DEFAULT_PARAMS: Params = {
  risk: {
    maxRiskPerTradePct: 0.0125,
    lossGivenAdverse: 1,
    maxPositionPct: 0.05,
    maxConcurrentPositions: 2,
    dailyLossLimitPct: 0.12,
    haltHours: 24,
    dailyRiskBudgetPct: 0.05,
    kellyFraction: 0.5,
    kellyBootstrapSamples: 400,
    kellyBootstrapQuantile: 0.25,
    evBootstrapQuantile: 0.2,
    minEdgePct: 0.03,
    minOutcomeSamples: 60,
    outcomeMultipleCap: 50,
    cautionDrawdownPct: 0.1,
    survivalDrawdownPct: 0.2,
    cautionSizeMult: 0.6,
    survivalSizeMult: 0.35,
    cautionThresholdAdd: 5,
    survivalThresholdAdd: 12,
    drawdownThresholdSlope: 40,
    bankrollFloorSol: 0.25,
  },
  scoring: {
    baseAlphaThreshold: 70,
    smallBankrollSol: 1.5,
    smallBankrollThresholdAdd: 8,
    weights: {
      creator: 0.18,
      microstructure: 0.2,
      holders: 0.14,
      velocity: 0.16,
      smartMoney: 0.12,
      social: 0.06,
      trajectory: 0.14,
    },
    evalHorizonsSec: [15, 30, 60, 90],
    microFirstBuys: 30,
    fundingLookupMaxWallets: 10,
    fundingLookupBudgetMs: 250,
    velocityWindowSec: 15,
    trajectoryK: 25,
    trajectoryMinCorpus: 200,
    trajectoryWinMultiple: 2,
    smartMinTrades: 8,
    smartTopK: 300,
    creatorMinLaunches: 2,
    noveltyLookbackMin: 60,
    socialWindowSec: 90,
    shadowMinScore: 40,
    shadowNominalSol: 0.05,
    scoreDeadlineMs: 350,
  },
  exits: {
    tpLevels: [1.6, 2.5, 4, 8],
    tpFractions: [0.3, 0.3, 0.2, 0.1],
    stopLossPct: 0.35,
    maxHoldSec: 900,
    momentumWindowSec: 20,
    momentumDecayRatio: 0.25,
    momentumMinHoldSec: 30,
    devSellExitFraction: 0.1,
    trailingFromPeakPct: 0.4,
    migrationAction: "exit",
  },
  execution: {
    slippageBps: 300,
    cuMarginPct: 0.12,
    cuPriceMicroLamports: 1000,
    tipPercentile: "ema50",
    exitTipPercentile: "p75",
    tipCeilingFracOfEdge: 0.6,
    minTipLamports: 1000,
    paperLatencyMs: 400,
    paperBuyCuLimit: 160_000,
    paperSellCuLimit: 130_000,
    bundleTimeoutMs: 8000,
    maxBuyRetries: 1,
    useBam: false,
  },
  ingest: {
    queueCapacity: 50_000,
    reconnectBaseMs: 250,
    reconnectMaxMs: 15_000,
    fromSlotRewind: 32,
    pingIntervalSec: 15,
    tokenStateTtlSec: 1800,
    tradeRetentionDays: 7,
  },
};

/** Number of individual leaf hyperparameters (arrays count once). */
export function countParams(p: unknown = DEFAULT_PARAMS): number {
  if (p && typeof p === "object" && !Array.isArray(p)) {
    return Object.values(p).reduce<number>((n, v) => n + countParams(v), 0);
  }
  return 1;
}

/** Leaf-level differences between two parameter sets, for the audit trail. */
export function diffParams(a: unknown, b: unknown, path = ""): Array<{ path: string; from: unknown; to: unknown }> {
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap((k) =>
      diffParams((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k),
    );
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [{ path, from: a, to: b }];
}

/** Deep merge of a partial override onto defaults, then full validation. */
export function resolveParams(override: unknown): Params {
  const merged = deepMerge(DEFAULT_PARAMS, override ?? {});
  return ParamsSchema.parse(merged);
}

function deepMerge(base: unknown, over: unknown): unknown {
  if (over === undefined) return base;
  if (base && over && typeof base === "object" && typeof over === "object" && !Array.isArray(base) && !Array.isArray(over)) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [k, v] of Object.entries(over as Record<string, unknown>)) out[k] = deepMerge(out[k], v);
    return out;
  }
  return over;
}
