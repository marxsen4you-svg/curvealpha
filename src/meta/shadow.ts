/**
 * Shadow ledger: the counterfactual outcome of every candidate.
 *
 * Every token whose Alpha Score clears a low bar (params.scoring.shadowMinScore)
 * gets a shadow position: a nominal buy filled exactly against the live curve
 * after the same latency a real order would see, then managed by the same
 * exit engine as a real position until it closes. Its realized multiple and
 * the number of sells it needed are stored.
 *
 * This is where the Survival Engine's empirical distribution comes from. It
 * avoids the selection bias of learning only from trades actually taken, it
 * accumulates data in paper mode at the full rate of the market, and it is
 * scored at the same horizons the live decisions use.
 */
import type { Params } from "../config/params.js";
import { simulateSell, simulateV3Buy } from "../math/curve.js";
import type { TokenRecord } from "../ingest/tokens.js";
import { applyExitFill, evaluateExit, openExitState, remainderMultipleE6, type CurveCtx, type ExitAction, type ExitState } from "../exits/exitEngine.js";
import { ammSellQuote, poolAtMigration } from "../exec/amm.js";
import type { FeeSchedule } from "../math/curve.js";
import type { Store } from "../store/db.js";
import type { Outcome } from "../risk/kelly.js";
import type { Clock } from "../util/clock.js";

interface Shadow {
  id: number;
  mint: string;
  score: number;
  horizon: number;
  state: ExitState;
  pending: boolean;
  path: Array<[number, number]>;
  lastPathAt: number;
  closeReason: string | null;
}

export class ShadowBook {
  private open = new Map<number, Shadow>();
  private byMint = new Map<string, Set<number>>();

  constructor(
    private store: Store,
    private params: () => Params,
    private clock: Clock,
    private ctx: () => CurveCtx & { ammSchedule: FeeSchedule },
    private token: (mint: string) => TokenRecord | undefined,
  ) {}

  watched(mint: string): boolean {
    return (this.byMint.get(mint)?.size ?? 0) > 0;
  }

  get openCount(): number {
    return this.open.size;
  }

  /** Open a shadow position; resolves once its buy has filled (or failed). */
  async openShadow(rec: TokenRecord, score: number, horizon: number, factors: unknown): Promise<void> {
    const p = this.params();
    await this.clock.sleep(p.execution.paperLatencyMs);
    const live = this.token(rec.mint);
    if (!live) return;
    const stake = BigInt(Math.round(p.scoring.shadowNominalSol * 1e9));
    const c = this.ctx();
    const buy = simulateV3Buy(c.global, c.schedule, live.curve.tokenTotalSupply, live.curve, stake);
    if (!buy) return;
    const now = this.clock.now();
    const r = this.store.run(
      "INSERT INTO shadows(mint, horizon_s, score, factors, opened_ms) VALUES (?, ?, ?, ?, ?)",
      rec.mint,
      horizon,
      score,
      JSON.stringify(factors),
      now,
    );
    const id = Number(r.lastInsertRowid);
    const sh: Shadow = {
      id,
      mint: rec.mint,
      score,
      horizon,
      state: openExitState(rec.mint, buy.netSol + buy.fees, buy.tokens, live, now, p),
      pending: false,
      path: [[0, 1]],
      lastPathAt: now,
      closeReason: null,
    };
    this.open.set(id, sh);
    let s = this.byMint.get(rec.mint);
    if (!s) this.byMint.set(rec.mint, (s = new Set()));
    s.add(id);
  }

  /** Re-evaluate every shadow on a mint (call on each trade for it). */
  onUpdate(mint: string): void {
    for (const id of this.byMint.get(mint) ?? []) {
      const sh = this.open.get(id);
      if (sh) this.step(sh);
    }
  }

  /** Time-based triggers (max hold, momentum) need a periodic pass. */
  tick(): void {
    for (const sh of this.open.values()) this.step(sh);
  }

  private step(sh: Shadow): void {
    if (sh.pending || sh.state.closed) return;
    const rec = this.token(sh.mint);
    const p = this.params();
    const now = this.clock.now();
    if (!rec) {
      // the token left the book (evicted): close at zero rather than invent a price
      this.finalize(sh, "token evicted while held", now);
      return;
    }
    const c = this.ctx();
    if (now - sh.lastPathAt >= 1000 && sh.path.length < 900 && !rec.curve.complete) {
      sh.path.push([(now - sh.state.openedAtMs) / 1000, Number(remainderMultipleE6(sh.state, c, rec.curve)) / 1e6]);
      sh.lastPathAt = now;
    }
    // fixed costs are not part of a shadow outcome; the Survival Engine adds them per decision
    const action = evaluateExit(sh.state, rec, c, p, now, 0n);
    if (!action) return;
    sh.pending = true;
    void this.fill(sh, action);
  }

