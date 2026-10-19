/**
 * The running engine publishes its heartbeat: persisted every equity mark
 * (two seconds) for `curvealpha status`, and served at /api/health.
 */
import { describe, expect, it } from "vitest";
import { request } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDashboard } from "../src/dashboard/server.js";
import { ParamsManager } from "../src/config/manager.js";
import { loadSettings } from "../src/config/settings.js";
import { assessHealth, type Heartbeat } from "../src/ops/health.js";
import { simulate } from "./helpers/simulate.js";

describe("engine heartbeat", () => {
  it("is persisted every equity mark and describes the engine's actual state", async () => {
    const { engine, store, clock, tips } = await simulate(8);
    engine.statusProbe = () => ({ ingest: { connected: true, lastMessageAtMs: clock.now() - 300, lastSlot: 1234, reconnects: 2, gaps: 0 }, eventLoopP99Ms: 7 });
    await engine.markEquity();
    const hb = JSON.parse(store.kvGet("heartbeat:paper")!) as Heartbeat;
    expect(hb.atMs).toBe(clock.now());
    expect(hb.positions.open).toBe(engine.positions.positions.size);
    expect(hb.tipFloorAtMs).toBe(tips.floor!.atMs);
    expect(hb.ingest!.reconnects).toBe(2);
    expect(hb.eventLoopP99Ms).toBe(7);
    expect(hb.survival.mode).toBe(engine.survivalSnapshot().mode);
    expect(assessHealth(hb, clock.now()).status).toBe("ok");
  }, 300_000);

  it("is served at /api/health with its assessment", async () => {
    const { engine, store, tips } = await simulate(2);
    await engine.markEquity();
    const params = new ParamsManager(join(mkdtempSync(join(tmpdir(), "ca-")), "params.json"), store);
    const port = 19_000 + Math.floor(Math.random() * 900);
    const dash = startDashboard({ engine, params, settings: { ...loadSettings({}), grpcEndpoint: "sim", dashboardPort: port }, ingest: null, tips, store });
    try {
      await new Promise((r) => setTimeout(r, 100));
      const body = await new Promise<string>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, path: "/api/health", headers: { host: `127.0.0.1:${port}` } }, (res) => {
          let b = "";
          res.on("data", (c) => (b += c));
          res.on("end", () => resolve(b));
        });
        req.on("error", reject);
        req.end();
      });
      const h = JSON.parse(body);
      expect(["ok", "degraded"]).toContain(h.status);
      expect(h.heartbeat.mode).toBe("paper");
    } finally {
      dash.close();
    }
  }, 300_000);
});
