/**
 * CurveAlpha engine: wires ingest, scoring, risk, execution, the shadow
 * ledger and monitoring together, with strict one-way data flow:
 *
 *   gRPC -> queue -> events -> TokenBook -> (horizon due) -> Alpha Score
 *        -> shadow ledger (every candidate)  -> Capital Survival Engine
 *        -> tip check -> executor -> positions -> exit engine -> executor
 *
 * Every decision with its full inputs goes to the decisions table.
 */
import { Connection } from "@solana/web3.js";
import type { ParamsManager } from "./config/manager.js";
import type { Params } from "./config/params.js";
import type { Settings } from "./config/settings.js";
import { parsePumpEvents, type RawTx } from "./chain/events.js";
import type { CurveState, FeeSchedule, GlobalParams } from "./math/curve.js";
import { TokenBook, type TokenRecord } from "./ingest/tokens.js";
import { BoundedQueue } from "./ingest/queue.js";
import { scoreToken, type AlphaResult } from "./score/alpha.js";
import { Corpus, CreatorHistory, FundingResolver, RecentNames, SmartMoney, XMentions } from "./score/context.js";
import { CapitalSurvivalEngine, type Decision, type SurvivalSnapshot } from "./risk/survival.js";
import { BASE_FEE_PER_SIGNATURE, DEFAULT_ATA_RENT, priorityFee } from "./risk/costs.js";
import { comparableOutcomes, ShadowBook } from "./meta/shadow.js";
import type { Executor } from "./exec/executor.js";
import { PositionManager } from "./exec/positions.js";
import { chooseTip, type TipOracle } from "./exec/tips.js";
import type { Store } from "./store/db.js";
import type { Clock } from "./util/clock.js";

export interface MarketState {
  global: GlobalParams;
  schedule: FeeSchedule;
  ammSchedule: FeeSchedule;
  ataRent: bigint;
  updatedAtMs: number;
}

/** A curve read from the chain (RPC), used to rebuild the record of a mint held across a restart. */
export interface AdoptedCurve {
  curve: CurveState;
  creator: string;
  tokenProgram: string;
  symbol: string;
  slot: number;
}

export type CurveReader = (mint: string) => Promise<AdoptedCurve | null>;

export interface EngineDeps {
  settings: Settings;
  store: Store;
  params: Pick<ParamsManager, "get">;
  clock: Clock;
  market: MarketState;
  executor: Executor;
  tips: TipOracle;
  conn: Connection | null;
  x: XMentions;
  startingEquityLamports: bigint;
}

export interface ScoreFeedItem {
  tMs: number;
  mint: string;
  symbol: string;
  horizon: number;
  score: number | null;
  vetoed: string | null;
  threshold: number;
  contributions: AlphaResult["contributions"];
  decision: string | null;
  approved: boolean;
}

export class Engine {
  readonly tokens: TokenBook;
  readonly queue: BoundedQueue<RawTx>;
  readonly corpus: Corpus;
  readonly creators: CreatorHistory;
  readonly smart: SmartMoney;
  readonly funding: FundingResolver;
  readonly names = new RecentNames();
  readonly survival: CapitalSurvivalEngine;
  readonly shadows: ShadowBook;
  readonly positions: PositionManager;
  readonly feed: ScoreFeedItem[] = [];
  readonly counters = { txs: 0, events: 0, creates: 0, trades: 0, scored: 0, vetoed: 0, candidates: 0, approved: 0, refused: 0, deadlineMisses: 0 };
  readonly scoreLatency: number[] = [];
  market: MarketState;
  private timers: NodeJS.Timeout[] = [];
  private running = false;
  private cashCache: bigint;
  private seedCounter = 1;
  private readCurve: CurveReader | null = null;

  constructor(private d: EngineDeps) {
    const p = () => d.params.get();
    this.market = d.market;
    this.cashCache = d.startingEquityLamports;
    this.smart = new SmartMoney(d.store);
    this.tokens = new TokenBook((r) => this.smart.onRealized(r));
    this.corpus = new Corpus(d.store);
    this.corpus.load(d.clock.now() - 30 * 86_400_000);
    this.creators = new CreatorHistory(d.store);
    this.funding = new FundingResolver(d.conn, d.store);
    this.queue = new BoundedQueue<RawTx>(
      p().ingest.queueCapacity,
      (pause) => this.onPressure(pause),
      (tx) => {
        for (const k of tx.accountKeys) if (this.tokens.get(k)) this.tokens.markGap(k);
      },
    );
    const now = d.clock.now();
    this.survival = new CapitalSurvivalEngine(p, Number(d.startingEquityLamports), now);
    const saved = d.store.kvGet(`survival:${d.settings.mode}`);
    if (saved) this.survival.restore(JSON.parse(saved));
    const ctx = () => ({ global: this.market.global, schedule: this.market.schedule, mintSupply: this.market.global.tokenTotalSupply, ammSchedule: this.market.ammSchedule });
    this.shadows = new ShadowBook(d.store, p, d.clock, ctx, (m) => this.tokens.get(m));
    this.positions = new PositionManager(
      d.store,
      d.executor,
      p,
      d.clock,
      ctx,
      (m) => this.tokens.get(m),
      d.tips,
      this.survival,
      (kind, mint, approved, summary, payload) => d.store.logDecision(d.clock.now(), mint, kind, approved, summary, payload),
    );
  }

