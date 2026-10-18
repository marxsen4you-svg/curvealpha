/**
 * Capital Survival Engine.
 *
 * Every trade passes through decide(). It answers one question: given this
 * bankroll, this drawdown, today's losses, the comparable historical outcomes
 * and the exact fixed costs, does staking anything beat not trading, and if
 * so how much? The default answer is no. A trade is approved only when every
 * gate below passes, in this order:
 *
 *   1. not halted (daily loss breaker, bankroll floor)
 *   2. open positions below the concurrency limit
 *   3. alpha score at or above the dynamic threshold
 *   4. enough comparable outcomes to estimate anything
 *   5. bootstrapped fractional Kelly stake (fixed costs inside the objective) > 0
 *   6. caps: per-trade risk, position size, daily risk budget, survival multiplier
 *   7. the capped stake still beats not trading (growth > 0)
 *   8. bootstrapped lower bound of EV after every cost clears minEdgePct
 *   9. the wallet can fund stake + entry costs + ATA rent
 *
 * Everything that went into the answer is returned so it can be logged and
 * replayed exactly.
 */
import type { Params } from "../config/params.js";
import { bootstrapEvLower, bootstrapKellyStake, growth, type Outcome, type SizingInputs } from "./kelly.js";

export type SurvivalMode = "NORMAL" | "CAUTION" | "SURVIVAL" | "HALTED";

export interface SurvivalSnapshot {
  mode: SurvivalMode;
  equityLamports: number;
  peakEquityLamports: number;
  dayStartEquityLamports: number;
  dayKey: string;
  drawdownPct: number;
  dayPnlPct: number;
  riskOpenedTodayLamports: number;
  haltedUntilMs: number | null;
  haltReason: string | null;
  openPositions: number;
  /** Approved orders not yet filled or failed (transient; never restored after a restart). */
  pendingPositions?: number;
  pendingRiskLamports?: number;
  pendingCashLamports?: number;
}

export interface Candidate {
  mint: string;
  alphaScore: number;
  horizonSec: number;
  outcomes: Outcome[];
  entryFixedLamports: number;
  exitFixedLamportsPerTx: number;
  /** The entry tip already assumed inside entryFixedLamports. */
  entryTipLamports: number;
  ataRentLamports: number;
  /** Lamports the wallet can spend right now (paper: ledger cash). */
  spendableLamports: number;
  /** Seed for the bootstrap so the decision can be replayed exactly. */
  seed: number;
}

export interface SizingTrace {
  thresholdBase: number;
  thresholdSurvivalAdd: number;
  thresholdDrawdownAdd: number;
  thresholdBankrollAdd: number;
  threshold: number;
  sampleSize: number;
  kellyStakeQ: number | null;
  kellyStakeMedian: number | null;
  fractionalKellyStake: number | null;
  riskCapStake: number;
  positionCapStake: number;
  dailyBudgetStake: number;
  survivalMultiplier: number;
  cappedStake: number | null;
  growthAtStake: number | null;
  evLowerLamports: number | null;
  minEdgeLamports: number | null;
}

