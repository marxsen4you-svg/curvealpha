/**
 * Position manager: opens approved trades, runs the exit engine on every
 * update, routes sells with the right tip, records every fill, and marks
 * equity to the exact liquidation value of what is held.
 */
import type { Params } from "../config/params.js";
import type { TokenRecord } from "../ingest/tokens.js";
import { simulateV3Buy, sellSolFromTokens, type FeeSchedule } from "../math/curve.js";
import { BASE_FEE_PER_SIGNATURE, priorityFee } from "../risk/costs.js";
import type { CapitalSurvivalEngine } from "../risk/survival.js";
import type { Store } from "../store/db.js";
import type { Clock } from "../util/clock.js";
import { applyExitFill, evaluateExit, liquidationValue, openExitState, type CurveCtx, type ExitAction, type ExitState } from "../exits/exitEngine.js";
import type { Executor, Fill } from "./executor.js";
import { chooseTip, type TipOracle } from "./tips.js";

export interface Position {
  id: number;
  mint: string;
  symbol: string;
  tokenProgram: string;
  state: ExitState;
  score: number;
  horizon: number;
  decisionId: number;
  fixedCostLamports: bigint;
  rentLocked: bigint;
  pending: boolean;
  failures: number;
  openedAtMs: number;
  lastValueLamports: bigint;
  closeReason: string | null;
}

export interface OpenRequest {
  rec: TokenRecord;
  stakeLamports: bigint;
  tipLamports: bigint;
  score: number;
  horizon: number;
  decisionId: number;
}

const failedFill = (error: string): Fill => ({
  ok: false,
  error,
  lamports: 0n,
  tokens: 0n,
  curveFeesLamports: 0n,
  networkLamports: 0n,
  tipLamports: 0n,
  rentLamports: 0n,
});

export class PositionManager {
  readonly positions = new Map<number, Position>();
  readonly closed: Position[] = [];
  private nextLocalId = 1;

  constructor(
    private store: Store,
    private exec: Executor,
    private params: () => Params,
    private clock: Clock,
    private ctx: () => CurveCtx & { ammSchedule: FeeSchedule },
    private token: (mint: string) => TokenRecord | undefined,
    private tips: TipOracle,
    private survival: CapitalSurvivalEngine,
    private log: (kind: string, mint: string | null, approved: boolean | null, summary: string, payload: unknown) => number,
  ) {}

  watched(mint: string): boolean {
    for (const p of this.positions.values()) if (p.mint === mint) return true;
    return false;
  }

  holds(mint: string): boolean {
    return this.watched(mint);
  }

  private exitFixedPerTx(tip: bigint): bigint {
    const e = this.params().execution;
    return BASE_FEE_PER_SIGNATURE + priorityFee(BigInt(e.cuPriceMicroLamports), BigInt(e.paperSellCuLimit)) + tip;
  }