  get params(): Params {
    return this.d.params.get();
  }

  /** Hook for the ingest layer to apply real flow control. */
  onPressure: (pause: boolean) => void = () => undefined;

  /** Entry point for every transaction (from gRPC, a recording, or a test). */
  ingest(tx: RawTx): void {
    const watched = tx.accountKeys.some((k) => this.shadows.watched(k) || this.positions.watched(k));
    this.queue.push(tx, watched);
  }

  /** Drain the queue synchronously (tests and replays); the live loop uses run(). */
  drain(): void {
    for (let tx = this.queue.poll(); tx; tx = this.queue.poll()) this.process(tx);
  }

  private process(tx: RawTx): void {
    this.counters.txs++;
    for (const e of parsePumpEvents(tx)) {
      this.counters.events++;
      if (e.kind === "create") {
        this.counters.creates++;
        this.tokens.onCreate(e);
        this.names.add(`${e.name} ${e.symbol}`, e.receivedAtMs);
      } else if (e.kind === "trade") {
        this.counters.trades++;
        const rec = this.tokens.onTrade(e);
        if (!rec) continue;
        if (e.isBuy && rec.trades.filter((t) => t.isBuy).length <= this.params.scoring.fundingLookupMaxWallets) {
          this.funding.request(e.user);
        }
        this.shadows.onUpdate(e.mint);
        this.positions.onUpdate(e.mint);
      } else {
        this.tokens.markComplete(e.mint, e.receivedAtMs);
        this.shadows.onUpdate(e.mint);
        this.positions.onUpdate(e.mint);
      }
    }
  }

  /** Score every token whose next horizon is due. */
  async scoreDue(): Promise<void> {
    const now = this.d.clock.now();
    const p = this.params;
    for (const rec of this.tokens.tokens.values()) {
      const age = (now - rec.createdAtMs) / 1000;
      for (const h of p.scoring.evalHorizonsSec) {
        if (age >= h && !rec.scoredHorizons.has(h)) {
          rec.scoredHorizons.add(h);
          // a horizon missed by more than 3 s (e.g. after a pause) is skipped, not scored late
          if (age - h <= 3) await this.evaluate(rec, h, now);
        }
      }
    }
  }

  private recentNamesFor(rec: TokenRecord, now: number): string[] {
    return this.names.since(now - this.params.scoring.noveltyLookbackMin * 60_000, `${rec.name} ${rec.symbol}`);
  }

  async evaluate(rec: TokenRecord, horizon: number, now: number): Promise<void> {
    const p = this.params;
    const t0 = performance.now();
    this.smart.rank(p.scoring.smartMinTrades, p.scoring.smartTopK, now);
    const ctx = {
      creatorStats: this.creators.stats(rec.creator, now),
      funders: this.funding.known,
      smartTop: this.smart.top,
      recentNames: this.recentNamesFor(rec, now),
      social: null as Awaited<ReturnType<XMentions["reading"]>>,
      corpus: this.corpus.entries,
      global: this.market.global,
    };
    let alpha = scoreToken(rec, horizon, now, ctx, p);
    const threshold = this.survival.threshold(now).threshold;
    if (this.d.x.enabled && alpha.score !== null && alpha.score >= threshold - 10) {
      const left = p.scoring.scoreDeadlineMs - (performance.now() - t0);
      if (left > 50) {
        ctx.social = await Promise.race([
          this.d.x.reading(rec.mint, p.scoring.socialWindowSec, now),
          new Promise<null>((r) => setTimeout(() => r(null), left - 30)),
        ]);
        alpha = scoreToken(rec, horizon, now, ctx, p);
      }
    }
    const elapsed = performance.now() - t0;
    this.scoreLatency.push(elapsed);
    if (this.scoreLatency.length > 2000) this.scoreLatency.shift();
    this.counters.scored++;
    if (alpha.vetoed) this.counters.vetoed++;
    const item: ScoreFeedItem = {
      tMs: now,
      mint: rec.mint,
      symbol: rec.symbol,
      horizon,
      score: alpha.score,
      vetoed: alpha.vetoed,
      threshold,
      contributions: alpha.contributions,
      decision: null,
      approved: false,
    };
    if (elapsed > p.scoring.scoreDeadlineMs) {
      this.counters.deadlineMisses++;
      item.decision = `discarded: scoring took ${elapsed.toFixed(0)} ms`;
      this.pushFeed(item);
      return;
    }
    if (alpha.score === null) {
      this.pushFeed(item);
      return;
    }
    if (alpha.score >= p.scoring.shadowMinScore) {
      const values = Object.fromEntries(Object.entries(alpha.factors).map(([k, f]) => [k, f.value]));
      void this.shadows.openShadow(rec, alpha.score, horizon, { values, contributions: alpha.contributions }).catch((e) => console.error("shadow open failed", e));
    }
    if (alpha.score >= threshold && !this.positions.holds(rec.mint)) {
      this.counters.candidates++;
      const d = await this.size(rec, alpha, now);
      item.decision = d.reasons[0] ?? null;
      item.approved = d.approved;
    }
    this.pushFeed(item);
  }

