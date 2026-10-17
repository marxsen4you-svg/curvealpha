import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDashboard } from "../src/dashboard/server.js";
import { ParamsManager } from "../src/config/manager.js";
import { loadSettings } from "../src/config/settings.js";
import { TipOracle } from "../src/exec/tips.js";
import { simulate } from "./helpers/simulate.js";

describe("dashboard", () => {
  it("serves live state, and only token-bearing same-origin requests can change parameters", async () => {
    const { engine, store } = await simulate(4);
    const params = new ParamsManager(join(mkdtempSync(join(tmpdir(), "ca-")), "params.json"), store);
    const port = 17_000 + Math.floor(Math.random() * 2000);
    const settings = { ...loadSettings({}), grpcEndpoint: "sim", dashboardPort: port };
    const dash = startDashboard({ engine, params, settings, ingest: null, tips: new TipOracle(), store });
    try {
      await new Promise((r) => setTimeout(r, 100));
      const page = await (await fetch(dash.url)).text();
      const token = /name="curvealpha-token" content="([0-9a-f]+)"/.exec(page)![1]!;
      const state = await (await fetch(`${dash.url}/api/state`)).json();
      expect(state.survival.mode).toBeDefined();
      expect(state.counters.scored).toBeGreaterThan(0);
      expect(JSON.stringify(state)).not.toMatch(/secret/i);

      const body = JSON.stringify({ risk: { kellyFraction: 0.3 } });
      const denied = await fetch(`${dash.url}/api/params`, { method: "POST", body, headers: { "content-type": "application/json" } });
      expect(denied.status).toBe(403);
      const foreign = await fetch(`${dash.url}/api/params`, { method: "POST", body, headers: { "x-curvealpha-token": token, origin: "https://evil.example" } });
      expect(foreign.status).toBe(403);
      const ok = await fetch(`${dash.url}/api/params`, { method: "POST", body, headers: { "x-curvealpha-token": token } });
      expect(ok.status).toBe(200);
      expect(params.get().risk.kellyFraction).toBe(0.3);
      const bad = await fetch(`${dash.url}/api/params`, { method: "POST", body: JSON.stringify({ risk: { kellyFraction: 3 } }), headers: { "x-curvealpha-token": token } });
      expect(bad.status).toBe(400);
      expect(params.get().risk.kellyFraction).toBe(0.3);
    } finally {
      dash.close();
    }
  }, 120_000);
});