  async open(req: OpenRequest): Promise<Position | null> {
    const p = this.params();
    const c = this.ctx();
    const quote = simulateV3Buy(c.global, c.schedule, req.rec.curve.tokenTotalSupply, req.rec.curve, req.stakeLamports);
    if (!quote) {
      this.log("execution", req.rec.mint, false, "buy quote failed (curve would cross or is complete)", { req: { ...req, rec: undefined } });
      return null;
    }
    const minTokens = (quote.tokens * BigInt(10_000 - p.execution.slippageBps)) / 10_000n;
    let fill: Fill;
    try {
      fill = await this.exec.buy({
        mint: req.rec.mint,
        tokenProgram: req.rec.tokenProgram,
        budgetLamports: req.stakeLamports,
        minTokensOut: minTokens,
        tipLamports: req.tipLamports,
      });
    } catch (e) {
      // the order's outcome is unknown (a live buy may have landed): open nothing more until someone looks
      const msg = e instanceof Error ? e.message : String(e);
      this.log("execution", req.rec.mint, false, `execution fault during buy: ${msg}`, { side: "buy", minTokens, decisionId: req.decisionId, error: msg });
      this.survival.halt(`execution fault during buy of ${req.rec.mint}: ${msg}. Check the wallet for this mint, then clear the halt.`);
      return null;
    }
    const execId = this.log("execution", req.rec.mint, fill.ok, fill.ok ? "buy filled" : `buy failed: ${fill.error}`, {
      side: "buy",
      quoteTokens: quote.tokens,
      minTokens,
      fill,
      decisionId: req.decisionId,
    });
    if (!fill.ok) return null;
    const rec = this.token(req.rec.mint) ?? req.rec;
    const now = this.clock.now();
    const state = openExitState(rec.mint, fill.lamports, fill.tokens, rec, now, p);
    const row = this.store.run(
      `INSERT INTO positions(mint, mode, status, decision_id, horizon_s, score, factors, opened_ms, stake_lamports, tokens, tokens_left, fixed_cost_lamports)
       VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rec.mint,
      this.exec.mode,
      req.decisionId,
      req.horizon,
      req.score,
      JSON.stringify({ execId }),
      now,
      fill.lamports,
      fill.tokens.toString(),
      fill.tokens.toString(),
      fill.networkLamports + fill.tipLamports,
    );
    const id = Number(row.lastInsertRowid) || this.nextLocalId++;
    this.recordFill(id, "buy", fill, "entry");
    const pos: Position = {
      id,
      mint: rec.mint,
      symbol: rec.symbol,
      tokenProgram: rec.tokenProgram,
      state,
      score: req.score,
      horizon: req.horizon,
      decisionId: req.decisionId,
      fixedCostLamports: fill.networkLamports + fill.tipLamports,
      rentLocked: fill.rentLamports,
      pending: false,
      failures: 0,
      openedAtMs: now,
      lastValueLamports: fill.lamports,
      closeReason: null,
    };
    this.positions.set(id, pos);
    this.survival.setOpenPositions(this.positions.size);
    return pos;
  }

  onUpdate(mint: string): void {
    for (const pos of this.positions.values()) if (pos.mint === mint) this.step(pos);
  }

  tick(): void {
    for (const pos of this.positions.values()) this.step(pos);
  }

  private step(pos: Position): void {
    if (pos.pending || pos.state.closed) return;
    const rec = this.token(pos.mint);
    if (!rec) return;
    const p = this.params();
    const c = this.ctx();
    pos.lastValueLamports = liquidationValue(c, rec.curve, pos.state.remainingTokens);
    const exitTip = chooseTip(this.tips.floor, p.execution.exitTipPercentile, BigInt(p.execution.minTipLamports), null);
    const action = evaluateExit(pos.state, rec, c, p, this.clock.now(), this.exitFixedPerTx(exitTip.tipLamports));
    if (!action) return;
    pos.pending = true;
    void this.exit(pos, action).finally(() => {
      pos.pending = false;
    });
  }

  private async exit(pos: Position, action: ExitAction): Promise<void> {
    const p = this.params();
    const c = this.ctx();
    const emergency = action.kind === "sell" && action.urgency === "emergency";
    const key = emergency ? (pos.failures >= 2 ? "p99" : "p95") : p.execution.exitTipPercentile;
    const tipChoice = chooseTip(this.tips.floor, key, BigInt(p.execution.minTipLamports), null);
    const rec = this.token(pos.mint);
    // never pay more than a tenth of what the sell returns to get it filled
    const value = rec ? liquidationValue(c, rec.curve, action.kind === "sell" ? action.tokens : 0n) : 0n;
    let tip = tipChoice.tipLamports;
    const cap = value / 10n;
    if (tip > cap && cap >= BigInt(p.execution.minTipLamports)) tip = cap;
    if (tip < BigInt(p.execution.minTipLamports)) tip = BigInt(p.execution.minTipLamports);

    let fill: Fill;
    let sold = 0n;
    try {
      ({ fill, sold } = await this.submitExit(pos, action, tip, emergency));
    } catch (e) {
      // treated as a failed attempt: logged below and retried on the next update, tip escalating
      fill = failedFill(`fault: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.log("exit", pos.mint, fill.ok, `${action.reason}${fill.ok ? "" : ` (failed: ${fill.error})`}`, {
      positionId: pos.id,
      action,
      tip,
      tipKey: key,
      fill,
    });
    if (!fill.ok) {
      pos.failures++;
      return;
    }
    pos.fixedCostLamports += fill.networkLamports + fill.tipLamports;
    applyExitFill(pos.state, action, sold, fill.lamports);
    this.recordFill(pos.id, action.kind === "burnClose" ? "burn" : "sell", fill, action.reason);
    if (pos.state.closed) this.close(pos, action.reason);
    else {
      this.store.defer(() =>
        this.store.run(
          "UPDATE positions SET tokens_left = ?, proceeds_lamports = ?, fixed_cost_lamports = ? WHERE id = ?",
          pos.state.remainingTokens.toString(),
          pos.state.realizedLamports,
          pos.fixedCostLamports,
          pos.id,
        ),
      );
    }
  }

  private async submitExit(pos: Position, action: ExitAction, tip: bigint, emergency: boolean): Promise<{ fill: Fill; sold: bigint }> {
    if (action.kind === "burnClose") {
      const sold = pos.state.remainingTokens;
      return { fill: await this.exec.burnClose(pos.mint, pos.tokenProgram, sold, tip), sold };
    }
    const p = this.params();
    const c = this.ctx();
    const rec = this.token(pos.mint);
    const sold = action.tokens > pos.state.remainingTokens ? pos.state.remainingTokens : action.tokens;
    const last = sold >= pos.state.remainingTokens;
    const quote = rec && !rec.curve.complete ? sellSolFromTokens(c.global, c.schedule, rec.curve.tokenTotalSupply, rec.curve, sold) : 0n;
    const minOut = quote > 0n ? (quote * BigInt(10_000 - p.execution.slippageBps)) / 10_000n : 0n;
    const fill = await this.exec.sell({
      mint: pos.mint,
      tokenProgram: pos.tokenProgram,
      tokens: sold,
      minSolOut: emergency ? 0n : minOut,
      tipLamports: tip,
      venue: action.venue,
      closeAccount: last,
    });
    return { fill, sold };
  }

  private close(pos: Position, reason: string): void {
    pos.closeReason = reason;
    this.positions.delete(pos.id);
    this.closed.unshift(pos);
    if (this.closed.length > 200) this.closed.pop();
    this.survival.setOpenPositions(this.positions.size);
    const now = this.clock.now();
    this.store.defer(() =>
      this.store.run(
        "UPDATE positions SET status = 'closed', closed_ms = ?, tokens_left = '0', proceeds_lamports = ?, fixed_cost_lamports = ?, close_reason = ? WHERE id = ?",
        now,
        pos.state.realizedLamports,
        pos.fixedCostLamports,
        reason,
        pos.id,
      ),
    );
  }

  private recordFill(positionId: number, side: string, f: Fill, reason: string): void {
    const now = this.clock.now();
    this.store.defer(() =>
      this.store.run(
        `INSERT INTO fills(position_id, ts_ms, side, lamports, tokens, fees_lamports, tip_lamports, network_lamports, signature, bundle_id, landed, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        positionId,
        now,
        side,
        f.lamports,
        f.tokens.toString(),
        f.curveFeesLamports,
        f.tipLamports,
        f.networkLamports,
        f.signature ?? null,
        f.bundleId ?? null,
        f.ok ? 1 : 0,
        reason,
      ),
    );
  }

  /** Exact liquidation value of everything held, plus rent that comes back on close. */
  heldValue(): bigint {
    let v = 0n;
    for (const pos of this.positions.values()) v += pos.lastValueLamports + pos.rentLocked;
    return v;
  }
}
