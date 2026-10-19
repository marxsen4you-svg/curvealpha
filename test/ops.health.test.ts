/**
 * Health: the engine writes a heartbeat every two seconds; `curvealpha
 * status` and the dashboard's /api/health judge it. The judgement is a pure
 * function, checked here on literal heartbeats, and alerts fire on changes
 * (a problem that appears, a problem that clears), not on every tick.
 */
import { describe, expect, it } from "vitest";
import { assessHealth, HealthWatcher, type Heartbeat } from "../src/ops/health.js";

const NOW = 10_000_000;
const healthy: Heartbeat = {
  atMs: NOW - 1_000,
  mode: "paper",
  ingest: { connected: true, lastMessageAtMs: NOW - 400, lastSlot: 458_000_000, reconnects: 0, gaps: 0 },
  queue: { depth: 0, dropped: 0 },
  survival: { mode: "NORMAL", haltReason: null },
  positions: { open: 1, unmanaged: 0 },
  store: { writeErrors: 0 },
  eventLoopP99Ms: 12,
  tipFloorAtMs: NOW - 5_000,
};

describe("health assessment", () => {
  it("a fresh heartbeat with a live feed is ok", () => {
    expect(assessHealth(healthy, NOW)).toEqual({ status: "ok", problems: [] });
  });

  it("no heartbeat, or an old one, means the engine is down", () => {
    expect(assessHealth(null, NOW).status).toBe("down");
    const r = assessHealth({ ...healthy, atMs: NOW - 20_000 }, NOW);
    expect(r.status).toBe("down");
    expect(r.problems[0]).toMatch(/heartbeat 20 s old/);
  });

  it("a silent or disconnected feed degrades", () => {
    expect(assessHealth({ ...healthy, ingest: { ...healthy.ingest!, lastMessageAtMs: NOW - 45_000 } }, NOW).problems).toEqual(["feed silent for 45 s"]);
    expect(assessHealth({ ...healthy, ingest: { ...healthy.ingest!, connected: false } }, NOW).problems).toEqual(["feed disconnected (0 reconnects)"]);
  });

  it("a halt, an unmanaged position, failed writes, a stale tip floor or a slow event loop each degrade", () => {
    const r = assessHealth(
      {
        ...healthy,
        survival: { mode: "HALTED", haltReason: "daily loss 12.00% hit the 12.0% limit" },
        positions: { open: 2, unmanaged: 1 },
        store: { writeErrors: 3 },
        tipFloorAtMs: NOW - 120_000,
        eventLoopP99Ms: 450,
      },
      NOW,
    );
    expect(r.status).toBe("degraded");
    expect(r.problems).toEqual([
      "halted: daily loss 12.00% hit the 12.0% limit",
      "1 open position(s) without a readable curve (exits not running)",
      "3 failed database write(s)",
      "tip floor 120 s old (entries refused)",
      "event loop p99 450 ms",
    ]);
  });
});

describe("alerts on change", () => {
  it("raises a problem once when it appears and reports it once when it clears", () => {
    const lines: string[] = [];
    const w = new HealthWatcher((level, msg) => lines.push(`${level} ${msg}`));
    const silent = { ...healthy, ingest: { ...healthy.ingest!, lastMessageAtMs: NOW - 45_000 } };
    w.observe(healthy, NOW);
    w.observe(silent, NOW);
    w.observe(silent, NOW + 2_000);
    w.observe({ ...healthy, atMs: NOW + 3_000, ingest: { ...healthy.ingest!, lastMessageAtMs: NOW + 2_900 } }, NOW + 4_000);
    expect(lines).toEqual(["ALERT feed silent for 45 s", "RESOLVED feed silent"]);
  });
});
