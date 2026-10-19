/**
 * Alpenglow candidate banks (mainnet activation epoch 1064, 21 October 2026).
 *
 * Under Alpenglow a slot can have more than one candidate bank. At processed
 * commitment the stream delivers transactions from a bank the leader later
 * abandons (UpdateParent); that bank never reaches Confirmed, and its slot is
 * confirmed through a different bank rather than reported dead. Every event
 * carries a bank_id that is a counter local to one gRPC connection.
 *
 * Before this, the token book kept per-slot indexes only: a confirmation for
 * the slot cleared every event in it, so trades that never happened (a
 * phantom creator sell, phantom buyers) stayed in the record and fed the
 * factors and the exit engine.
 *
 *  - An event from a bank that lost its slot to another bank on the same
 *    connection taints the mint, like a dead slot.
 *  - The event queue means an event can be processed after its slot was
 *    confirmed or reported dead; it must still be tainted (this race existed
 *    for dead slots before Alpenglow).
 *  - Bank ids are never compared across connections, and a provider that
 *    sends none keeps the TowerBFT behaviour exactly.
 */
import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { Keypair } from "@solana/web3.js";
import { TokenBook } from "../src/ingest/tokens.js";
import { YellowstoneIngest } from "../src/ingest/yellowstone.js";
import type { BankRef, CreateEvt, RawTx } from "../src/chain/events.js";
import { createEventBytes, rawTx } from "./helpers/events.js";
import { simulate } from "./helpers/simulate.js";

const create = (slot: number, bank?: BankRef): CreateEvt => ({
  kind: "create",
  signature: `s${slot}-${Math.random()}`,
  slot,
  receivedAtMs: 0,
  mint: Keypair.generate().publicKey.toBase58(),
  bondingCurve: "",
  creator: "C",
  user: "C",
  name: "A",
  symbol: "A",
  uri: "",
  timestampSec: 0,
  virtualTokenReserves: 1n,
  virtualSolReserves: 1n,
  realTokenReserves: 1n,
  tokenTotalSupply: 1n,
  tokenProgram: "",
  isMayhemMode: false,
  isCashbackEnabled: false,
  quoteIsSol: true,
  creatorFeeBps: 0n,
  ...(bank ? { bank } : {}),
});

const tainted = (book: TokenBook, e: CreateEvt) => book.get(e.mint)!.tainted;

describe("token book with candidate banks", () => {
  it("taints a mint whose event came from a bank that lost its slot to another bank", () => {
    const book = new TokenBook();
    const abandoned = create(100, { conn: 1, id: "7" });
    const kept = create(100, { conn: 1, id: "8" });
    book.onCreate(abandoned);
    book.onCreate(kept);
    book.onConfirmedSlot(100, { conn: 1, id: "8" });
    expect(tainted(book, abandoned)).toBe(true);
    expect(tainted(book, kept)).toBe(false);
  });

  it("taints an event from the losing bank that is processed after its slot was confirmed", () => {
    const book = new TokenBook();
    book.onConfirmedSlot(100, { conn: 1, id: "8" });
    const late = create(100, { conn: 1, id: "7" });
    const winner = create(100, { conn: 1, id: "8" });
    book.onCreate(late);
    book.onCreate(winner);
    expect(tainted(book, late)).toBe(true);
    expect(tainted(book, winner)).toBe(false);
  });

  it("taints an event processed after its slot was reported dead", () => {
    const book = new TokenBook();
    book.onDeadSlot(100);
    const late = create(100);
    const other = create(101);
    book.onCreate(late);
    book.onCreate(other);
    expect(tainted(book, late)).toBe(true);
    expect(tainted(book, other)).toBe(false);
  });

  it("never compares bank ids from different connections", () => {
    const book = new TokenBook();
    const before = create(100, { conn: 1, id: "7" });
    book.onCreate(before);
    book.onConfirmedSlot(100, { conn: 2, id: "3" });
    expect(tainted(book, before)).toBe(false);
  });

  it("keeps the TowerBFT behaviour when the provider sends no bank id", () => {
    const book = new TokenBook();
    const a = create(100);
    const b = create(101, { conn: 1, id: "4" });
    book.onCreate(a);
    book.onCreate(b);
    book.onConfirmedSlot(100);
    book.onConfirmedSlot(101);
    const c = create(102);
    book.onCreate(c);
    book.onConfirmedSlot(102, { conn: 1, id: "5" });
    expect([a, b, c].map((e) => tainted(book, e))).toEqual([false, false, false]);
  });
});

