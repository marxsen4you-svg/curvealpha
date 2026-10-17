/**
 * Runs the real engine (parsing, token book, scoring, shadow ledger, Capital
 * Survival Engine, paper executor, exits, persistence) over the synthetic
 * market on a manual clock. Optional per-stage timing for profiling.
 */
import { Engine } from "../../src/engine.js";
import { Store } from "../../src/store/db.js";
import { resolveParams } from "../../src/config/params.js";
import { loadSettings } from "../../src/config/settings.js";
import { PaperExecutor } from "../../src/exec/executor.js";
import { TipOracle } from "../../src/exec/tips.js";
import { XMentions } from "../../src/score/context.js";
import { ManualClock } from "../../src/util/clock.js";
import { MAINNET_GLOBAL, curveSchedule, fixtureSchedule } from "./gen.js";
import { SyntheticMarket } from "./market.js";

export const T0 = Date.UTC(2026, 9, 17, 0, 0, 0);

export async function simulate(minutes: number, prof?: Record<string, number>) {
  const tm = (k: string, t: number) => { if (prof) prof[k] = (prof[k] ?? 0) + performance.now() - t; };
  const clock = new ManualClock(T0);
  const store = new Store(":memory:");
  const params = resolveParams({
    risk: { minOutcomeSamples: 40, minEdgePct: 0.01 },
    scoring: { baseAlphaThreshold: 55, smallBankrollThresholdAdd: 0, trajectoryMinCorpus: 60, shadowMinScore: 30 },
    ingest: { tokenStateTtlSec: 600 },
    exits: { maxHoldSec: 300 },
  });
  const tips = new TipOracle("http://tips.invalid", (async () =>
    new Response(
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
    )) as typeof fetch);
  await tips.refresh();
  const market = { global: MAINNET_GLOBAL, schedule: curveSchedule(), ammSchedule: fixtureSchedule(), ataRent: 2_074_080n, updatedAtMs: T0 };
  let engine!: Engine;
  const start = 3_000_000_000n;
  const paper = new PaperExecutor(
    { global: market.global, schedule: market.schedule, ammSchedule: market.ammSchedule, token: (m) => engine.tokens.get(m) },
    () => params,
    clock,
    start,
    () => market.ataRent,
  );
  engine = new Engine({
    settings: { ...loadSettings({}), grpcEndpoint: "sim" },
    store,
    params: { get: () => params },
    clock,
    market,
    executor: paper,
    tips,
    conn: null,
    x: new XMentions(undefined),
    startingEquityLamports: start,
  });
  const sim = new SyntheticMarket(MAINNET_GLOBAL, curveSchedule(), 7);
  const dt = 250;
  for (let t = T0; t < T0 + minutes * 60_000; t += dt) {
    let q = performance.now();
    const txs = sim.step(t, dt, 0.4); tm("gen", q); q = performance.now();
    for (const tx of txs) engine.ingest(tx);
    engine.drain(); tm("drain", q); q = performance.now();
    await engine.scoreDue(); tm("score", q); q = performance.now();
    if ((t - T0) % 1000 === 0) {
      engine.shadows.tick();
      engine.positions.tick();
    }
    tm("ticks", q); q = performance.now();
    if ((t - T0) % 2000 === 0) await engine.markEquity();
    tm("equity", q);
    if ((t - T0) % 30_000 === 0) {
      engine.evict();
      engine.smart.flush(clock.now());
      store.flush();
    }
    const qa = performance.now();
    await clock.advance(dt);
    tm("advance", qa);
  }
  store.flush();
  return { engine, store, paper, sim, params, start };
}