  private async fill(sh: Shadow, action: ExitAction): Promise<void> {
    await this.clock.sleep(this.params().execution.paperLatencyMs);
    const rec = this.token(sh.mint);
    const c = this.ctx();
    let out = 0n;
    let sold = 0n;
    if (action.kind === "sell" && rec) {
      sold = action.tokens > sh.state.remainingTokens ? sh.state.remainingTokens : action.tokens;
      if (rec.curve.complete || action.venue === "amm") {
        const reserved = c.global.tokenTotalSupply - c.global.initialRealTokenReserves;
        out = ammSellQuote(poolAtMigration(c.global, rec.curve, reserved), sold, c.ammSchedule, rec.curve.tokenTotalSupply);
        sh.closeReason = `${action.reason} (PumpSwap estimate)`;
      } else {
        const s = simulateSell(c.global, c.schedule, rec.curve.tokenTotalSupply, rec.curve, sold);
        out = s.netSol > 0n ? s.netSol : 0n;
        sh.closeReason = action.reason;
      }
    } else {
      sh.closeReason = action.kind === "burnClose" ? action.reason : "token gone";
      sold = sh.state.remainingTokens;
    }
    applyExitFill(sh.state, action, sold, out);
    sh.pending = false;
    if (sh.state.closed) this.finalize(sh, sh.closeReason ?? "closed", this.clock.now());
  }

  private finalize(sh: Shadow, reason: string, now: number): void {
    sh.state.closed = true;
    this.open.delete(sh.id);
    this.byMint.get(sh.mint)?.delete(sh.id);
    const multiple = Number(sh.state.realizedLamports) / Number(sh.state.stakeLamports);
    const sells = Math.max(1, sh.state.sellTxCount);
    this.store.defer(() =>
      this.store.run(
        "UPDATE shadows SET closed_ms = ?, multiple = ?, sell_tx_count = ?, close_reason = ?, path = ? WHERE id = ?",
        now,
        multiple,
        sells,
        reason,
        JSON.stringify(sh.path),
        sh.id,
      ),
    );
  }
}

export interface ComparableSample {
  outcomes: Outcome[];
  band: string;
}

/**
 * Closed shadow outcomes comparable to a candidate: same horizon, score
 * within +-7.5 points, from the recent window. Widened step by step only if
 * the narrow band is too thin, and the band used is reported for the audit.
 */
export function comparableOutcomes(store: Store, score: number, horizon: number, nowMs: number, minSamples: number, lookbackDays = 14): ComparableSample {
  const since = nowMs - lookbackDays * 86_400_000;
  const q = (lo: number, hi: number, sameHorizon: boolean) =>
    store.all<{ multiple: number; sell_tx_count: number }>(
      `SELECT multiple, sell_tx_count FROM shadows WHERE closed_ms IS NOT NULL AND opened_ms >= ? AND score BETWEEN ? AND ?
       ${sameHorizon ? "AND horizon_s = ?" : ""} ORDER BY closed_ms DESC LIMIT 800`,
      ...(sameHorizon ? [since, lo, hi, horizon] : [since, lo, hi]),
    );
  const tries: Array<[number, number, boolean, string]> = [
    [score - 7.5, score + 7.5, true, `score ${score.toFixed(1)} +-7.5, horizon ${horizon}s`],
    [score - 15, score + 15, true, `score ${score.toFixed(1)} +-15, horizon ${horizon}s`],
    [score - 15, score + 15, false, `score ${score.toFixed(1)} +-15, all horizons`],
  ];
  let rows: Array<{ multiple: number; sell_tx_count: number }> = [];
  let band = tries[0]![3];
  for (const [lo, hi, same, label] of tries) {
    rows = q(lo, hi, same);
    band = label;
    if (rows.length >= minSamples) break;
  }
  return { outcomes: rows.map((r) => ({ multiple: r.multiple, sellTxCount: r.sell_tx_count })), band };
}
