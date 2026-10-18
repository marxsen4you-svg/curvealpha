/**
 * Repeatable micro and pipeline benchmarks on fixed seeds and synthetic data.
 *
 *   npx tsx scripts/bench.ts            human table
 *   npx tsx scripts/bench.ts --json     machine readable
 *
 * Nothing here touches the network. Every dataset is generated from a fixed
 * seed, so two runs on the same machine measure the same work. Results are
 * medians over repeated runs; the environment is printed with them.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, cpus, totalmem, platform, release } from "node:os";
import { join } from "node:path";
import { simulate, T0 } from "../test/helpers/simulate.js";
import { SyntheticMarket } from "../test/helpers/market.js";
import { MAINNET_GLOBAL, curveSchedule, rng } from "../test/helpers/gen.js";
import { Engine } from "../src/engine.js";
import { Store } from "../src/store/db.js";
import { DEFAULT_PARAMS, resolveParams } from "../src/config/params.js";
import { CapitalSurvivalEngine, type Candidate } from "../src/risk/survival.js";
import { scoreToken } from "../src/score/alpha.js";
import { creatorFactor, holdersFactor, microstructureFactor, smartMoneyFactor, socialFactor, trajectoryFactor, velocityFactor } from "../src/score/factors.js";
import { evaluate } from "../src/meta/evaluate.js";
import { startDashboard } from "../src/dashboard/server.js";
import { ParamsManager } from "../src/config/manager.js";
import { loadSettings } from "../src/config/settings.js";
import { TipOracle } from "../src/exec/tips.js";
import type { RawTx } from "../src/chain/events.js";
import type { Outcome } from "../src/risk/kelly.js";

const asJson = process.argv.includes("--json");
const results: Array<{ name: string; unit: string; p50: number; p95: number; n: number; note?: string }> = [];

function stats(xs: number[]): { p50: number; p95: number } {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return { p50: q(0.5), p95: q(0.95) };
}

function record(name: string, unit: string, xs: number[], note?: string): void {
  results.push({ name, unit, ...stats(xs), n: xs.length, note });
}

function time(f: () => unknown, reps: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < reps; i++) {
    const t = performance.now();
    f();
    out.push(performance.now() - t);
  }
  return out;
}

// ------------------------------------------------ 1. Survival Engine decide()
function heavyTailed(n: number, seed: number): Outcome[] {
  const r = rng(seed);
  return Array.from({ length: n }, () => {
    const u = r();
    const multiple = u < 0.55 ? 0.55 : u < 0.8 ? 1.3 : u < 0.95 ? 2.4 : 6;
    return { multiple, sellTxCount: multiple > 1 ? 3 : 1 };
  });
}
for (const n of [60, 200, 800]) {
  const p = DEFAULT_PARAMS;
  const outcomes = heavyTailed(n, 7);
  const c = (seed: number): Candidate => ({
    mint: "M", alphaScore: 92, horizonSec: 30, outcomes,
    entryFixedLamports: 15_300, exitFixedLamportsPerTx: 15_300, entryTipLamports: 10_000,
    ataRentLamports: 1_513_840, spendableLamports: 100e9, seed,
  });
  let seed = 1;
  const xs = time(() => new CapitalSurvivalEngine(() => p, 2e9, T0).decide(c(seed++), T0), n >= 800 ? 15 : 30);
  record(`survival.decide (${n} outcomes, ${p.risk.kellyBootstrapSamples} bootstrap)`, "ms", xs, "synchronous, on the event loop");
}

// ------------------------------------- 2. ingest throughput and 3. scoring
const market = new SyntheticMarket(MAINNET_GLOBAL, curveSchedule(), 11);
const txs: RawTx[] = [];
for (let t = T0; t < T0 + 10 * 60_000; t += 250) txs.push(...market.step(t, 250, 0.4));
{
  const runs: number[] = [];
  for (let rep = 0; rep < 5; rep++) {
    const { engine } = await simulate(0); // a fresh engine and store
    const t = performance.now();
    for (const tx of txs) engine.ingest(tx);
    engine.drain();
    runs.push(((performance.now() - t) / txs.length) * 1000);
  }
  record(`ingest: parse + token book (${txs.length} txs)`, "us/tx", runs, `${(1000 / stats(runs).p50).toFixed(0)}k tx/s on one core`);
}

const sim = await simulate(20);
const e: Engine = sim.engine;
{
  const now = T0 + 20 * 60_000;
  const recs = [...e.tokens.tokens.values()].filter((r) => (now - r.createdAtMs) / 1000 >= 15);
  const ctx = (rec: (typeof recs)[number]) => ({
    creatorStats: e.creators.stats(rec.creator, now), funders: e.funding.known, smartTop: e.smart.top,
    recentNames: e.names.since(now - 3_600_000, `${rec.name} ${rec.symbol}`), social: null, corpus: e.corpus.entries, global: e.market.global,
  });
  const p = sim.params;
  const all: number[] = [];
  const per: Record<string, number[]> = { creator: [], microstructure: [], holders: [], velocity: [], smartMoney: [], social: [], trajectory: [] };
  for (const rec of recs) {
    const c = ctx(rec);
    all.push(...time(() => scoreToken(rec, 30, now, c, p), 1));
    per.creator!.push(...time(() => creatorFactor(rec, c.creatorStats, p), 1));
    per.microstructure!.push(...time(() => microstructureFactor(rec, c.funders, p), 1));
    per.holders!.push(...time(() => holdersFactor(rec, now), 1));
    per.velocity!.push(...time(() => velocityFactor(rec, now, p), 1));
    per.smartMoney!.push(...time(() => smartMoneyFactor(rec, c.smartTop, p), 1));
    per.social!.push(...time(() => socialFactor(rec, c.recentNames, null), 1));
    per.trajectory!.push(...time(() => trajectoryFactor(rec, now, c.corpus, p), 1));
  }
  record(`scoreToken (${recs.length} live tokens, corpus ${e.corpus.entries.length})`, "ms", all);
  for (const [k, xs] of Object.entries(per)) record(`  factor ${k}`, "ms", xs);
}

// --------------------------------------------- 4. persistence and dashboard
const dir = mkdtempSync(join(tmpdir(), "ca-bench-"));
try {
  const store = new Store(join(dir, "bench.sqlite"));
  // a deferred batch of decision-sized writes, the engine's write pattern
  const flushes: number[] = [];
  for (let rep = 0; rep < 10; rep++) {
    for (let i = 0; i < 1000; i++) store.defer(() => store.run("INSERT INTO equity(ts_ms, equity_lamports, cash_lamports, mode) VALUES (?, ?, ?, ?)", T0 + i, 2e9, 2e9, "paper"));
    const t = performance.now();
    store.flush();
    flushes.push(performance.now() - t);
  }
  record("store.flush (1000 deferred inserts, WAL, file)", "ms", flushes);

  // seven days of equity marks every 2 s, as markEquity writes them
  const now = T0 + 7 * 86_400_000;
  store.db.exec("DELETE FROM equity");
  store.db.exec("BEGIN");
  const ins = store.db.prepare("INSERT INTO equity(ts_ms, equity_lamports, cash_lamports, mode) VALUES (?, ?, ?, ?)");
  for (let t = now - 7 * 86_400_000; t < now; t += 2000) ins.run(t, 2e9, 2e9, "paper");
  store.db.exec("COMMIT");
  const nEq = store.get<{ n: number }>("SELECT COUNT(*) AS n FROM equity")!.n;
  // closed shadows for the evaluation report, with factor values and short paths
  const r = rng(5);
  store.db.exec("BEGIN");
  const sh = store.db.prepare("INSERT INTO shadows(mint, horizon_s, score, factors, opened_ms, closed_ms, multiple, sell_tx_count, close_reason, path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (let i = 0; i < 20_000; i++) {
    const values = { creator: r(), microstructure: r(), holders: r(), velocity: r(), smartMoney: r() < 0.5 ? null : r(), social: r(), trajectory: r() };
    const opened = now - 13 * 86_400_000 + i * 50_000;
    const m = r() < 0.6 ? 0.5 + r() * 0.4 : 1 + r() * r() * 8;
    const path = JSON.stringify(Array.from({ length: 60 }, (_, k) => [k, 1 + (m - 1) * (k / 59)]));
    sh.run(`M${i % 6000}`, [15, 30, 60, 90][i % 4]!, 30 + r() * 60, JSON.stringify({ values }), opened, opened + 120_000, m, 1 + Math.floor(r() * 3), "bench", path);
  }
  store.db.exec("COMMIT");
  const params = resolveParams({});
  record("evaluate() (20k closed shadows, 14 days)", "ms", time(() => evaluate(store, params, now), 3), "the dashboard now runs it in a worker thread");

  const pm = new ParamsManager(join(dir, "params.json"), store);
  const tips = new TipOracle("http://tips.invalid", (async () => new Response("[]")) as typeof fetch);
  const port = 17_000 + Math.floor(Math.random() * 900);
  const dash = startDashboard({ engine: e, params: pm, settings: { ...loadSettings({}), grpcEndpoint: "sim", dashboardPort: port }, ingest: null, tips, store });
  await new Promise((res) => setTimeout(res, 200));
  const get = async () => {
    const t = performance.now();
    const res = await fetch(`${dash.url}/api/state`);
    await res.text();
    return performance.now() - t;
  };
  await get(); // warm
  const xs: number[] = [];
  // spaced past the one-second snapshot so every request builds the state (no cache hits)
  for (let i = 0; i < 6; i++) {
    await new Promise((res) => setTimeout(res, 1100));
    xs.push(await get());
  }
  record(`dashboard /api/state (${nEq} equity marks, uncached build)`, "ms", xs, "built at most once per second, shared by all clients");
  dash.close();
  store.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const env = { node: process.version, platform: `${platform()} ${release()}`, cpu: cpus()[0]?.model ?? "?", cores: cpus().length, memGb: Math.round(totalmem() / 2 ** 30) };
if (asJson) {
  console.log(JSON.stringify({ env, results }, null, 2));
} else {
  console.log(`node ${env.node} | ${env.platform} | ${env.cpu} x${env.cores} | ${env.memGb} GB`);
  const w = Math.max(...results.map((r) => r.name.length));
  for (const r of results) console.log(`${r.name.padEnd(w)}  p50 ${r.p50.toFixed(3).padStart(9)}  p95 ${r.p95.toFixed(3).padStart(9)} ${r.unit.padEnd(5)} n=${String(r.n).padEnd(4)} ${r.note ?? ""}`);
}
process.exit(0);
