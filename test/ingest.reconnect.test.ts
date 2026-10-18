/**
 * Ingest reconnection, against a scripted Yellowstone client.
 *
 *  - A replay that fails with a message the old pattern did not recognise
 *    ("client did not read the replay in time", "failed to get replay
 *    response") was retried with the same from_slot forever: ingest stopped
 *    for good while only the reconnect counter moved.
 *  - Replayed transactions arrive with the wall-clock time of the replay,
 *    not of their block, so every timing measure (age, inflow rate,
 *    velocity) is wrong for mints they touch. Those mints must never be
 *    scored.
 *  - When a replay cannot be served, every live token has an incomplete
 *    tape, not only the ones that traded inside the rewind window.
 */
import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { Keypair } from "@solana/web3.js";
import { YellowstoneIngest } from "../src/ingest/yellowstone.js";
import { TokenBook } from "../src/ingest/tokens.js";
import type { RawTx } from "../src/chain/events.js";
import { createEventBytes, rawTx } from "./helpers/events.js";
import { simulate } from "./helpers/simulate.js";

class FakeStream extends EventEmitter {
  requests: Array<Record<string, unknown>> = [];
  constructor(private onRequest: (req: Record<string, unknown>, s: FakeStream) => void) {
    super();
  }
  write(req: Record<string, unknown>, cb: (err?: unknown) => void): boolean {
    this.requests.push(req);
    cb();
    if (!req.ping) setImmediate(() => this.onRequest(req, this));
    return true;
  }
  pause(): void {}
  resume(): void {}
  end(): void {}
  destroy(): void {
    this.emit("close");
  }
}

/** A Yellowstone transaction update for a transaction at `slot`. */
function update(slot: number, sig: string) {
  const payer = Keypair.generate().publicKey;
  return {
    transaction: {
      slot: String(slot),
      transaction: {
        signature: Buffer.from(sig.padEnd(64, "x")),
        transaction: { message: { accountKeys: [payer.toBytes()] } },
        meta: { err: undefined, preBalances: ["1"], postBalances: ["1"], innerInstructions: [], logMessages: [], loadedWritableAddresses: [], loadedReadonlyAddresses: [] },
      },
    },
  };
}

function fakeModule(script: (req: Record<string, unknown>, s: FakeStream, n: number) => void) {
  const all: Array<Record<string, unknown>> = [];
  let n = 0;
  class Client {
    async connect() {}
    async subscribe() {
      const i = n++;
      return new FakeStream((req, s) => {
        all.push(req);
        script(req, s, i);
      });
    }
  }
  return { mod: { default: Client, CommitmentLevel: { PROCESSED: 0 }, SlotStatus: { SLOT_CONFIRMED: 1, SLOT_DEAD: 6 } }, requests: all };
}

const opts = (mod: unknown) => ({
  endpoint: "https://grpc.invalid:443",
  reconnectBaseMs: () => 1,
  reconnectMaxMs: () => 5,
  fromSlotRewind: () => 32,
  pingIntervalSec: () => 60,
  loadClientModule: async () => mod,
});

const until = async (pred: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  return pred();
};

describe("ingest reconnection", () => {
  it("gives up a replay that keeps failing for any reason, continues live and records the gap", async () => {
    const gaps: Array<[number, number]> = [];
    const { mod, requests } = fakeModule((req, s, n) => {
      if (n === 0) {
        s.emit("data", update(100, "a"));
        s.emit("error", new Error("14 UNAVAILABLE: connection reset"));
      } else if (req.fromSlot !== undefined) {
        s.emit("error", new Error("13 INTERNAL: client did not read the replay in time"));
      }
      // a request without from_slot stays connected
    });
    const ing = new YellowstoneIngest(opts(mod), { onTx: () => undefined, onDeadSlot: () => undefined, onConfirmedSlot: () => undefined, onGap: (a, b) => gaps.push([a, b]) });
    void ing.start();
    try {
      expect(await until(() => gaps.length > 0)).toBe(true);
      expect(gaps[0]).toEqual([68, 100]);
      const withReplay = requests.filter((r) => r.fromSlot !== undefined).length;
      expect(withReplay).toBeLessThanOrEqual(3);
      expect(await until(() => requests.some((r, i) => i > 0 && r.fromSlot === undefined))).toBe(true);
    } finally {
      ing.stop();
    }
  });

  it("tags transactions that arrive as part of a replay", async () => {
    const got: RawTx[] = [];
    const { mod } = fakeModule((req, s, n) => {
      if (n === 0) {
        s.emit("data", update(100, "a"));
        s.emit("error", new Error("14 UNAVAILABLE: connection reset"));
      } else {
        // the replay re-sends 90..100, then the outage, then live traffic far beyond it
        s.emit("data", update(95, "b"));
        s.emit("data", update(101, "c"));
        s.emit("data", update(5_000, "d"));
      }
    });
    const ing = new YellowstoneIngest(opts(mod), { onTx: (t) => got.push(t), onDeadSlot: () => undefined, onConfirmedSlot: () => undefined, onGap: () => undefined });
    void ing.start();
    try {
      expect(await until(() => got.length === 4)).toBe(true);
      const bySlot = new Map(got.map((t) => [t.slot, t.replayed === true]));
      expect(bySlot.get(100)).toBe(false); // first connection: live
      expect(bySlot.get(95)).toBe(true);
      expect(bySlot.get(101)).toBe(true);
      expect(bySlot.get(5_000)).toBe(false);
    } finally {
      ing.stop();
    }
  });
});

describe("token book after a gap", () => {
  it("marks every live token incomplete, including ones quiet inside the rewind window", () => {
    const book = new TokenBook();
    const mk = (slot: number) => {
      const mint = Keypair.generate().publicKey.toBase58();
      book.onCreate({ kind: "create", signature: `s${slot}`, slot, receivedAtMs: 0, mint, bondingCurve: "", creator: "C", user: "C", name: "A", symbol: "A", uri: "", timestampSec: 0, virtualTokenReserves: 1n, virtualSolReserves: 1n, realTokenReserves: 1n, tokenTotalSupply: 1n, tokenProgram: "", isMayhemMode: false, isCashbackEnabled: false, quoteIsSol: true, creatorFeeBps: 0n });
      return { mint };
    };
    const quiet = mk(10);
    const active = mk(90);
    book.markGapSince(68);
    expect(book.get(active.mint)!.gap).toBe(true);
    expect(book.get(quiet.mint)!.gap).toBe(true);
  });
});

describe("engine and replayed history", () => {
  it("never scores a mint created or traded by a replayed transaction", async () => {
    const { engine } = await simulate(0);
    const mint = Keypair.generate().publicKey;
    const creator = Keypair.generate().publicKey;
    const live = Keypair.generate().publicKey;
    engine.ingest({ ...rawTx("replayed-create", 500, creator, [createEventBytes({ mint, creator, name: "Old", symbol: "OLD" })]), replayed: true });
    engine.ingest(rawTx("live-create", 600, creator, [createEventBytes({ mint: live, creator, name: "New", symbol: "NEW" })]));
    engine.drain();
    expect(engine.tokens.get(mint.toBase58())!.gap).toBe(true);
    expect(engine.tokens.get(live.toBase58())!.gap).toBe(false);
  });
});