  private pushFeed(item: ScoreFeedItem): void {
    if (item.score === null && !item.decision) return;
    this.feed.unshift(item);
    if (this.feed.length > 300) this.feed.pop();
  }

  /** Survival Engine decision for one candidate, then execution. */
  private async size(rec: TokenRecord, alpha: AlphaResult, now: number): Promise<Decision> {
    const p = this.params;
    const sample = comparableOutcomes(this.d.store, alpha.score!, alpha.horizonSec, now, p.risk.minOutcomeSamples);
    const minTip = BigInt(p.execution.minTipLamports);
    const entryTip = chooseTip(this.d.tips.floor, p.execution.tipPercentile, minTip, null);
    const exitTip = chooseTip(this.d.tips.floor, p.execution.exitTipPercentile, minTip, null);
    const cuPrice = BigInt(p.execution.cuPriceMicroLamports);
    const entryFixed = BASE_FEE_PER_SIGNATURE + priorityFee(cuPrice, BigInt(p.execution.paperBuyCuLimit)) + entryTip.tipLamports;
    const exitFixed = BASE_FEE_PER_SIGNATURE + priorityFee(cuPrice, BigInt(p.execution.paperSellCuLimit)) + exitTip.tipLamports;
    const snapshot = this.survival.snapshot(now);
    const candidate = {
      mint: rec.mint,
      alphaScore: alpha.score!,
      horizonSec: alpha.horizonSec,
      outcomes: sample.outcomes,
      entryFixedLamports: Number(entryFixed),
      exitFixedLamportsPerTx: Number(exitFixed),
      entryTipLamports: Number(entryTip.tipLamports),
      ataRentLamports: Number(this.market.ataRent),
      spendableLamports: Number(this.cashCache),
      seed: (now ^ this.seedCounter++) >>> 0,
    };
    let decision: Decision = this.survival.decide(candidate, now);
    const refuseAfterApproval = (reason: string) => {
      if (decision.reservationId !== undefined) this.survival.release(decision.reservationId);
      decision = { ...decision, approved: false, reservationId: undefined, reasons: [reason] };
    };
    // without live tip data the fixed costs are unknown, so nothing is approved, in paper mode too
    if (decision.approved && (entryTip.refused || exitTip.refused)) {
      refuseAfterApproval(`tips: ${entryTip.refused ? entryTip.reason : exitTip.reason}`);
    } else if (decision.approved && this.d.tips.isStale(now)) {
      const age = this.d.tips.floor ? Math.round((now - this.d.tips.floor.atMs) / 1000) : null;
      refuseAfterApproval(`tips: tip floor is stale (${age === null ? "never fetched" : `${age} s old`}), fixed costs unknown`);
    }
    let tipCheck = null;
    if (decision.approved) {
      tipCheck = chooseTip(this.d.tips.floor, p.execution.tipPercentile, minTip, BigInt(decision.tipBudgetLamports));
      if (tipCheck.refused) refuseAfterApproval(`tip: ${tipCheck.reason}`);
    }
    const decisionId = this.d.store.logDecision(now, rec.mint, "size", decision.approved, decision.reasons[0] ?? "", {
      alpha,
      snapshot,
      candidate,
      band: sample.band,
      params: p,
      decision,
      tipCheck,
      market: { tipFloor: this.d.tips.floor, ataRent: this.market.ataRent },
    });
    if (decision.approved) {
      this.counters.approved++;
      const reservationId = decision.reservationId!;
      void this.positions
        .open({
          rec,
          stakeLamports: BigInt(decision.stakeLamports),
          tipLamports: tipCheck!.tipLamports,
          score: alpha.score!,
          horizon: alpha.horizonSec,
          decisionId,
        })
        .then((pos) => (pos ? this.survival.commit(reservationId, Number(pos.state.stakeLamports)) : this.survival.release(reservationId)))
        .catch(() => this.survival.release(reservationId));
    } else this.counters.refused++;
    return decision;
  }

