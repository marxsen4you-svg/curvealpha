/**
 * Crash recovery.
 *
 * Open positions lived only in memory. After a crash or restart (systemd
 * restarts the service on any exit) their tokens stayed in the wallet with
 * nothing managing them: no exits, no stop loss, not counted in equity or in
 * the concurrency limit. In paper mode the stake simply vanished from the
 * ledger. A restart must restore every open position from the database,
 * re-read its curve, and carry on managing it to the close, with the paper
 * ledger still balancing to the lamport across the crash.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/db.js";
import type { AdoptedCurve } from "../src/engine.js";
import type { TokenBook } from "../src/ingest/tokens.js";
import { Sim } from "./helpers/simulate.js";

const snapshot = (e: Sim["engine"]) =>
  [...e.positions.positions.values()].map((p) => ({ id: p.id, mint: p.mint, remaining: p.state.remainingTokens, stake: p.state.stakeLamports, tpDone: [...p.state.tpDone] }));

/** The chain outlives the process: curves are read back from the crashed engine's book, as an RPC read would. */
const chainReader = (book: TokenBook) => async (mint: string): Promise<AdoptedCurve | null> => {
  const r = book.get(mint);
  return r ? { curve: r.curve, creator: r.creator, tokenProgram: r.tokenProgram, symbol: r.symbol, slot: r.lastSlot } : null;
};

async function crashWithOpenPosition() {
  const path = join(mkdtempSync(join(tmpdir(), "ca-restart-")), "db.sqlite");
  const s = new Sim();
  await s.tips.refresh();
  const a = s.boot(new Store(path));
  expect(await s.runUntil(() => a.positions.positions.size > 0, 40)).toBe(true);
  const before = snapshot(a);
  const cashAtCrash = s.paper.cash;
  const chain = a.tokens;
  s.store.db.close(); // the crash: nothing pending is flushed
  return { s, path, before, cashAtCrash, chain };
}

describe("restart recovery", () => {
  it("restores open positions after a crash and manages them to the close, with the paper ledger exact", async () => {
    const { s, path, before, cashAtCrash, chain } = await crashWithOpenPosition();

    const b = s.boot(new Store(path));
    expect(s.paper.cash).toBe(cashAtCrash);
    const r = await b.restorePositions(chainReader(chain));
    expect(r).toEqual({ restored: before.length, unmanaged: 0 });
    expect(snapshot(b)).toEqual(before);
    expect(b.survivalSnapshot().openPositions).toBe(before.length);
    expect(b.positions.heldValue()).toBeGreaterThan(0n);

    // the new engine trades on, and its exit engine closes what it inherited
    expect(await s.runUntil(() => before.every((x) => !b.positions.positions.has(x.id)), 15)).toBe(true);
    s.store.flush();
    for (const x of before) {
      expect(s.store.get<{ status: string }>("SELECT status FROM positions WHERE id = ?", x.id)!.status).toBe("closed");
    }

    // paper ledger across the crash: start, minus every outflow, plus every inflow, to the lamport
    const fills = s.store.all<{ side: string; lamports: number; tip_lamports: number; network_lamports: number }>("SELECT side, lamports, tip_lamports, network_lamports FROM fills");
    const opened = s.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM positions")!.n;
    const closed = s.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM positions WHERE status = 'closed'")!.n;
    let expected = s.start;
    for (const f of fills) {
      expected += f.side === "buy" ? -BigInt(f.lamports) : f.side === "sell" ? BigInt(f.lamports) : 0n;
      expected -= BigInt(f.tip_lamports) + BigInt(f.network_lamports);
    }
    expected += BigInt(closed - opened) * 2_074_080n;
    expect(s.paper.cash).toBe(expected);
  }, 600_000);

  it("trusts the wallet over the database: a sell that landed but was never recorded is reconciled on restore", async () => {
    const { s, path, before, chain } = await crashWithOpenPosition();
    const [first, ...rest] = before;
    // the wallet holds a third of the first position's tokens and none of the others
    const held = new Map<string, bigint>([[first!.mint, first!.remaining / 3n]]);
    const b = s.boot(new Store(path), (paper) => ({
      mode: paper.mode,
      buy: (o) => paper.buy(o),
      sell: (o) => paper.sell(o),
      burnClose: (...a) => paper.burnClose(...a),
      spendableLamports: () => paper.spendableLamports(),
      holdingsOf: async (mint) => held.get(mint) ?? 0n,
    }));
    await b.restorePositions(chainReader(chain));
    expect(b.positions.positions.get(first!.id)!.state.remainingTokens).toBe(first!.remaining / 3n);
    for (const x of rest) expect(b.positions.positions.has(x.id)).toBe(false);
    const recon = s.store.all<{ summary: string }>("SELECT summary FROM decisions WHERE kind = 'reconcile'");
    expect(recon.length).toBe(before.length);
  }, 600_000);

  it("keeps a position whose curve cannot be read as unmanaged, still counted, and adopts it on a later retry", async () => {
    const { s, path, before, chain } = await crashWithOpenPosition();
    const b = s.boot(new Store(path));
    let rpcUp = false;
    const read = chainReader(chain);
    const r = await b.restorePositions(async (m) => (rpcUp ? read(m) : null));
    expect(r).toEqual({ restored: before.length, unmanaged: before.length });
    expect(b.survivalSnapshot().openPositions).toBe(before.length);
    expect(b.positions.unmanaged()).toEqual(before.map((x) => x.mint));
    rpcUp = true;
    expect(await b.retryAdoptions()).toBe(before.length);
    expect(b.positions.unmanaged()).toEqual([]);
  }, 600_000);
});
