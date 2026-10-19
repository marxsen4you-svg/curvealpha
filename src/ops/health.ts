/**
 * Health. The running engine writes a heartbeat every two seconds (to the
 * database and to the dashboard); `curvealpha status`, /api/health and the
 * engine's own alert log judge it with assessHealth. A judgement is either
 * ok, degraded (running, but something needs attention) or down.
 *
 * Alerts are raised when a problem appears and reported again when it
 * clears, not on every tick, so the log stays readable.
 */
import type { SurvivalMode } from "../risk/survival.js";

export interface Heartbeat {
  atMs: number;
  mode: "paper" | "live";
  /** Null when the engine runs without a live feed (tests, replays). */
  ingest: { connected: boolean; lastMessageAtMs: number; lastSlot: number; reconnects: number; gaps: number } | null;
  queue: { depth: number; dropped: number };
  survival: { mode: SurvivalMode; haltReason: string | null };
  positions: { open: number; unmanaged: number };
  store: { writeErrors: number };
  eventLoopP99Ms: number | null;
  tipFloorAtMs: number | null;
}

export interface HealthThresholds {
  heartbeatMaxAgeMs: number;
  feedSilentMs: number;
  tipFloorMaxAgeMs: number;
  eventLoopP99Ms: number;
}

export const DEFAULT_THRESHOLDS: HealthThresholds = {
  heartbeatMaxAgeMs: 15_000,
  feedSilentMs: 30_000,
  tipFloorMaxAgeMs: 60_000,
  eventLoopP99Ms: 200,
};

export type HealthStatus = "ok" | "degraded" | "down";

interface Problem {
  key: string;
  message: string;
}

const secs = (ms: number) => Math.round(ms / 1000);

function problems(hb: Heartbeat | null, nowMs: number, t: HealthThresholds): { down: boolean; list: Problem[] } {
  if (!hb) return { down: true, list: [{ key: "engine down", message: "no heartbeat: the engine is not running" }] };
  const age = nowMs - hb.atMs;
  if (age > t.heartbeatMaxAgeMs) return { down: true, list: [{ key: "engine down", message: `heartbeat ${secs(age)} s old: the engine is not running or is stuck` }] };
  const list: Problem[] = [];
  if (hb.ingest) {
    if (!hb.ingest.connected) list.push({ key: "feed disconnected", message: `feed disconnected (${hb.ingest.reconnects} reconnects)` });
    else if (nowMs - hb.ingest.lastMessageAtMs > t.feedSilentMs) list.push({ key: "feed silent", message: `feed silent for ${secs(nowMs - hb.ingest.lastMessageAtMs)} s` });
  }
  if (hb.survival.mode === "HALTED") list.push({ key: "halted", message: `halted: ${hb.survival.haltReason ?? "no reason recorded"}` });
  if (hb.positions.unmanaged > 0) list.push({ key: "unmanaged positions", message: `${hb.positions.unmanaged} open position(s) without a readable curve (exits not running)` });
  if (hb.store.writeErrors > 0) list.push({ key: "write errors", message: `${hb.store.writeErrors} failed database write(s)` });
  if (hb.tipFloorAtMs === null || nowMs - hb.tipFloorAtMs > t.tipFloorMaxAgeMs) {
    list.push({ key: "tip floor stale", message: hb.tipFloorAtMs === null ? "no tip floor yet (entries refused)" : `tip floor ${secs(nowMs - hb.tipFloorAtMs)} s old (entries refused)` });
  }
  if (hb.eventLoopP99Ms !== null && hb.eventLoopP99Ms > t.eventLoopP99Ms) list.push({ key: "event loop slow", message: `event loop p99 ${Math.round(hb.eventLoopP99Ms)} ms` });
  return { down: false, list };
}

export function assessHealth(hb: Heartbeat | null, nowMs: number, t: HealthThresholds = DEFAULT_THRESHOLDS): { status: HealthStatus; problems: string[] } {
  const p = problems(hb, nowMs, t);
  return { status: p.down ? "down" : p.list.length ? "degraded" : "ok", problems: p.list.map((x) => x.message) };
}

/** Logs a problem once when it appears and once when it clears. */
export class HealthWatcher {
  private active = new Set<string>();
  constructor(
    private log: (level: "ALERT" | "RESOLVED", message: string) => void,
    private t: HealthThresholds = DEFAULT_THRESHOLDS,
  ) {}

  observe(hb: Heartbeat | null, nowMs: number): void {
    const now = new Map(problems(hb, nowMs, this.t).list.map((p) => [p.key, p.message]));
    for (const [key, message] of now) if (!this.active.has(key)) this.log("ALERT", message);
    for (const key of this.active) if (!now.has(key)) this.log("RESOLVED", key);
    this.active = new Set(now.keys());
  }
}
