/**
 * Local dashboard: live state over Server-Sent Events, plus the two operator
 * actions that change behaviour (parameter edits and clearing a halt).
 *
 * It binds to 127.0.0.1 only. Because any web page in the operator's browser
 * can send requests to localhost, every state-changing request must carry a
 * per-process token in a custom header (which cross-origin pages cannot set
 * without a CORS preflight this server never approves) and a loopback Origin.
 *
 * Every request must also name a loopback Host. Without that check a DNS
 * rebinding page (attacker.example re-pointed at 127.0.0.1) is same-origin
 * with the dashboard in the browser: it could read the page, take the token
 * and send matching Host and Origin headers.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Engine } from "../engine.js";
import type { ParamsManager } from "../config/manager.js";
import { publicSettings, type Settings } from "../config/settings.js";
import type { YellowstoneIngest } from "../ingest/yellowstone.js";
import type { TipOracle } from "../exec/tips.js";
import type { Store } from "../store/db.js";
import type { EvaluationReport } from "../meta/evaluate.js";
import { evaluateAsync } from "../meta/evaluateAsync.js";
import { assessHealth } from "../ops/health.js";
import { ratioToNumber } from "../math/curve.js";

const here = dirname(fileURLToPath(import.meta.url));

const json = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? Number(v) : v));

export interface DashboardDeps {
  engine: Engine;
  params: ParamsManager;
  settings: Settings;
  ingest: YellowstoneIngest | null;
  tips: TipOracle;
  store: Store;
}

export function startDashboard(d: DashboardDeps): { url: string; close: () => void } {
  const token = randomBytes(18).toString("hex");
  const html = readFileSync(join(here, "public", "index.html"), "utf8").replace("__CURVEALPHA_TOKEN__", token);
  let report: { at: number; r: EvaluationReport } | null = null;
  let reportPending = false;
  let reportError: string | null = null;
  // the report is computed off the event loop and shown when it arrives; a request never waits for it
  const refreshReport = (now: number) => {
    if (reportPending || (report && now - report.at < 300_000)) return;
    reportPending = true;
    evaluateAsync(d.store, d.params.get(), now)
      .then((r) => {
        report = { at: Date.now(), r };
        reportError = null;
      })
      .catch((e) => {
        reportError = e instanceof Error ? e.message : String(e);
        report = report ? { ...report, at: Date.now() } : null; // back off for the interval before retrying
      })
      .finally(() => {
        reportPending = false;
      });
  };

  const state = () => {
    const e = d.engine;
    const now = Date.now();
    refreshReport(now);
    const lat = [...e.scoreLatency].sort((a, b) => a - b);
    const pct = (q: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(q * lat.length))]! : null);
    // 400 points over the week: the last mark at or before each bucket edge, one index seek each
    // (measured: 4 ms on 302 400 marks, against 112 ms reading them all)
    const since = now - 7 * 86_400_000;
    const bucketMs = Math.ceil((7 * 86_400_000) / 400);
    const equity: Array<{ ts_ms: number; equity_lamports: number }> = [];
    for (let k = 1; k <= 400; k++) {
      const r = d.store.get<{ ts_ms: number; equity_lamports: number }>(
        "SELECT ts_ms, equity_lamports FROM equity WHERE mode = ? AND ts_ms <= ? ORDER BY ts_ms DESC LIMIT 1",
        d.settings.mode,
        Math.min(now, since + k * bucketMs),
      );
      if (r && r.ts_ms >= since && r.ts_ms !== equity[equity.length - 1]?.ts_ms) equity.push(r);
    }
    return {
      now,
      settings: publicSettings(d.settings),
      survival: e.survivalSnapshot(),
      threshold: e.survival.threshold(now),
      counters: e.counters,
      queue: e.queue.stats,
      ingest: d.ingest?.status ?? null,
      scoreLatencyMs: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99) },
      tokensTracked: e.tokens.tokens.size,
      shadowsOpen: e.shadows.openCount,
      corpus: e.corpus.entries.length,
      smartWallets: e.smart.top.size,
      tipFloor: d.tips.floor,
      tipHistory: d.tips.history.slice(-120).map((t) => ({ t: t.atMs, p50: t.p50, p75: t.p75, p95: t.p95, ema50: t.ema50 })),
      feeTiers: e.market.schedule.feeTiers.slice(0, 3),
      feed: e.feed.slice(0, 80),
      positions: [...e.positions.positions.values()].map((p) => ({
        id: p.id,
        mint: p.mint,
        symbol: p.symbol,
        score: p.score,
        horizon: p.horizon,
        stakeSol: Number(p.state.stakeLamports) / 1e9,
        valueSol: Number(p.lastValueLamports) / 1e9,
        realizedSol: Number(p.state.realizedLamports) / 1e9,
        multiple: p.state.remainingTokens > 0n ? ratioToNumber(p.lastValueLamports * p.state.initialTokens, p.state.stakeLamports * p.state.remainingTokens) : null,
        ageSec: (now - p.openedAtMs) / 1000,
        rungs: p.state.tpDone,
        fixedCostSol: Number(p.fixedCostLamports) / 1e9,
      })),
      closed: e.positions.closed.slice(0, 30).map((p) => ({
        mint: p.mint,
        symbol: p.symbol,
        pnlSol: Number(p.state.realizedLamports - p.state.stakeLamports - p.fixedCostLamports) / 1e9,
        reason: p.closeReason,
      })),
      equity: equity.map((r) => [r.ts_ms, r.equity_lamports / 1e9]),
      params: d.params.get(),
      paramsVersion: d.params.version,
      paramsError: d.params.lastError,
      evaluation: report?.r ?? null,
      evaluationPending: reportPending,
      evaluationError: reportError,
    };
  };
  // every client and the event stream share one state snapshot per second
  let snapshot: { at: number; body: string } | null = null;
  const stateJson = () => {
    const now = Date.now();
    if (!snapshot || now - snapshot.at >= 1000) snapshot = { at: now, body: json(state()) };
    return snapshot.body;
  };

  // the port is not part of the check: an SSH tunnel may map the dashboard to any local port
  const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/;
  const hostAllowed = (req: IncomingMessage) => LOOPBACK.test((req.headers.host ?? "").toLowerCase());
  const authorized = (req: IncomingMessage) => {
    const origin = req.headers.origin?.toLowerCase();
    const originOk = !origin || (origin.startsWith("http://") && LOOPBACK.test(origin.slice("http://".length)));
    return req.headers["x-curvealpha-token"] === token && originOk;
  };

  const body = (req: IncomingMessage): Promise<string> =>
    new Promise((res, rej) => {
      let b = "";
      req.on("data", (c) => {
        b += c;
        if (b.length > 1_000_000) rej(new Error("body too large"));
      });
      req.on("end", () => res(b));
      req.on("error", rej);
    });

  const SECURITY_HEADERS = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "content-security-policy":
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  };
  const send = (res: ServerResponse, code: number, payload: string, type = "application/json") => {
    res.writeHead(code, { "content-type": type, ...SECURITY_HEADERS });
    res.end(payload);
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!hostAllowed(req)) return send(res, 421, json({ error: "the dashboard answers loopback host names only" }));
    try {
      if (req.method === "GET" && url.pathname === "/") return send(res, 200, html, "text/html; charset=utf-8");
      if (req.method === "GET" && url.pathname === "/api/state") return send(res, 200, stateJson());
      if (req.method === "GET" && url.pathname === "/api/health") {
        const hb = d.engine.heartbeat();
        return send(res, 200, json({ ...assessHealth(hb, d.engine.now()), heartbeat: hb }));
      }
      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "text/event-stream", connection: "keep-alive" });
        const push = () => res.write(`data: ${stateJson()}\n\n`);
        push();
        const t = setInterval(push, 1000);
        req.on("close", () => clearInterval(t));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/decisions") {
        const asked = Math.floor(Number(url.searchParams.get("limit") ?? 100));
        const limit = Number.isFinite(asked) && asked > 0 ? Math.min(500, asked) : 100;
        return send(res, 200, json(d.store.all("SELECT id, ts_ms, mint, kind, approved, summary FROM decisions ORDER BY id DESC LIMIT ?", limit)));
      }
      if (req.method === "POST" && url.pathname === "/api/params") {
        if (!authorized(req)) return send(res, 403, json({ ok: false, error: "forbidden" }));
        const r = d.params.update(JSON.parse(await body(req)), "dashboard");
        return send(res, r.ok ? 200 : 400, json(r));
      }
      if (req.method === "POST" && url.pathname === "/api/halt/clear") {
        if (!authorized(req)) return send(res, 403, json({ ok: false, error: "forbidden" }));
        d.engine.survival.clearHalt();
        d.store.logDecision(Date.now(), null, "operator", null, "halt cleared from dashboard", {});
        return send(res, 200, json({ ok: true }));
      }
      send(res, 404, json({ error: "not found" }));
    } catch (e) {
      send(res, 500, json({ error: e instanceof Error ? e.message : String(e) }));
    }
  });
  server.listen(d.settings.dashboardPort, d.settings.dashboardHost);
  return { url: `http://${d.settings.dashboardHost}:${d.settings.dashboardPort}`, close: () => server.close() };
}
