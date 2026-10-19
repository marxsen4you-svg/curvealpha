/**
 * Backup and restore of the SQLite database, which holds everything a
 * restart needs (open positions, breaker state, paper cash) and everything
 * an audit needs (decisions, fills, parameter history).
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/db.js";
import { backupDatabase, restoreDatabase } from "../src/ops/backup.js";

const fresh = () => mkdtempSync(join(tmpdir(), "ca-bak-"));

function populated(path: string, marker: string): Store {
  const s = new Store(path);
  s.kvSet("marker", marker);
  s.logDecision(1, "Mint", "size", true, "approved", { marker });
  s.run("INSERT INTO positions(mint, mode, status, opened_ms, stake_lamports, tokens, tokens_left) VALUES (?, 'paper', 'open', 1, 1000, '5', '5')", "Mint");
  return s;
}

describe("database backup", () => {
  it("copies a database in use into a consistent, verified file", () => {
    const dir = fresh();
    const live = populated(join(dir, "live.sqlite"), "A");
    live.defer(() => live.kvSet("pending", "flushed before the copy"));
    const r = backupDatabase(live, join(dir, "backup.sqlite"));
    expect(r.ok).toBe(true);
    expect(r.bytes).toBeGreaterThan(0);
    const copy = new Store(join(dir, "backup.sqlite"));
    expect(copy.kvGet("marker")).toBe("A");
    expect(copy.kvGet("pending")).toBe("flushed before the copy");
    expect(copy.get<{ n: number }>("SELECT COUNT(*) AS n FROM positions WHERE status = 'open'")!.n).toBe(1);
    copy.close();
    live.close();
  });
});

describe("database restore", () => {
  it("puts a backup in place and keeps the database it replaced", () => {
    const dir = fresh();
    populated(join(dir, "b.sqlite"), "from backup").close();
    populated(join(dir, "db.sqlite"), "current").close();
    const r = restoreDatabase(join(dir, "b.sqlite"), join(dir, "db.sqlite"), Date.now());
    expect(r.ok).toBe(true);
    const s = new Store(join(dir, "db.sqlite"));
    expect(s.kvGet("marker")).toBe("from backup");
    s.close();
    const aside = readdirSync(dir).find((f) => f.startsWith("db.sqlite.pre-restore-") && f.endsWith(".sqlite"))!;
    const old = new Store(join(dir, aside));
    expect(old.kvGet("marker")).toBe("current");
    old.close();
  });

  it("refuses a corrupt backup and leaves the current database untouched", () => {
    const dir = fresh();
    populated(join(dir, "db.sqlite"), "current").close();
    writeFileSync(join(dir, "bad.sqlite"), Buffer.alloc(8192, 7));
    const r = restoreDatabase(join(dir, "bad.sqlite"), join(dir, "db.sqlite"), Date.now());
    expect(r.ok).toBe(false);
    const s = new Store(join(dir, "db.sqlite"));
    expect(s.kvGet("marker")).toBe("current");
    s.close();
  });

  it("refuses while the engine using the database is alive", () => {
    const dir = fresh();
    populated(join(dir, "b.sqlite"), "from backup").close();
    const cur = populated(join(dir, "db.sqlite"), "current");
    const now = Date.now();
    cur.kvSet("heartbeat:paper", JSON.stringify({ atMs: now - 2_000 }));
    cur.close();
    const r = restoreDatabase(join(dir, "b.sqlite"), join(dir, "db.sqlite"), now);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/running/);
    expect(existsSync(join(dir, "db.sqlite"))).toBe(true);
  });
});
