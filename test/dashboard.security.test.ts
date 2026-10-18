/**
 * DNS rebinding: a page on attacker.example whose DNS later points at
 * 127.0.0.1 is same-origin with the dashboard from the browser's point of
 * view. It sends Host and Origin headers naming its own domain, so an
 * Origin === Host check passes. The dashboard must refuse any request whose
 * Host is not a loopback name, before serving the page (which carries the
 * write token) or any state.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { request } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDashboard } from "../src/dashboard/server.js";
import { ParamsManager } from "../src/config/manager.js";
import { loadSettings } from "../src/config/settings.js";
import { TipOracle } from "../src/exec/tips.js";
import { simulate } from "./helpers/simulate.js";

function raw(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

describe("dashboard host validation (DNS rebinding)", () => {
  let dash: { url: string; close: () => void };
  let params: ParamsManager;
  let port: number;
  let token: string;

  beforeAll(async () => {
    const { engine, store } = await simulate(1);
    params = new ParamsManager(join(mkdtempSync(join(tmpdir(), "ca-")), "params.json"), store);
    port = 19_000 + Math.floor(Math.random() * 900);
    dash = startDashboard({ engine, params, settings: { ...loadSettings({}), grpcEndpoint: "sim", dashboardPort: port }, ingest: null, tips: new TipOracle(), store });
    await new Promise((r) => setTimeout(r, 100));
    const page = await raw(port, "GET", "/", { host: `127.0.0.1:${port}` });
    token = /name="curvealpha-token" content="([0-9a-f]+)"/.exec(page.body)![1]!;
  }, 60_000);
  afterAll(() => dash.close());

  it("does not serve the page or its write token to a rebound hostname", async () => {
    const r = await raw(port, "GET", "/", { host: `attacker.example:${port}` });
    expect(r.status).toBe(421);
    expect(r.body).not.toContain(token);
  });

  it("does not serve live state to a rebound hostname", async () => {
    for (const path of ["/api/state", "/api/decisions", "/api/events"]) {
      const r = await raw(port, "GET", path, { host: `attacker.example:${port}` });
      expect(r.status).toBe(421);
    }
  });

  it("refuses a parameter change from a rebound page even with the token and a matching Origin", async () => {
    const before = params.get().risk.kellyFraction;
    const r = await raw(
      port,
      "POST",
      "/api/params",
      { host: `attacker.example:${port}`, origin: `http://attacker.example:${port}`, "x-curvealpha-token": token, "content-type": "application/json" },
      JSON.stringify({ risk: { kellyFraction: 0.5 } }),
    );
    expect(r.status).toBe(421);
    expect(params.get().risk.kellyFraction).toBe(before);
  });

  it("still serves loopback names, on any port an SSH tunnel maps it to", async () => {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, "localhost:8000", "127.0.0.1"]) {
      const r = await raw(port, "GET", "/api/state", { host });
      expect(r.status).toBe(200);
    }
  });

  it("answers a malformed decisions limit instead of failing", async () => {
    const r = await raw(port, "GET", "/api/decisions?limit=abc", { host: `127.0.0.1:${port}` });
    expect(r.status).toBe(200);
    expect(Array.isArray(JSON.parse(r.body))).toBe(true);
  });

  it("forbids framing so the parameter editor cannot be clickjacked", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy") ?? "").toContain("frame-ancestors 'none'");
  });
});
