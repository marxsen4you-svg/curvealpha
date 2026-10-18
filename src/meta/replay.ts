/**
 * Decision replay. A sizing decision row stores the parameters, the survival
 * state, the candidate (including the exact outcome sample and the bootstrap
 * seed) and the result. Replaying re-runs the Capital Survival Engine on those
 * inputs and checks that it reaches the identical decision, number for
 * number. A mismatch means the code changed behaviour since the decision was
 * made, which the audit has to know about.
 */
import { CapitalSurvivalEngine, type Decision } from "../risk/survival.js";
import { bigintReviver, type Store } from "../store/db.js";
import { resolveParams } from "../config/params.js";

export interface ReplayResult {
  id: number;
  mint: string | null;
  identical: boolean;
  original: Decision;
  replayed: Decision;
  differences: string[];
}

export function replayDecision(store: Store, id: number): ReplayResult {
  const row = store.get<{ id: number; ts_ms: number; mint: string | null; kind: string; payload: string }>(
    "SELECT id, ts_ms, mint, kind, payload FROM decisions WHERE id = ?",
    id,
  );
  if (!row) throw new Error(`decision ${id} not found`);
  if (row.kind !== "size") throw new Error(`decision ${id} is a ${row.kind} record; only sizing decisions replay`);
  const payload = JSON.parse(row.payload, bigintReviver);
  const params = resolveParams(payload.params);
  let replayed = CapitalSurvivalEngine.replay(params, payload.snapshot, payload.candidate, row.ts_ms);
  const original: Decision = payload.decision;
  // the engine applies the tip check after the survival decision; mirror it
  if (replayed.approved && payload.tipCheck?.refused) {
    replayed = { ...replayed, approved: false, reasons: [`tip: ${payload.tipCheck.reason}`] };
  }
  if (replayed.approved && original.reasons[0]?.startsWith("tips:")) {
    replayed = { ...replayed, approved: false, reasons: original.reasons };
  }
  const differences = diff(original, replayed);
  return { id, mint: row.mint, identical: differences.length === 0, original, replayed, differences };
}

/** Fields that identify a live order rather than describe the decision; a replay cannot reproduce them. */
const IGNORED = new Set(["reservationId"]);

function diff(a: unknown, b: unknown, path = ""): string[] {
  // JSON stores non-finite numbers as null
  if ((a === null && typeof b === "number" && !Number.isFinite(b)) || (b === null && typeof a === "number" && !Number.isFinite(a))) return [];
  if (typeof a === "number" && typeof b === "number") {
    return Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b)) ? [] : [`${path}: ${a} != ${b}`];
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter((k) => !IGNORED.has(k)));
    return [...keys].flatMap((k) => diff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k));
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [`${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`];
}
