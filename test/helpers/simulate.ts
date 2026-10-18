/**
 * Runs the real engine (parsing, token book, scoring, shadow ledger, Capital
 * Survival Engine, paper executor, exits, persistence) over the synthetic
 * market on a manual clock. Optional per-stage timing for profiling.
 *
 * Sim can also be stepped (runUntil) and restarted on the same database
 * with a fresh engine (restart), which is how crash recovery is tested.
 */
import { Engine, type MarketState } from "../../src/engine.js";
import { Store } from "../../src/store/db.js";
import { resolveParams, type Params } from "../../src/config/params.js";
import { loadSettings } from "../../src/config/settings.js";
import { PaperExecutor, type Executor } from "../../src/exec/executor.js";
import { TipOracle } from "../../src/exec/tips.js";
import { XMentions } from "../../src/score/context.js";
import { ManualClock } from "../../src/util/clock.js";
import { MAINNET_GLOBAL, curveSchedule, fixtureSchedule } from "./gen.js";
import { SyntheticMarket } from "./market.js";

export const T0 = Date.UTC(2026, 9, 17, 0, 0, 0);

export interface SimOptions {
  /** The tip floor endpoint stops answering this long after T0 (a Jito API outage). */
  tipsDownAfterMs?: number;
  /** Use this store instead of a fresh in-memory one. */
  store?: Store;
  /** Replace or wrap the paper executor (fault injection). */
  wrapExecutor?: (paper: PaperExecutor) => Executor;
}

const START = 3_000_000_000n;
const DT = 250;

export class Sim {
  readonly clock = new ManualClock(T0);
  readonly params: Params = resolveParams({
    risk: { minOutcomeSamples: 40, minEdgePct: 0.01 },
    scoring: { baseAlphaThreshold: 55, smallBankrollThresholdAdd: 0, trajectoryMinCorpus: 60, shadowMinScore: 30 },
    ingest: { tokenStateTtlSec: 600 },
    exits: { maxHoldSec: 300 },
  });
  readonly market: MarketState = { global: MAINNET_GLOBAL, schedule: curveSchedule(), ammSchedule: fixtureSchedule(), ataRent: 2_074_080n, updatedAtMs: T0 };
  readonly sim = new SyntheticMarket(MAINNET_GLOBAL, curveSchedule(), 7);
  readonly tips: TipOracle;
  readonly start = START;
  store!: Store;
  engine!: Engine;
  paper!: PaperExecutor;
  private t = T0;
  private prof?: Record<string, number>;

  constructor(private opts: SimOptions = {}, prof?: Record<string, number>) {
    this.prof = prof;
    this.tips = new TipOracle("http://tips.invalid", (async () => {
      if (opts.tipsDownAfterMs !== undefined && this.clock.now() > T0 + opts.tipsDownAfterMs) throw new Error("tip floor endpoint down");
      return new Response(
        JSON.stringify([
          {
            time: "now",
            landed_tips_25th_percentile: 0.000005,
            landed_tips_50th_percentile: 0.00001,
            landed_tips_75th_percentile: 0.00003,
            landed_tips_95th_percentile: 0.0001,
            landed_tips_99th_percentile: 0.0005,
            ema_landed_tips_50th_percentile: 0.00001,
          },
        ]),
      );
    }) as typeof fetch, undefined, () => this.clock.now());
  }

  /** Build an engine on a store, with paper cash restored from it as the CLI does. */
  boot(store: Store, wrap?: (paper: PaperExecutor) => Executor): Engine {
    this.store = store;
    const saved = store.kvGet("paper_cash");
    const cash = saved ? BigInt(saved) : START;
    let engine!: Engine;
    this.paper = new PaperExecutor(
      { global: this.market.global, schedule: this.market.schedule, ammSchedule: this.market.ammSchedule, token: (m) => engine.tokens.get(m) },
      () => this.params,
      this.clock,
      cash,
      () => this.market.ataRent,
      (c) => store.kvSet("paper_cash", c.toString()),
    );
    engine = new Engine({
      settings: { ...loadSettings({}), grpcEndpoint: "sim" },
      store,
      params: { get: () => this.params },
      clock: this.clock,
      market: this.market,
      executor: (wrap ?? this.opts.wrapExecutor)?.(this.paper) ?? this.paper,
      tips: this.tips,
      conn: null,
      x: new XMentions(undefined),
      startingEquityLamports: cash,
    });
    this.engine = engine;
    return engine;
  }

  private tm(k: string, t: number): void {
    if (this.prof) this.prof[k] = (this.prof[k] ?? 0) + performance.now() - t;
  }

  /** One 250 ms step of the market and the engine's loops. */
  async step(): Promise<void> {
    const { engine, store, clock } = this;
    const t = this.t;
    // the tip oracle polls every 10 s, in simulated time
    if ((t - T0) % 10_000 === 0) await this.tips.refresh();
    let q = performance.now();
    const txs = this.sim.step(t, DT, 0.4); this.tm("gen", q); q = performance.now();
    for (const tx of txs) engine.ingest(tx);
    engine.drain(); this.tm("drain", q); q = performance.now();
    await engine.scoreDue(); this.tm("score", q); q = performance.now();
    if ((t - T0) % 1000 === 0) {
      engine.shadows.tick();
      engine.positions.tick();
    }
    this.tm("ticks", q); q = performance.now();
    if ((t - T0) % 2000 === 0) await engine.markEquity();
    this.tm("equity", q);
    if ((t - T0) % 30_000 === 0) {
      engine.evict();
      engine.smart.flush(clock.now());
      store.flush();
    }
    const qa = performance.now();
    await clock.advance(DT);
    this.tm("advance", qa);
    this.t += DT;
  }

  async run(minutes: number): Promise<void> {
    const end = this.t + minutes * 60_000;
    while (this.t < end) await this.step();
  }

  /** Step until the predicate holds; false if it never did within the limit. */
  async runUntil(pred: () => boolean, maxMinutes: number): Promise<boolean> {
    const end = this.t + maxMinutes * 60_000;
    while (this.t < end) {
      if (pred()) return true;
      await this.step();
    }
    return pred();
  }
}

export async function simulate(minutes: number, prof?: Record<string, number>, opts: SimOptions = {}) {
  const s = new Sim(opts, prof);
  await s.tips.refresh();
  s.boot(opts.store ?? new Store(":memory:"));
  await s.run(minutes);
  s.store.flush();
  return { engine: s.engine, store: s.store, paper: s.paper, sim: s.sim, params: s.params, start: s.start, clock: s.clock, tips: s.tips, market: s.market };
}
