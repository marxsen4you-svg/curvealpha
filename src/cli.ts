#!/usr/bin/env node
/**
 * CurveAlpha command line.
 *
 *   curvealpha run               start the engine (paper trading unless told otherwise)
 *   curvealpha costs             fixed cost viability table for small bankrolls
 *   curvealpha evaluate          offline evaluation of factors, thresholds, Kelly and ladders
 *   curvealpha replay <id>       re-derive a logged sizing decision and check it is identical
 *   curvealpha decisions         list recent decisions
 *   curvealpha check-params      validate data/params.json
 */
import { join } from "node:path";
import { Connection } from "@solana/web3.js";
import { loadSettings, settingsProblems } from "./config/settings.js";
import { ParamsManager } from "./config/manager.js";
import { countParams } from "./config/params.js";
import { Store } from "./store/db.js";
import { fetchAtaRent, fetchProtocolState } from "./chain/accounts.js";
import { pumpSdk, pumpSwapSdk } from "./chain/sdk.js";
import { scheduleFromSdk } from "./chain/state.js";
import { Engine, type MarketState } from "./engine.js";
import { TipOracle, type TipFloor } from "./exec/tips.js";
import { BundleClient } from "./exec/jito.js";
import { LiveExecutor, PaperExecutor, type Executor } from "./exec/executor.js";
import { loadKeypair } from "./exec/wallet.js";
import { YellowstoneIngest } from "./ingest/yellowstone.js";
import { XMentions } from "./score/context.js";
import { startDashboard } from "./dashboard/server.js";
import { evaluate } from "./meta/evaluate.js";
import { replayDecision } from "./meta/replay.js";
import { systemClock } from "./util/clock.js";
import { viabilityTable } from "./risk/viability.js";
import { installFaultHandlers } from "./util/faults.js";

const args = process.argv.slice(2);
const cmd = args[0] ?? "run";
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

async function fetchMarket(conn: Connection): Promise<MarketState> {
  const proto = await fetchProtocolState(conn);
  const ammAcc = await conn.getAccountInfo(pumpSwapSdk.PUMP_AMM_FEE_CONFIG_PDA, "confirmed");
  const ammSchedule = ammAcc ? scheduleFromSdk(pumpSdk.PUMP_SDK.decodeFeeConfig(ammAcc)) : proto.schedule;
  return { global: proto.global, schedule: proto.schedule, ammSchedule, ataRent: await fetchAtaRent(conn), updatedAtMs: Date.now() };
}

