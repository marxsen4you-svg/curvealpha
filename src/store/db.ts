/**
 * Local persistence (SQLite through node:sqlite, no native build step).
 *
 * Everything that is needed to audit or replay a decision is stored here:
 * decision logs with full inputs, shadow outcomes, positions and fills,
 * equity marks, parameter changes, survival state, and the slowly built
 * pattern stores (creators, wallets, curve trajectories).
 * High-rate writes are buffered and flushed in one transaction every 250 ms.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS token_archive (
  mint TEXT PRIMARY KEY,
  creator TEXT NOT NULL,
  symbol TEXT,
  name TEXT,
  created_ms INTEGER NOT NULL,
  completed_ms INTEGER,
  graduated INTEGER NOT NULL,
  peak_multiple REAL NOT NULL,
  time_to_peak_s REAL,
  creator_first_sell_s REAL,
  creator_self_buy INTEGER NOT NULL,
  trades INTEGER NOT NULL,
  unique_buyers INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS token_archive_creator ON token_archive(creator);
CREATE INDEX IF NOT EXISTS token_archive_created ON token_archive(created_ms);

CREATE TABLE IF NOT EXISTS corpus (
  mint TEXT PRIMARY KEY,
  created_ms INTEGER NOT NULL,
  inflow TEXT NOT NULL,
  price TEXT NOT NULL,
  max_after TEXT NOT NULL,
  graduated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS corpus_created ON corpus(created_ms);

CREATE TABLE IF NOT EXISTS wallets (
  wallet TEXT PRIMARY KEY,
  trades INTEGER NOT NULL,
  pnl_lamports INTEGER NOT NULL,
  wins INTEGER NOT NULL,
  losses INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS funders (
  wallet TEXT PRIMARY KEY,
  funder TEXT,
  fetched_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_ms INTEGER NOT NULL,
  mint TEXT,
  kind TEXT NOT NULL,
  approved INTEGER,
  summary TEXT,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS decisions_ts ON decisions(ts_ms);
CREATE INDEX IF NOT EXISTS decisions_mint ON decisions(mint);

CREATE TABLE IF NOT EXISTS shadows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  horizon_s REAL NOT NULL,
  score REAL NOT NULL,
  factors TEXT NOT NULL,
  opened_ms INTEGER NOT NULL,
  closed_ms INTEGER,
  multiple REAL,
  sell_tx_count INTEGER,
  close_reason TEXT,
  path TEXT
);
CREATE INDEX IF NOT EXISTS shadows_closed ON shadows(closed_ms);
CREATE INDEX IF NOT EXISTS shadows_score ON shadows(score);

CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  decision_id INTEGER,
  horizon_s REAL,
  score REAL,
  factors TEXT,
  opened_ms INTEGER NOT NULL,
  closed_ms INTEGER,
  stake_lamports INTEGER NOT NULL,
  tokens TEXT NOT NULL,
  tokens_left TEXT NOT NULL,
  proceeds_lamports INTEGER NOT NULL DEFAULT 0,
  fixed_cost_lamports INTEGER NOT NULL DEFAULT 0,
  close_reason TEXT
);

CREATE TABLE IF NOT EXISTS fills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id INTEGER NOT NULL,
  ts_ms INTEGER NOT NULL,
  side TEXT NOT NULL,
  lamports INTEGER NOT NULL,
  tokens TEXT NOT NULL,
  fees_lamports INTEGER NOT NULL,
  tip_lamports INTEGER NOT NULL,
  network_lamports INTEGER NOT NULL,
  signature TEXT,
  bundle_id TEXT,
  landed INTEGER NOT NULL,
  reason TEXT
);

CREATE TABLE IF NOT EXISTS equity (
  ts_ms INTEGER NOT NULL,
  equity_lamports INTEGER NOT NULL,
  cash_lamports INTEGER NOT NULL,
  mode TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tips (
  ts_ms INTEGER NOT NULL,
  p25 INTEGER, p50 INTEGER, p75 INTEGER, p95 INTEGER, p99 INTEGER, ema50 INTEGER
);

CREATE TABLE IF NOT EXISTS params_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_ms INTEGER NOT NULL,
  source TEXT NOT NULL,
  accepted INTEGER NOT NULL,
  diff TEXT NOT NULL,
  full TEXT,
  error TEXT
);
`;

type Row = Record<string, unknown>;

export class Store {
  readonly db: DatabaseSync;
  private pending: Array<() => void> = [];
  private timer: NodeJS.Timeout | null = null;
  private stmts = new Map<string, StatementSync>();

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  stmt(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) this.stmts.set(sql, (s = this.db.prepare(sql)));
    return s;
  }

  run(sql: string, ...args: Array<string | number | bigint | null>): { lastInsertRowid: number | bigint } {
    return this.stmt(sql).run(...args);
  }

  all<T = Row>(sql: string, ...args: Array<string | number | bigint | null>): T[] {
    return this.stmt(sql).all(...args) as T[];
  }

  get<T = Row>(sql: string, ...args: Array<string | number | bigint | null>): T | undefined {
    return this.stmt(sql).get(...args) as T | undefined;
  }

  /** Queue a write; flushed in one transaction. */
  defer(fn: () => void): void {
    this.pending.push(fn);
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 250);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    this.db.exec("BEGIN");
    try {
      for (const f of batch) f();
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  kvGet(key: string): string | undefined {
    return this.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", key)?.value;
  }

  kvSet(key: string, value: string): void {
    this.run("INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  /** Append a decision record; returns its id (synchronous: ids link positions to decisions). */
  logDecision(tsMs: number, mint: string | null, kind: string, approved: boolean | null, summary: string, payload: unknown): number {
    const r = this.run(
      "INSERT INTO decisions(ts_ms, mint, kind, approved, summary, payload) VALUES (?, ?, ?, ?, ?, ?)",
      tsMs,
      mint,
      kind,
      approved === null ? null : approved ? 1 : 0,
      summary,
      JSON.stringify(payload, bigintReplacer),
    );
    return Number(r.lastInsertRowid);
  }

  close(): void {
    this.flush();
    this.db.close();
  }
}

/** JSON replacer that writes bigint as a tagged string so logs round-trip exactly. */
export function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? `${v.toString()}n` : v;
}

export function bigintReviver(_k: string, v: unknown): unknown {
  return typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v;
}
