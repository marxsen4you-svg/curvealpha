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
 *   curvealpha preflight         every start-up check, read-only; exits non-zero on any failure
 *                                (--accept-program-upgrade records the deployed pump programs as reviewed)
 *   curvealpha status            health of the running engine from its heartbeat (exit 0 ok, 1 degraded, 2 down)
 *   curvealpha backup [file]     consistent online copy of the database, integrity-checked
 *   curvealpha restore <file>    put a backup in place (engine stopped; the replaced database is kept)
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Connection } from "@solana/web3.js";
import { loadSettings, settingsProblems, type Settings } from "./config/settings.js";
import { ParamsManager } from "./config/manager.js";
import { countParams, resolveParams } from "./config/params.js";
import { Store } from "./store/db.js";
import { PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID, curveReader, fetchAtaRent, fetchProtocolState } from "./chain/accounts.js";
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
import { formatPreflight, programDeploySlot, runPreflight, type CheckResult } from "./ops/preflight.js";
import { assessHealth, type Heartbeat } from "./ops/health.js";
import { backupDatabase, restoreDatabase } from "./ops/backup.js";
import { createLogger, routeConsole } from "./util/log.js";

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

const dbPath = (s: Settings) => join(s.dataDir, `curvealpha-${s.mode}.sqlite`);

/** Local checks (settings, database, parameters, key file), then the read-only remote preflight. */
async function preflight(settings: Settings): Promise<{ ok: boolean; results: CheckResult[] }> {
  const local: CheckResult[] = [];
  const problems = settingsProblems(settings);
  local.push(
    problems.length
      ? { name: "settings", status: "fail", detail: problems.join("; ") }
      : { name: "settings", status: "pass", detail: `${settings.mode} mode, data in ${settings.dataDir}` },
  );
  let store: Store | null = null;
  try {
    store = new Store(dbPath(settings));
    const qc = store.get<{ quick_check: string }>("PRAGMA quick_check")?.quick_check;
    local.push({ name: "database", status: qc === "ok" ? "pass" : "fail", detail: qc === "ok" ? `${dbPath(settings)} intact` : `integrity check: ${qc}` });
  } catch (e) {
    local.push({ name: "database", status: "fail", detail: e instanceof Error ? e.message : String(e) });
  }
  const paramsPath = join(settings.dataDir, "params.json");
  try {
    if (existsSync(paramsPath)) resolveParams(JSON.parse(readFileSync(paramsPath, "utf8")));
    local.push({ name: "parameters", status: "pass", detail: existsSync(paramsPath) ? `${paramsPath} valid` : "defaults will be written on start" });
  } catch (e) {
    local.push({ name: "parameters", status: "fail", detail: `${paramsPath}: ${e instanceof Error ? e.message : String(e)}` });
  }
  if (settings.mode === "live" && settings.keypairPath) {
    try {
      const { keypair, warnings } = loadKeypair(settings.keypairPath);
      local.push({ name: "trading key", status: warnings.length ? "warn" : "pass", detail: warnings.length ? warnings.join("; ") : `wallet ${keypair.publicKey.toBase58()}` });
    } catch (e) {
      local.push({ name: "trading key", status: "fail", detail: e instanceof Error ? e.message : String(e) });
    }
  }
  const conn = new Connection(settings.rpcUrl, "confirmed");
  if (flag("accept-program-upgrade") && store) {
    for (const [name, id] of [["pump", PUMP_PROGRAM_ID], ["pumpswap", PUMP_AMM_PROGRAM_ID]] as const) {
      const slot = await programDeploySlot(conn, id);
      store.kvSet(`protocol:ack:${name}`, String(slot));
      store.logDecision(Date.now(), null, "operator", null, `${name} program deployed at slot ${slot} acknowledged as reviewed`, { program: name, slot });
    }
  }
  const s = store;
  const result = await runPreflight({
    mode: settings.mode,
    conn,
    nowMs: Date.now(),
    acknowledgedSlot: (program) => {
      const v = s?.kvGet(`protocol:ack:${program}`);
      return v ? Number(v) : null;
    },
    tipFloor: () => new TipOracle().refresh(),
    local,
  });
  store?.close();
  return result;
}