export interface Decision {
  approved: boolean;
  /** Set on approval: the reservation holding this order's slot, risk and cash until commit() or release(). */
  reservationId?: number;
  stakeLamports: number;
  /** Max tip the execution layer may pay: ceiling fraction of the residual edge. */
  tipBudgetLamports: number;
  reasons: string[];
  mode: SurvivalMode;
  trace: SizingTrace;
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export class CapitalSurvivalEngine {
  private equity: number;
  private peak: number;
  private dayStart: number;
  private dayKey: string;
  private riskOpenedToday = 0;
  private haltedUntil: number | null = null;
  private haltReason: string | null = null;
  private openPositions = 0;
  /** Approved orders in flight: each holds a concurrency slot, its risk and its cash. */
  private reservations = new Map<number, { riskLamports: number; cashLamports: number }>();
  private nextReservation = 1;
  /** Pending totals carried by a replayed snapshot (a replay has no live reservations). */
  private replayPending = { positions: 0, risk: 0, cash: 0 };

  constructor(
    private params: () => Params,
    startingEquityLamports: number,
    nowMs: number,
  ) {
    this.equity = startingEquityLamports;
    this.peak = startingEquityLamports;
    this.dayStart = startingEquityLamports;
    this.dayKey = utcDay(nowMs);
  }

  /** Restore persisted state after a restart, so a restart never resets a breaker. */
  restore(s: Omit<SurvivalSnapshot, "mode" | "drawdownPct" | "dayPnlPct">): void {
    this.equity = s.equityLamports;
    this.peak = s.peakEquityLamports;
    this.dayStart = s.dayStartEquityLamports;
    this.dayKey = s.dayKey;
    this.riskOpenedToday = s.riskOpenedTodayLamports;
    this.haltedUntil = s.haltedUntilMs;
    this.haltReason = s.haltReason;
    this.openPositions = s.openPositions;
  }

  /** Mark-to-market equity (cash plus open positions at exact exit value). */
  updateEquity(equityLamports: number, nowMs: number): void {
    const day = utcDay(nowMs);
    if (day !== this.dayKey) {
      this.dayKey = day;
      this.dayStart = equityLamports;
      this.riskOpenedToday = 0;
    }
    this.equity = equityLamports;
    if (equityLamports > this.peak) this.peak = equityLamports;
    this.checkBreakers(nowMs);
  }

  setOpenPositions(n: number): void {
    this.openPositions = n;
  }

  /** Called when a position is actually opened, to consume the daily risk budget. */
  recordOpen(stakeLamports: number): void {
    this.riskOpenedToday += stakeLamports * this.params().risk.lossGivenAdverse;
  }

  private pending(): { positions: number; risk: number; cash: number } {
    let risk = this.replayPending.risk;
    let cash = this.replayPending.cash;
    for (const r of this.reservations.values()) {
      risk += r.riskLamports;
      cash += r.cashLamports;
    }
    return { positions: this.reservations.size + this.replayPending.positions, risk, cash };
  }

  /** The order filled: its risk is now spent for the day. The caller updates the open count. */
  commit(reservationId: number, filledStakeLamports: number): void {
    if (!this.reservations.delete(reservationId)) return;
    this.recordOpen(filledStakeLamports);
  }

  /** The order failed or was refused after approval: give back its slot, risk and cash. */
  release(reservationId: number): void {
    this.reservations.delete(reservationId);
  }

  /** Stop new entries until an operator clears it (an engine fault, an unresolved order). Exits continue. */
  halt(reason: string, untilMs = Number.MAX_SAFE_INTEGER): void {
    this.haltedUntil = untilMs;
    this.haltReason = reason;
  }

  /** Operator action: clear a halt (the reason and time stay in the audit log). */
  clearHalt(): void {
    this.haltedUntil = null;
    this.haltReason = null;
  }

  private checkBreakers(nowMs: number): void {
    const p = this.params().risk;
    if (this.haltedUntil !== null && nowMs >= this.haltedUntil && this.equity >= p.bankrollFloorSol * 1e9) {
      this.haltedUntil = null;
      this.haltReason = null;
    }
    if (this.haltedUntil !== null) return;
    const dayPnl = this.dayStart > 0 ? (this.equity - this.dayStart) / this.dayStart : 0;
    if (dayPnl <= -p.dailyLossLimitPct) {
      this.haltedUntil = nowMs + p.haltHours * 3_600_000;
      this.haltReason = `daily loss ${(dayPnl * 100).toFixed(2)}% hit the ${(p.dailyLossLimitPct * 100).toFixed(1)}% limit`;
    } else if (this.equity < p.bankrollFloorSol * 1e9) {
      this.haltedUntil = Number.MAX_SAFE_INTEGER;
      this.haltReason = `equity below the ${p.bankrollFloorSol} SOL floor; clear manually after review`;
    }
  }

  snapshot(nowMs: number): SurvivalSnapshot {
    this.checkBreakers(nowMs);
    return {
      mode: this.mode(nowMs),
      equityLamports: this.equity,
      peakEquityLamports: this.peak,
      dayStartEquityLamports: this.dayStart,
      dayKey: this.dayKey,
      drawdownPct: this.drawdown(),
      dayPnlPct: this.dayStart > 0 ? (this.equity - this.dayStart) / this.dayStart : 0,
      riskOpenedTodayLamports: this.riskOpenedToday,
      haltedUntilMs: this.haltedUntil,
      haltReason: this.haltReason,
      openPositions: this.openPositions,
      pendingPositions: this.pending().positions,
      pendingRiskLamports: this.pending().risk,
      pendingCashLamports: this.pending().cash,
    };
  }

  drawdown(): number {
    return this.peak > 0 ? Math.max(0, 1 - this.equity / this.peak) : 0;
  }

  mode(nowMs: number): SurvivalMode {
    if (this.haltedUntil !== null && nowMs < this.haltedUntil) return "HALTED";
    const p = this.params().risk;
    const dd = this.drawdown();
    if (dd >= p.survivalDrawdownPct) return "SURVIVAL";
    if (dd >= p.cautionDrawdownPct) return "CAUTION";
    return "NORMAL";
  }

  /** The alpha threshold in force right now, with its parts. */
  threshold(nowMs: number): Pick<SizingTrace, "thresholdBase" | "thresholdSurvivalAdd" | "thresholdDrawdownAdd" | "thresholdBankrollAdd" | "threshold"> {
    const p = this.params();
    const mode = this.mode(nowMs);
    const base = p.scoring.baseAlphaThreshold;
    const survivalAdd = mode === "SURVIVAL" ? p.risk.survivalThresholdAdd : mode === "CAUTION" ? p.risk.cautionThresholdAdd : 0;
    const ddAdd = p.risk.drawdownThresholdSlope * this.drawdown();
    const bankAdd = this.equity < p.scoring.smallBankrollSol * 1e9 ? p.scoring.smallBankrollThresholdAdd : 0;
    return {
      thresholdBase: base,
      thresholdSurvivalAdd: survivalAdd,
      thresholdDrawdownAdd: ddAdd,
      thresholdBankrollAdd: bankAdd,
      threshold: Math.min(100, base + survivalAdd + ddAdd + bankAdd),
    };
  }

  decide(c: Candidate, nowMs: number): Decision {
    this.checkBreakers(nowMs);
    const p = this.params();
    const mode = this.mode(nowMs);
    const th = this.threshold(nowMs);
    const survivalMultiplier = mode === "SURVIVAL" ? p.risk.survivalSizeMult : mode === "CAUTION" ? p.risk.cautionSizeMult : 1;
    const riskCapStake = (p.risk.maxRiskPerTradePct * this.equity) / p.risk.lossGivenAdverse;
    const positionCapStake = p.risk.maxPositionPct * this.equity;
    const pend = this.pending();
    const dailyBudgetStake =
      Math.max(0, p.risk.dailyRiskBudgetPct * this.dayStart - this.riskOpenedToday - pend.risk) / p.risk.lossGivenAdverse;
    const trace: SizingTrace = {
      ...th,
      sampleSize: c.outcomes.length,
      kellyStakeQ: null,
      kellyStakeMedian: null,
      fractionalKellyStake: null,
      riskCapStake,
      positionCapStake,
      dailyBudgetStake,
      survivalMultiplier,
      cappedStake: null,
      growthAtStake: null,
      evLowerLamports: null,
      minEdgeLamports: null,
    };
    const refuse = (reason: string): Decision => ({
      approved: false,
      stakeLamports: 0,
      tipBudgetLamports: 0,
      reasons: [reason],
      mode,
      trace,
    });

    if (mode === "HALTED") return refuse(`halted: ${this.haltReason}`);
    if (this.openPositions + pend.positions >= p.risk.maxConcurrentPositions) {
      return refuse(`concurrency: ${this.openPositions} open + ${pend.positions} pending, limit ${p.risk.maxConcurrentPositions}`);
    }
    if (c.alphaScore < th.threshold) {
      return refuse(`alpha ${c.alphaScore.toFixed(1)} below threshold ${th.threshold.toFixed(1)}`);
    }
    if (c.outcomes.length < p.risk.minOutcomeSamples) {
      return refuse(`evidence: ${c.outcomes.length} comparable outcomes, need ${p.risk.minOutcomeSamples}`);
    }

    const caps = Math.min(riskCapStake, positionCapStake, dailyBudgetStake) * survivalMultiplier;
    const inp: SizingInputs = {
      outcomes: c.outcomes,
      bankrollLamports: this.equity,
      entryFixedLamports: c.entryFixedLamports,
      exitFixedLamportsPerTx: c.exitFixedLamportsPerTx,
      // search Kelly over a wider range than the caps so the trace shows what the data alone says
      maxStakeLamports: Math.max(caps, 0.25 * this.equity),
      multipleCap: p.risk.outcomeMultipleCap,
    };
    const boot = bootstrapKellyStake(inp, p.risk.kellyBootstrapSamples, p.risk.kellyBootstrapQuantile, c.seed);
    trace.kellyStakeQ = boot.stake;
    trace.kellyStakeMedian = boot.medianStake;
    if (boot.stake <= 0) {
      return refuse("kelly: no stake beats not trading on the conservative bootstrap quantile");
    }
    const fractional = boot.stake * p.risk.kellyFraction;
    trace.fractionalKellyStake = fractional;
    const stake = Math.floor(Math.min(fractional, caps));
    trace.cappedStake = stake;
    if (stake <= 0) return refuse("caps: risk, position or daily budget leaves no stake");

    const g = growth(inp, stake);
    trace.growthAtStake = g;
    if (!(g > 0)) {
      return refuse(`growth: at the capped stake of ${stake} lamports, fixed costs make the log growth negative`);
    }
    const evLower = bootstrapEvLower(inp, stake, p.risk.kellyBootstrapSamples, p.risk.evBootstrapQuantile, c.seed);
    const minEdge = p.risk.minEdgePct * stake;
    trace.evLowerLamports = evLower;
    trace.minEdgeLamports = minEdge;
    if (!(evLower > minEdge)) {
      return refuse(
        `ev: lower bound ${(evLower / 1e9).toFixed(5)} SOL does not clear the required edge ${(minEdge / 1e9).toFixed(5)} SOL`,
      );
    }
    const required = stake + c.entryFixedLamports + c.ataRentLamports;
    const spendable = c.spendableLamports - pend.cash;
    if (required > spendable) {
      return refuse(`funds: need ${(required / 1e9).toFixed(4)} SOL, have ${(spendable / 1e9).toFixed(4)}${pend.cash > 0 ? " after pending orders" : ""}`);
    }
    // residual edge after every fee except the entry tip; the tip may take at most the ceiling share of it
    const residualEdge = evLower + c.entryTipLamports;
    const tipBudget = Math.max(0, Math.floor(p.execution.tipCeilingFracOfEdge * residualEdge));
    const reservationId = this.nextReservation++;
    this.reservations.set(reservationId, { riskLamports: stake * p.risk.lossGivenAdverse, cashLamports: required });
    return {
      approved: true,
      reservationId,
      stakeLamports: stake,
      tipBudgetLamports: tipBudget,
      reasons: ["approved"],
      mode,
      trace,
    };
  }

  /** Re-derive a decision from the logged inputs (decision audit replay). */
  static replay(params: Params, snapshot: SurvivalSnapshot, candidate: Candidate, nowMs: number): Decision {
    const e = new CapitalSurvivalEngine(() => params, snapshot.equityLamports, nowMs);
    e.restore(snapshot);
    e.replayPending = { positions: snapshot.pendingPositions ?? 0, risk: snapshot.pendingRiskLamports ?? 0, cash: snapshot.pendingCashLamports ?? 0 };
    return e.decide(candidate, nowMs);
  }
}
