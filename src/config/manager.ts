/**
 * Live parameter store: reads data/params.json, watches it, validates every
 * edit against the schema, applies valid edits on the next decision and
 * records every attempt (accepted or rejected) in the audit trail.
 */
import { existsSync, readFileSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { DEFAULT_PARAMS, diffParams, resolveParams, type Params } from "./params.js";
import type { Store } from "../store/db.js";

export class ParamsManager {
  private current: Params;
  private watcher: FSWatcher | null = null;
  private debounce: NodeJS.Timeout | null = null;
  lastError: string | null = null;
  version = 0;

  constructor(private path: string, private store: Store, private onChange: (p: Params) => void = () => undefined) {
    if (!existsSync(path)) writeFileSync(path, JSON.stringify(DEFAULT_PARAMS, null, 2) + "\n");
    this.current = resolveParams(JSON.parse(readFileSync(path, "utf8")));
    this.audit("startup", true, diffParams(DEFAULT_PARAMS, this.current), null);
  }

  get = (): Params => this.current;

  watch(): void {
    this.watcher = watch(this.path, () => {
      if (this.debounce) clearTimeout(this.debounce);
      this.debounce = setTimeout(() => this.reload("file"), 150);
    });
  }

  stop(): void {
    this.watcher?.close();
  }

  reload(source: string): boolean {
    let next: Params;
    try {
      next = resolveParams(JSON.parse(readFileSync(this.path, "utf8")));
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.audit(source, false, [], this.lastError);
      return false;
    }
    return this.apply(next, source);
  }

  /** Apply a full or partial override (dashboard edits come through here). */
  update(override: unknown, source: string): { ok: boolean; error?: string } {
    let next: Params;
    try {
      next = resolveParams(deepMerge(this.current, override));
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.audit(source, false, [], this.lastError);
      return { ok: false, error: this.lastError };
    }
    this.apply(next, source);
    writeFileSync(this.path, JSON.stringify(next, null, 2) + "\n");
    return { ok: true };
  }

  private apply(next: Params, source: string): boolean {
    const diff = diffParams(this.current, next);
    if (diff.length === 0) return true;
    this.current = next;
    this.version++;
    this.lastError = null;
    this.audit(source, true, diff, null);
    this.onChange(next);
    return true;
  }

  private audit(source: string, accepted: boolean, diff: unknown, error: string | null): void {
    this.store.run(
      "INSERT INTO params_audit(ts_ms, source, accepted, diff, full, error) VALUES (?, ?, ?, ?, ?, ?)",
      Date.now(),
      source,
      accepted ? 1 : 0,
      JSON.stringify(diff),
      accepted ? JSON.stringify(this.current) : null,
      error,
    );
  }
}

function deepMerge(base: unknown, over: unknown): unknown {
  if (over === undefined) return base;
  if (base && over && typeof base === "object" && typeof over === "object" && !Array.isArray(base) && !Array.isArray(over)) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [k, v] of Object.entries(over as Record<string, unknown>)) out[k] = deepMerge(out[k], v);
    return out;
  }
  return over;
}
