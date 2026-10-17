/** Runs the engine on the synthetic market and serves the dashboard, for visual checks. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { simulate } from "../test/helpers/simulate.js";
import { startDashboard } from "../src/dashboard/server.js";
import { ParamsManager } from "../src/config/manager.js";
import { loadSettings } from "../src/config/settings.js";
import { TipOracle, parseTipFloor } from "../src/exec/tips.js";

const { engine, store } = await simulate(Number(process.argv[2] ?? 8));
const params = new ParamsManager(join(mkdtempSync(join(tmpdir(), "ca-")), "params.json"), store);
const tips = new TipOracle();
const now = Date.now();
for (let i = 0; i < 60; i++) {
  const f = parseTipFloor([{ landed_tips_25th_percentile: 0.000005, landed_tips_50th_percentile: 0.00001 + 0.000004 * Math.sin(i / 6), landed_tips_75th_percentile: 0.00003 + 0.00001 * Math.sin(i / 5), landed_tips_95th_percentile: 0.0001, landed_tips_99th_percentile: 0.0005, ema_landed_tips_50th_percentile: 0.000011 }], now - (60 - i) * 10_000)!;
  tips.history.push(f);
  tips.floor = f;
}
const dash = startDashboard({ engine, params, settings: { ...loadSettings({}), grpcEndpoint: "https://grpc.example:443", dashboardPort: 17_999 }, ingest: null, tips, store });
await new Promise((r) => setTimeout(r, 300));
if (process.argv[3]) {
  // a screenshot helper: the event loop must stay free so the server can answer it
  await promisify(execFile)("python3", [process.argv[3], dash.url, process.argv[4]!, process.argv[5]!]);
} else {
  console.log(`Dashboard on ${dash.url}; press Ctrl+C to stop.`);
  await new Promise(() => undefined);
}
dash.close();
process.exit(0);
