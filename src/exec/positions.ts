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
import { bigintReplacer, bigintReviver, type Store } from "../store/db.js";
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
  /** Orders and exits in flight, so a shutdown can wait for their outcome. */
  private inflight = new Set<Promise<unknown>>();

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

  private track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    p.finally(() => this.inflight.delete(p)).catch(() => undefined);
    return p;
  }

  /** Wait for every order and exit in flight, up to timeoutMs; true if all settled. */
  async settle(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.inflight.size > 0) {
      const left = deadline - Date.now();
      if (left <= 0) return false;
      let timer: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        Promise.allSettled([...this.inflight]).then(() => false),
        new Promise<boolean>((r) => (timer = setTimeout(() => r(true), left))),
      ]);
      clearTimeout(timer);
      if (timedOut) return false;
    }
    return true;
  }

  open(req: OpenRequest): Promise<Position | null> {
    return this.track(this.openNow(req));
  }

  private async openNow(req: OpenRequest): Promise<Position | null> {
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
      `INSERT INTO positions(mint, mode, status, decision_id, horizon_s, score, factors, opened_ms, stake_lamports, tokens, tokens_left, fixed_cost_lamports,
         exit_state, rent_locked, token_program, symbol)
       VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      JSON.stringify(state, bigintReplacer),
      fill.rentLamports,
      rec.tokenProgram,
      rec.symbol,
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
    void this.track(this.exit(pos, action)).finally(() => {
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
    else this.persist(pos);
  }

  /** Write a position's state now (fills are rare; a crash must not lose one). */
  private persist(pos: Position): void {
    this.store.run(
      "UPDATE positions SET tokens_left = ?, proceeds_lamports = ?, fixed_cost_lamports = ?, exit_state = ? WHERE id = ?",
      pos.state.remainingTokens.toString(),
      pos.state.realizedLamports,
      pos.fixedCostLamports,
      JSON.stringify(pos.state, bigintReplacer),
      pos.id,
    );
  }

  /** Persist the slow-moving trailing state (peaks) of every open position; called periodically. */
  persistOpenStates(): void {
    const open = [...this.positions.values()];
    this.store.defer(() => {
      for (const pos of open) if (!pos.state.closed) this.store.run("UPDATE positions SET exit_state = ? WHERE id = ?", JSON.stringify(pos.state, bigintReplacer), pos.id);
    });
  }

  /**
   * Load every open position of this mode from the database (after a
   * restart). Positions from before the exit state was persisted are rebuilt
   * from their row with fresh trailing state.
   */
  restore(): Position[] {
    const p = this.params();
    const rows = this.store.all<{
      id: number; mint: string; symbol: string | null; token_program: string | null; decision_id: number | null; horizon_s: number | null; score: number | null;
      opened_ms: number; stake_lamports: number; tokens: string; tokens_left: string; proceeds_lamports: number; fixed_cost_lamports: number; exit_state: string | null; rent_locked: number;
    }>("SELECT * FROM positions WHERE status = 'open' AND mode = ? ORDER BY id", this.exec.mode);
    const out: Position[] = [];
    for (const r of rows) {
      const state: ExitState = r.exit_state
        ? JSON.parse(r.exit_state, bigintReviver)
        : {
            mint: r.mint,
            stakeLamports: BigInt(r.stake_lamports),
            initialTokens: BigInt(r.tokens),
            remainingTokens: BigInt(r.tokens_left),
            openedAtMs: r.opened_ms,
            tpDone: p.exits.tpLevels.map(() => false),
            peakMultipleE6: 0n,
            peakInflowRate: 0,
            creatorHeldAtEntry: 0n,
            creatorSoldAtEntry: 0n,
            realizedLamports: BigInt(r.proceeds_lamports),
            sellTxCount: 0,
            closed: false,
          };
      // creator sells are counted again from zero by the record rebuilt after the restart
      state.creatorSoldAtEntry = 0n;
      const pos: Position = {
        id: r.id,
        mint: r.mint,
        symbol: r.symbol ?? "",
        tokenProgram: r.token_program ?? "",
        state,
        score: r.score ?? 0,
        horizon: r.horizon_s ?? 0,
        decisionId: r.decision_id ?? 0,
        fixedCostLamports: BigInt(r.fixed_cost_lamports),
        rentLocked: BigInt(r.rent_locked),
        pending: false,
        failures: 0,
        openedAtMs: r.opened_ms,
        lastValueLamports: 0n,
        closeReason: null,
      };
      this.positions.set(pos.id, pos);
      out.push(pos);
    }
    this.survival.setOpenPositions(this.positions.size);
    return out;
  }

  /**
   * Align a position with what the wallet actually holds (after a restart, a
   * sell or burn may have landed without being recorded). None held closes it.
   */
  reconcileHolding(pos: Position, actual: bigint): void {
    if (actual === 0n) {
      pos.state.remainingTokens = 0n;
      pos.state.closed = true;
      this.close(pos, "reconciled: the wallet holds none of this mint (an unrecorded sell or burn)");
      return;
    }
    pos.state.remainingTokens = actual;
    this.persist(pos);
  }

  /** Mints of open positions with no curve record: held, counted, but not yet managed. */
  unmanaged(): string[] {
    return [...this.positions.values()].filter((p) => !this.token(p.mint)).map((p) => p.mint);
  }

  /** Mark a position to its exact liquidation value now. */
  revalue(pos: Position): void {
    const rec = this.token(pos.mint);
    if (rec) pos.lastValueLamports = liquidationValue(this.ctx(), rec.curve, pos.state.remainingTokens);
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
    this.store.run(
      "UPDATE positions SET status = 'closed', closed_ms = ?, tokens_left = '0', proceeds_lamports = ?, fixed_cost_lamports = ?, close_reason = ?, exit_state = ? WHERE id = ?",
      now,
      pos.state.realizedLamports,
      pos.fixedCostLamports,
      reason,
      JSON.stringify(pos.state, bigintReplacer),
      pos.id,
    );
  }

  private recordFill(positionId: number, side: string, f: Fill, reason: string): void {
    this.store.run(
      `INSERT INTO fills(position_id, ts_ms, side, lamports, tokens, fees_lamports, tip_lamports, network_lamports, signature, bundle_id, landed, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      positionId,
      this.clock.now(),
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
    );
  }

  /** Exact liquidation value of everything held, plus rent that comes back on close. */
  heldValue(): bigint {
    let v = 0n;
    for (const pos of this.positions.values()) v += pos.lastValueLamports + pos.rentLocked;
    return v;
  }
}