async function run(): Promise<void> {
  const settings = loadSettings();
  // every line the engine writes is timestamped, levelled and stripped of secrets
  routeConsole(createLogger({ secrets: [settings.grpcToken, settings.xBearerToken, settings.jitoAuthUuid], json: process.env.CURVEALPHA_LOG_FORMAT === "json" }));
  console.log(`CurveAlpha V5, ${settings.mode.toUpperCase()} mode. Preflight...`);
  const pf = await preflight(settings);
  console.log(formatPreflight(pf));
  if (!pf.ok) process.exit(1);
  if (settings.mode === "live" && !flag("i-accept-the-risk")) {
    console.error("Live mode trades real SOL. Re-run with --i-accept-the-risk once you have read the README's risk section and run paper mode first.");
    process.exit(1);
  }
  const store = new Store(dbPath(settings));
  const params = new ParamsManager(join(settings.dataDir, "params.json"), store);
  params.watch();
  const conn = new Connection(settings.rpcUrl, "confirmed");
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
    paper = new PaperExecutor(marketCtx, params.get, systemClock, starting, () => engineRef!.market.ataRent, (cash) =>
      store.kvSet("paper_cash", cash.toString()),
    );
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
  const restored = await engine.restorePositions(curveReader(conn));
  if (restored.restored > 0) {
    console.log(`Restored ${restored.restored} open position(s) from the database${restored.unmanaged ? `, ${restored.unmanaged} without a readable curve (retried every 30 s)` : ""}.`);
  }

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
      onConfirmedSlot: (slot, bank) => engine.tokens.onConfirmedSlot(slot, bank),
      onGap: (from) => engine.tokens.markGapSince(from),
    },
  );
  engine.onPressure = (pause) => ingest.setPaused(pause);
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  engine.statusProbe = () => {
    const p99 = loop.percentile(99) / 1e6;
    loop.reset();
    const st = ingest.status;
    return {
      ingest: { connected: st.connected, lastMessageAtMs: st.lastMessageAtMs, lastSlot: st.lastSlot, reconnects: st.reconnects, gaps: st.gaps.length },
      eventLoopP99Ms: Number.isFinite(p99) ? p99 : null,
    };
  };
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

  const dash = startDashboard({ engine, params, settings, ingest, tips, store });
  console.log(`Dashboard: ${dash.url}  (${countParams()} tunable parameters in ${join(settings.dataDir, "params.json")})`);

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log("Stopping: no new entries; waiting up to 30 s for orders and exits in flight...");
    clearInterval(refresh);
    ingest.stop();
    engine.stop();
    const settled = await engine.settle(30_000);
    console.log(settled ? "Everything in flight settled." : "Some orders or exits were still in flight; they are reconciled against the wallet on the next start.");
    if (paper) store.kvSet("paper_cash", paper.cash.toString());
    store.kvSet(`survival:${settings.mode}`, JSON.stringify(engine.survivalSnapshot()));
    store.kvSet(`heartbeat:${settings.mode}`, JSON.stringify({ ...engine.heartbeat(), atMs: 0 })); // stopped, not stale
    tips.stop();
    dash.close();
    params.stop();
    store.close();
    process.exit(0);
  };
  const onSignal = () => void shutdown().catch((e) => {
    console.error("shutdown failed", e);
    process.exit(1);
  });
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

async function main(): Promise<void> {
  const settings = loadSettings();
  if (cmd === "run") return run();
  if (cmd === "preflight") {
    const pf = await preflight(settings);
    console.log(formatPreflight(pf));
    process.exitCode = pf.ok ? 0 : 1;
    return;
  }
  if (cmd === "restore") {
    const file = args[1];
    if (!file) {
      console.error("Usage: curvealpha restore <backup file>");
      process.exitCode = 1;
      return;
    }
    const r = restoreDatabase(file, dbPath(settings), Date.now());
    console.log(r.ok ? `Restored ${file} to ${dbPath(settings)}${r.asidePath ? `; the previous database is at ${r.asidePath}` : ""}.` : `Restore refused: ${r.error}`);
    process.exitCode = r.ok ? 0 : 1;
    return;
  }
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
  const store = new Store(dbPath(settings));
  if (cmd === "status") {
    const raw = store.kvGet(`heartbeat:${settings.mode}`);
    const hb = raw ? (JSON.parse(raw) as Heartbeat) : null;
    const h = assessHealth(hb && hb.atMs > 0 ? hb : null, Date.now());
    console.log(`${settings.mode} engine: ${h.status.toUpperCase()}${hb && hb.atMs === 0 ? " (stopped cleanly)" : ""}`);
    for (const pr of h.problems) console.log(`  - ${pr}`);
    if (hb) {
      console.log(`  survival ${hb.survival.mode}, ${hb.positions.open} open position(s), queue depth ${hb.queue.depth}, ${hb.queue.dropped} dropped`);
      if (hb.ingest) console.log(`  feed slot ${hb.ingest.lastSlot}, ${hb.ingest.reconnects} reconnects, ${hb.ingest.gaps} gaps`);
    }
    const open = store.all<{ id: number; mint: string; tokens_left: string; opened_ms: number }>("SELECT id, mint, tokens_left, opened_ms FROM positions WHERE status = 'open' AND mode = ?", settings.mode);
    for (const o of open) console.log(`  position ${o.id} ${o.mint} ${o.tokens_left} tokens, opened ${new Date(o.opened_ms).toISOString()}`);
    process.exitCode = h.status === "ok" ? 0 : h.status === "degraded" ? 1 : 2;
    store.close();
    return;
  }
  if (cmd === "backup") {
    const dest = args[1] ?? join(settings.dataDir, "backups", `curvealpha-${settings.mode}-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`);
    mkdirSync(dirname(dest), { recursive: true });
    const r = backupDatabase(store, dest);
    console.log(r.ok ? `Backup written: ${r.path} (${(r.bytes / 1e6).toFixed(1)} MB, integrity ok)` : `Backup FAILED: ${r.error}`);
    process.exitCode = r.ok ? 0 : 1;
    store.close();
    return;
  }
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
    console.error(`Unknown command "${cmd}". Commands: run, preflight, status, backup [file], restore <file>, costs, evaluate, replay <id>, decisions, check-params`);
    process.exitCode = 1;
  }
  store.close();
}

void main();