  /**
   * After a restart: load every open position of this mode from the database
   * and rebuild each curve record from a chain read so its exits keep running.
   * A position whose curve cannot be read stays held and counted, unmanaged,
   * and is retried by retryAdoptions().
   */
  async restorePositions(readCurve: CurveReader): Promise<{ restored: number; unmanaged: number }> {
    this.readCurve = readCurve;
    const restored = this.positions.restore();
    await this.retryAdoptions();
    for (const pos of restored) this.positions.revalue(pos);
    const unmanaged = this.positions.unmanaged().length;
    if (restored.length > 0) {
      this.d.store.logDecision(this.d.clock.now(), null, "restore", unmanaged === 0, `restored ${restored.length} open position(s), ${unmanaged} unmanaged`, {
        positions: restored.map((p) => ({ id: p.id, mint: p.mint, remainingTokens: p.state.remainingTokens })),
      });
    }
    return { restored: restored.length, unmanaged };
  }

  /** Try again to read the curve of every held mint that has no record; returns how many were adopted. */
  async retryAdoptions(): Promise<number> {
    if (!this.readCurve) return 0;
    let adopted = 0;
    for (const mint of this.positions.unmanaged()) {
      let a: AdoptedCurve | null = null;
      try {
        a = await this.readCurve(mint);
      } catch (e) {
        console.error(`curve read for held mint ${mint} failed`, e);
      }
      if (!a) continue;
      this.tokens.adopt({ mint, ...a }, this.d.clock.now());
      adopted++;
    }
    return adopted;
  }

  /** Mark equity, persist the survival state and roll equity history. */
  async markEquity(): Promise<void> {
    const now = this.d.clock.now();
    this.positions.persistOpenStates();
    this.cashCache = await this.d.executor.spendableLamports();
    const equity = this.cashCache + this.positions.heldValue();
    this.survival.updateEquity(Number(equity), now);
    const snap = this.survival.snapshot(now);
    this.d.store.kvSet(`survival:${this.d.settings.mode}`, JSON.stringify(snap));
    this.d.store.defer(() =>
      this.d.store.run("INSERT INTO equity(ts_ms, equity_lamports, cash_lamports, mode) VALUES (?, ?, ?, ?)", now, equity, this.cashCache, this.d.settings.mode),
    );
  }

  /** Archive and drop tokens nobody holds once they are older than the TTL. */
  evict(): void {
    const now = this.d.clock.now();
    const ttl = this.params.ingest.tokenStateTtlSec * 1000;
    for (const rec of [...this.tokens.tokens.values()]) {
      if (now - rec.createdAtMs < ttl) continue;
      if (this.shadows.watched(rec.mint) || this.positions.holds(rec.mint)) continue;
      if (!rec.gap && !rec.tainted) this.corpus.archive(rec, now);
      this.tokens.evict(rec.mint);
    }
  }

  /** Remove raw history older than the retention window. */
  prune(): void {
    const cutoff = this.d.clock.now() - this.params.ingest.tradeRetentionDays * 86_400_000;
    this.d.store.run("DELETE FROM equity WHERE ts_ms < ?", cutoff - 60 * 86_400_000);
    this.d.store.run("DELETE FROM decisions WHERE ts_ms < ? AND kind = 'score'", cutoff);
  }

  survivalSnapshot(): SurvivalSnapshot {
    return this.survival.snapshot(this.d.clock.now());
  }

  /** Background loops. */
  async run(): Promise<void> {
    this.running = true;
    const every = (ms: number, f: () => unknown) => this.timers.push(setInterval(() => void Promise.resolve(f()).catch((e) => console.error(e)), ms));
    every(250, () => this.scoreDue());
    every(1000, () => {
      this.shadows.tick();
      this.positions.tick();
    });
    every(2000, () => this.markEquity());
    every(5000, () => this.smart.flush(this.d.clock.now()));
    every(30_000, () => this.evict());
    every(30_000, () => this.retryAdoptions());
    every(3_600_000, () => this.prune());
    while (this.running) {
      const tx = await this.queue.take();
      try {
        this.process(tx);
      } catch (e) {
        console.error("event processing error", e);
      }
    }
  }

  stop(): void {
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    this.d.store.flush();
  }

  /** Minimal ATA rent fallback when RPC is not reachable at startup. */
  static defaultAtaRent = DEFAULT_ATA_RENT;
}
