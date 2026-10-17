import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { parsePumpEvents } from "../src/chain/events.js";
import { createEventBytes, rawTx, tradeEventBytes } from "./helpers/events.js";

describe("pump event parsing", () => {
  const mint = Keypair.generate().publicKey;
  const creator = Keypair.generate().publicKey;
  const user = Keypair.generate().publicKey;

  it("decodes create and trade events from self-CPI inner instructions", () => {
    const tx = rawTx("sig1", 100, user, [
      createEventBytes({ mint, creator, name: "Test", symbol: "TST" }),
      tradeEventBytes({ mint, user, creator, isBuy: true, sol: 500_000_000n, tokens: 17_000_000_000_000n, vS: 30_500_000_000n, vT: 1_056_000_000_000_000n, rS: 500_000_000n, rT: 776_100_000_000_000n }),
    ]);
    const evs = parsePumpEvents(tx);
    expect(evs.map((e) => e.kind)).toEqual(["create", "trade"]);
    const c = evs[0]!;
    if (c.kind !== "create") throw new Error();
    expect(c.mint).toBe(mint.toBase58());
    expect(c.symbol).toBe("TST");
    expect(c.quoteIsSol).toBe(true);
    const t = evs[1]!;
    if (t.kind !== "trade") throw new Error();
    expect(t.isBuy).toBe(true);
    expect(t.solAmount).toBe(500_000_000n);
    expect(t.virtualTokenReserves).toBe(1_056_000_000_000_000n);
    expect(t.userPreBalance).toBe(1_000_000_000n);
  });

  it("reads log-emitted events once and ignores failed transactions", () => {
    const bytes = tradeEventBytes({ mint, user, creator, isBuy: false, sol: 1n, tokens: 2n, vS: 3n, vT: 4n, rS: 5n, rT: 6n });
    const tx = rawTx("sig2", 101, user, [bytes]);
    tx.logs = [`Program data: ${bytes.subarray(8).toString("base64")}`];
    expect(parsePumpEvents(tx)).toHaveLength(1);
    expect(parsePumpEvents({ ...tx, failed: true })).toHaveLength(0);
    const logOnly = { ...tx, innerIxs: [] };
    expect(parsePumpEvents(logOnly)).toHaveLength(1);
  });

  it("skips undecodable payloads instead of guessing", () => {
    const tx = rawTx("sig3", 102, user, [Buffer.concat([tradeEventBytes({ mint, user, creator, isBuy: true, sol: 1n, tokens: 1n, vS: 1n, vT: 1n, rS: 1n, rT: 1n }).subarray(0, 30)])]);
    expect(parsePumpEvents(tx)).toHaveLength(0);
  });
});