async function run(): Promise<void> {
  const settings = loadSettings();
  const problems = settingsProblems(settings);
  if (problems.length) {
    console.error("CurveAlpha cannot start:\n" + problems.map((p) => `  - ${p}`).join("\n"));
    process.exit(1);
  }
  if (settings.mode === "live" && !flag("i-accept-the-risk")) {
    console.error("Live mode trades real SOL. Re-run with --i-accept-the-risk once you have read the README's risk section and run paper mode first.");
    process.exit(1);
  }
  const store = new Store(join(settings.dataDir, `curvealpha-${settings.mode}.sqlite`));
  const params = new ParamsManager(join(settings.dataDir, "params.json"), store);
  params.watch();
  const conn = new Connection(settings.rpcUrl, "confirmed");
  console.log(`CurveAlpha V5, ${settings.mode.toUpperCase()} mode. Reading pump Global and FeeConfig from chain...`);
  let market: MarketState;
  try {
    market = await fetchMarket(conn);
  } catch (e) {
    console.error(`Could not read the pump protocol accounts: ${e instanceof Error ? e.message : e}. The engine will not trade on assumed fees.`);
    process.exit(1);
  }
  const t0 = market.schedule.feeTiers[0];
  console.log(`Curve fee tier 0: ${t0?.protocolFeeBps} bps protocol + ${t0?.creatorFeeBps} bps creator. ATA rent ${market.ataRent} lamports.`);

  const tips = new TipOracle(undefined, fetch, (f: TipFloor) =>
    store.defer(() => store.run("INSERT INTO tips(ts_ms, p25, p50, p75, p95, p99, ema50) VALUES (?, ?, ?, ?, ?, ?, ?)", f.atMs, f.p25, f.p50, f.p75, f.p95, f.p99, f.ema50)),
  );
  tips.start();

  let executor: Executor;
  let starting: bigint;
  let paper: PaperExecutor | null = null;
  // the engine reads token records through this, so it is filled in once the engine exists
  let engineRef: Engine | null = null;
  const marketCtx = {
    get global() { return engineRef!.market.global; },
    get schedule() { return engineRef!.market.schedule; },
    get ammSchedule() { return engineRef!.market.ammSchedule; },
    token: (m: string) => engineRef!.tokens.get(m),
  };
  if (settings.mode === "paper") {
    const saved = store.kvGet("paper_cash");
    starting = saved ? BigInt(saved) : BigInt(Math.round(settings.paperStartingSol * 1e9));
    paper = new PaperExecutor(marketCtx, params.get, systemClock, starting, () => engineRef!.market.ataRent);
    executor = paper;
  } else {
    const { keypair, warnings } = loadKeypair(settings.keypairPath!);
    for (const w of warnings) console.warn(`WARNING: ${w}`);
    const bundles = new BundleClient({ blockEngineUrl: settings.blockEngineUrl, bamUrl: settings.bamUrl, authUuid: settings.jitoAuthUuid });
    executor = new LiveExecutor(conn, keypair, bundles, params.get, systemClock);
    starting = await executor.spendableLamports();
    console.log(`Trading wallet ${keypair.publicKey.toBase58()} holds ${Number(starting) / 1e9} SOL.`);
  }

  const engine = new Engine({
    settings,
    store,
    params,
    clock: systemClock,
    market,
    executor,
    tips,
    conn,
    x: new XMentions(settings.xBearerToken),
    startingEquityLamports: starting,
  });
  engineRef = engine;

  const p = params.get;
  const ingest = new YellowstoneIngest(
    {
      endpoint: settings.grpcEndpoint,
      xToken: settings.grpcToken,
      reconnectBaseMs: () => p().ingest.reconnectBaseMs,
      reconnectMaxMs: () => p().ingest.reconnectMaxMs,
      fromSlotRewind: () => p().ingest.fromSlotRewind,
      pingIntervalSec: () => p().ingest.pingIntervalSec,
    },
    {
      onTx: (tx) => engine.ingest(tx),
      onDeadSlot: (slot) => engine.tokens.onDeadSlot(slot),
      onConfirmedSlot: (slot) => engine.tokens.onConfirmedSlot(slot),
      onGap: (from) => engine.tokens.markGapSince(from),
    },
  );
  engine.onPressure = (pause) => ingest.setPaused(pause);
  installFaultHandlers({
    proc: process,
    halt: (reason) => engine.survival.halt(reason),
    record: (m) => store.logDecision(Date.now(), null, "fault", null, m, {}),
    flush: () => {
      if (paper) store.kvSet("paper_cash", paper.cash.toString());
      store.kvSet(`survival:${settings.mode}`, JSON.stringify(engine.survivalSnapshot()));
      store.flush();
    },
    exit: (code) => process.exit(code),
    log: (m, e) => console.error(`FAULT: ${m}`, e),
  });
  void ingest.start();
  void engine.run();

  const refresh = setInterval(async () => {
    try {
      engine.market = await fetchMarket(conn);
    } catch {
      /* keep the last good state; the dashboard shows its age */
    }
  }, 300_000);
  const persist = setInterval(() => {
    if (paper) store.kvSet("paper_cash", paper.cash.toString());
  }, 2_000);

  const dash = startDashboard({ engine, params, settings, ingest, tips, store });
  console.log(`Dashboard: ${dash.url}  (${countParams()} tunable parameters in ${join(settings.dataDir, "params.json")})`);

  const shutdown = () => {
    console.log("Stopping: flushing state...");
    clearInterval(refresh);
    clearInterval(persist);
    if (paper) store.kvSet("paper_cash", paper.cash.toString());
    ingest.stop();
    tips.stop();
    engine.stop();
    dash.close();
    params.stop();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main(): Promise<void> {
  const settings = loadSettings();
  if (cmd === "run") return run();
  if (cmd === "costs") {
    let floor: TipFloor | null = null;
    const tipArg = opt("tip");
    if (!tipArg) floor = await new TipOracle().refresh();
    const tip = tipArg ? BigInt(tipArg) : floor ? floor.ema50 : null;
    if (tip === null) {
      console.error("Could not reach the Jito tip floor. Pass a tip in lamports: curvealpha costs --tip 100000");
      process.exit(1);
    }
    console.log(viabilityTable(tip, BigInt(opt("cu-price") ?? 1000)));
    return;
  }
  const store = new Store(join(settings.dataDir, `curvealpha-${settings.mode}.sqlite`));
  if (cmd === "evaluate") {
    const pm = new ParamsManager(join(settings.dataDir, "params.json"), store);
    const r = evaluate(store, pm.get(), Date.now(), Number(opt("days") ?? 14), Number(opt("tip") ?? 100_000));
    console.log(JSON.stringify(r, null, 2));
    if (flag("apply-weights")) {
      if (!r.weights.suggested) console.log("No weight change improved the held-out result; nothing applied.");
      else {
        const res = pm.update({ scoring: { weights: r.weights.suggested } }, "evaluate --apply-weights");
        console.log(res.ok ? "Suggested weights applied and audited." : `Rejected: ${res.error}`);
      }
    }
  } else if (cmd === "replay") {
    const id = Number(args[1]);
    const r = replayDecision(store, id);
    console.log(r.identical ? `Decision ${id} replays identically: ${r.original.reasons[0]}` : `Decision ${id} DIFFERS:\n  ${r.differences.join("\n  ")}`);
    process.exitCode = r.identical ? 0 : 2;
  } else if (cmd === "decisions") {
    const rows = store.all<{ id: number; ts_ms: number; mint: string; kind: string; approved: number | null; summary: string }>(
      "SELECT id, ts_ms, mint, kind, approved, summary FROM decisions ORDER BY id DESC LIMIT ?",
      Number(opt("limit") ?? 30),
    );
    for (const r of rows) console.log(`${r.id}\t${new Date(r.ts_ms).toISOString()}\t${r.kind}\t${r.approved === null ? "" : r.approved ? "yes" : "no"}\t${r.mint ?? ""}\t${r.summary}`);
  } else if (cmd === "check-params") {
    try {
      const pm = new ParamsManager(join(settings.dataDir, "params.json"), store);
      console.log(`params.json is valid (${countParams(pm.get())} parameters).`);
    } catch (e) {
      console.error(`params.json is invalid: ${e instanceof Error ? e.message : e}`);
      process.exitCode = 1;
    }
  } else {
    console.error(`Unknown command "${cmd}". Commands: run, costs, evaluate, replay <id>, decisions, check-params`);
    process.exitCode = 1;
  }
  store.close();
}

void main();