class FakeStream extends EventEmitter {
  constructor(private onRequest: (s: FakeStream) => void) {
    super();
  }
  write(req: Record<string, unknown>, cb: (err?: unknown) => void): boolean {
    cb();
    if (!req.ping) setImmediate(() => this.onRequest(this));
    return true;
  }
  pause(): void {}
  resume(): void {}
  end(): void {}
  destroy(): void {
    this.emit("close");
  }
}

function txUpdate(slot: number, sig: string, bankId: string) {
  const payer = Keypair.generate().publicKey;
  return {
    transaction: {
      slot: String(slot),
      bankId,
      transaction: {
        signature: Buffer.from(sig.padEnd(64, "x")),
        transaction: { message: { accountKeys: [payer.toBytes()] } },
        meta: { err: undefined, preBalances: ["1"], postBalances: ["1"], innerInstructions: [], logMessages: [], loadedWritableAddresses: [], loadedReadonlyAddresses: [] },
      },
    },
  };
}

describe("Yellowstone bank ids", () => {
  it("hands each transaction and slot confirmation its bank, scoped to the connection", async () => {
    let n = 0;
    class Client {
      async connect() {}
      async subscribe() {
        const i = n++;
        return new FakeStream((s) => {
          if (i === 0) {
            s.emit("data", txUpdate(100, "a", "7"));
            s.emit("data", { slot: { slot: "100", status: 1, bankId: "8" } });
            s.emit("data", txUpdate(101, "b", ""));
            s.emit("error", new Error("14 UNAVAILABLE: connection reset"));
          } else if (i === 1) {
            s.emit("data", txUpdate(102, "c", "7"));
          }
        });
      }
    }
    const mod = { default: Client, CommitmentLevel: { PROCESSED: 0 }, SlotStatus: { SLOT_CONFIRMED: 1, SLOT_DEAD: 6 } };
    const txs: RawTx[] = [];
    const confirmed: Array<[number, BankRef | undefined]> = [];
    const ing = new YellowstoneIngest(
      { endpoint: "https://grpc.invalid:443", reconnectBaseMs: () => 1, reconnectMaxMs: () => 5, fromSlotRewind: () => 32, pingIntervalSec: () => 60, loadClientModule: async () => mod },
      { onTx: (t) => txs.push(t), onDeadSlot: () => undefined, onConfirmedSlot: (s, b) => confirmed.push([s, b]), onGap: () => undefined },
    );
    void ing.start();
    const end = Date.now() + 3000;
    while (txs.length < 3 && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
    ing.stop();

    const [a, b, c] = txs;
    expect(a!.bank?.id).toBe("7");
    expect(confirmed).toEqual([[100, { conn: a!.bank!.conn, id: "8" }]]);
    expect(b!.bank).toBeUndefined(); // no bank id: TowerBFT provider
    expect(c!.bank?.id).toBe("7");
    expect(c!.bank!.conn).not.toBe(a!.bank!.conn); // same id on a new connection is a different bank
  });
});

describe("engine with candidate banks", () => {
  it("carries the bank from the transaction to the token record, so an abandoned bank taints its mints", async () => {
    const { engine } = await simulate(0);
    const creator = Keypair.generate().publicKey;
    const phantom = Keypair.generate().publicKey;
    const real = Keypair.generate().publicKey;
    engine.ingest({ ...rawTx("phantom", 9_000_000, creator, [createEventBytes({ mint: phantom, creator, name: "P", symbol: "P" })]), bank: { conn: 1, id: "7" } });
    engine.ingest({ ...rawTx("real", 9_000_000, creator, [createEventBytes({ mint: real, creator, name: "R", symbol: "R" })]), bank: { conn: 1, id: "8" } });
    engine.drain();
    engine.tokens.onConfirmedSlot(9_000_000, { conn: 1, id: "8" });
    expect(engine.tokens.get(phantom.toBase58())!.tainted).toBe(true);
    expect(engine.tokens.get(real.toBase58())!.tainted).toBe(false);
  });
});
