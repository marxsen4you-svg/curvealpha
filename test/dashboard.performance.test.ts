/**
 * The dashboard shares the engine's event loop, so nothing it does may
 * block for long. Measured before this change: the evaluation report took
 * 2.7 s with 20 000 shadow outcomes and ran inside a state request every
 * five minutes; /api/state took 120 ms per client per second with a week of
 * two-second equity marks.
 *
 *  - the evaluation report is computed in a worker thread, never on the
 *    request path: a state request answers at once and the report arrives
 *    on a later one;
 *  - equity marks older than a day are thinned to one per minute, so the
 *    history the dashboard reads stays small.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDashboard } from "../src/dashboard/server.js";
import { ParamsManager } from "../src/config/manager.js";
import { loadSettings } from "../src/config/settings.js";
import { TipOracle } from "../src/exec/tips.js";
import { Store } from "../src/store/db.js";
import { evaluate } from "../src/meta/evaluate.js";
import { Sim } from "./helpers/simulate.js";

describe("dashboard never blocks on the evaluation report", () => {
  it("answers a state request at once and delivers the report, computed in a worker, on a later one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ca-dash-"));
    const s = new Sim();
    await s.tips.refresh();
    s.boot(new Store(join(dir, "db.sqlite")));
    await s.run(8);
    s.store.flush();
    const params = new ParamsManager(join(dir, "params.json"), s.store);
    const port = 19_000 + Math.floor(Math.random() * 900);
    const dash = startDashboard({ engine: s.engine, params, settings: { ...loadSettings({}), grpcEndpoint: "sim", dashboardPort: port }, ingest: null, tips: new TipOracle(), store: s.store });
    try {
      await new Promise((r) => setTimeout(r, 100));
      const first = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
      expect(first.evaluation).toBeNull();
      expect(first.evaluationPending).toBe(true);
      let later = first;
      for (let i = 0; i < 100 && later.evaluation === null; i++) {
        await new Promise((r) => setTimeout(r, 100));
        later = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
      }
      expect(later.evaluation).not.toBeNull();
      // the worker computed the same report the engine's own process would
      const direct = evaluate(s.store, params.get(), Date.now());
      expect(later.evaluation.samples).toBe(direct.samples);
      expect(later.evaluation.baseline.clusters).toBe(direct.baseline.clusters);
    } finally {
      dash.close();
    }
  }, 300_000);
});

describe("equity history stays small", () => {
  it("thins marks older than a day to one per minute and keeps recent marks and the latest one", async () => {
    const s = new Sim();
    await s.tips.refresh();
    const e = s.boot(new Store(":memory:"));
    const now = s.clock.now();
    s.store.db.exec("BEGIN");
    for (let t = now - 3 * 86_400_000; t <= now; t += 2000) s.store.run("INSERT INTO equity(ts_ms, equity_lamports, cash_lamports, mode) VALUES (?, ?, ?, ?)", t, 3e9, 3e9, "paper");
    s.store.db.exec("COMMIT");
    e.prune();
    const old = s.store.get<{ n: number; minutes: number }>(
      "SELECT COUNT(*) AS n, COUNT(DISTINCT ts_ms / 60000) AS minutes FROM equity WHERE ts_ms < ?",
      now - 86_400_000,
    )!;
    expect(old.n).toBe(old.minutes); // one mark per minute
    expect(old.minutes).toBe(2 * 24 * 60);
    const recent = s.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM equity WHERE ts_ms >= ?", now - 86_400_000)!.n;
    expect(recent).toBe(86_400_000 / 2000 + 1);
  });
});
