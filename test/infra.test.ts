import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BN from "bn.js";
import bs58 from "bs58";
import { BorshCoder } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { BoundedQueue } from "../src/ingest/queue.js";
import { RecentSet, backoffMs, toRawTx } from "../src/ingest/yellowstone.js";
import { chooseTip, parseTipFloor } from "../src/exec/tips.js";
import { buyIxs, sellIxs, burnCloseIxs, cuLimitFor, assemble, tipIx } from "../src/exec/tx.js";
import { pumpSdk } from "../src/chain/sdk.js";
import { ParamsManager } from "../src/config/manager.js";
import { Store } from "../src/store/db.js";
import { settingsProblems, loadSettings, publicSettings } from "../src/config/settings.js";
import { tradeEventBytes } from "./helpers/events.js";
import { parsePumpEvents } from "../src/chain/events.js";
import { priorityFee } from "../src/risk/costs.js";

describe("bounded queue backpressure", () => {
  it("pauses at the high-water mark, resumes at low water, drops only bulk items when full", () => {
    const pressure: boolean[] = [];
    const dropped: number[] = [];
    const q = new BoundedQueue<number>(10, (p) => pressure.push(p), (x) => dropped.push(x));
    for (let i = 0; i < 12; i++) q.push(i);
    expect(pressure).toEqual([true]);
    expect(dropped).toEqual([10, 11]);
    q.push(99, true); // priority lane is never dropped
    expect(q.poll()).toBe(99);
    for (let i = 0; i < 5; i++) q.poll();
    expect(pressure).toEqual([true, false]);
    expect(q.stats.dropped).toBe(2);
  });
});

describe("gRPC reliability helpers", () => {
  it("de-duplicates replayed signatures within the window", () => {
    const s = new RecentSet(3);
    expect(s.add("a")).toBe(true);
    expect(s.add("a")).toBe(false);
    s.add("b");
    s.add("c");
    s.add("d"); // evicts a
    expect(s.add("a")).toBe(true);
  });

  it("backs off exponentially with jitter, capped", () => {
    expect(backoffMs(0, 250, 15_000, () => 0)).toBe(125);
    expect(backoffMs(3, 250, 15_000, () => 1)).toBe(2000);
    expect(backoffMs(30, 250, 15_000, () => 1)).toBe(15_000);
  });

  it("converts a Yellowstone transaction update into a RawTx the parser reads", () => {
    const payer = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    const ev = tradeEventBytes({ mint, user: payer, creator: payer, isBuy: true, sol: 10n, tokens: 20n, vS: 30n, vT: 40n, rS: 1n, rT: 2n });
    const update = {
      slot: "123",
      transaction: {
        signature: bs58.decode("5".repeat(64)),
        isVote: false,
        transaction: { signatures: [], message: { accountKeys: [payer.toBytes(), new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P").toBytes()], instructions: [], versioned: true, addressTableLookups: [] } },
        meta: {
          err: undefined,
          preBalances: ["777", "1"],
          postBalances: ["700", "1"],
          innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 1, accounts: new Uint8Array(), data: ev }] }],
          logMessages: [],
          loadedWritableAddresses: [],
          loadedReadonlyAddresses: [],
        },
      },
    };
    const raw = toRawTx(update, 1)!;
    expect(raw.slot).toBe(123);
    const evs = parsePumpEvents(raw);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.kind === "trade" && evs[0]!.userPreBalance === 777n).toBe(true);
  });
});

describe("adaptive tipping", () => {
  const floor = parseTipFloor(
    [{ landed_tips_25th_percentile: 0.000001, landed_tips_50th_percentile: 0.0000123, landed_tips_75th_percentile: 0.00005, landed_tips_95th_percentile: 0.001, landed_tips_99th_percentile: 0.01, ema_landed_tips_50th_percentile: 0.00002 }],
    0,
  )!;

  it("parses SOL percentiles into lamports, rounding up", () => {
    expect(floor.p25).toBe(1000n);
    expect(floor.p50).toBe(12_300n);
    expect(floor.ema50).toBe(20_000n);
  });

  it("floors at the minimum and refuses when the market tip exceeds the edge budget", () => {
    expect(chooseTip(floor, "p25", 5_000n, null).tipLamports).toBe(5_000n);
    expect(chooseTip(floor, "p95", 1_000n, 500_000n).refused).toBe(true);
    expect(chooseTip(floor, "p50", 1_000n, 500_000n).tipLamports).toBe(12_300n);
    expect(chooseTip(null, "p50", 1_000n, null).refused).toBe(true);
  });
});

describe("instruction construction", () => {
  const coder = new BorshCoder(pumpSdk.pumpIdl);
  const idl = pumpSdk.pumpIdl as { instructions: Array<{ name: string; discriminator: number[]; accounts: unknown[] }> };
  const ix = (name: string) => idl.instructions.find((i) => i.name === name)!;
  const user = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;

  it("buy: idempotent ATA create, then buy_exact_quote_in_v3 with the exact amounts and the IDL's accounts", async () => {
    const ixs = await buyIxs(user, mint, TOKEN_2022_PROGRAM_ID, 12_345_678n, 987_654n);
    expect(ixs).toHaveLength(2);
    const buy = ixs[1]!;
    expect(buy.programId.toBase58()).toBe("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
    expect([...buy.data.subarray(0, 8)]).toEqual(ix("buy_exact_quote_in_v3").discriminator);
    const decoded = coder.instruction.decode(buy.data)!;
    const d = decoded.data as { spendable_quote_in: BN; min_tokens_out: BN };
    expect(d.spendable_quote_in.toString()).toBe("12345678");
    expect(d.min_tokens_out.toString()).toBe("987654");
    expect(buy.keys.length).toBeGreaterThanOrEqual(ix("buy_exact_quote_in_v3").accounts.length);
    expect(buy.keys.some((k) => k.pubkey.equals(user) && k.isSigner)).toBe(true);
  });

  it("sell: sell_v3 with min SOL out, closing the account on the final sell", async () => {
    const ixs = await sellIxs(user, mint, TOKEN_2022_PROGRAM_ID, 5_000n, 4_000n, true);
    expect(ixs).toHaveLength(2);
    expect([...ixs[0]!.data.subarray(0, 8)]).toEqual(ix("sell_v3").discriminator);
    const d = coder.instruction.decode(ixs[0]!.data)!.data as { amount: BN; min_quote_output?: BN };
    expect(d.amount.toString()).toBe("5000");
    expect(ixs[1]!.programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    expect(burnCloseIxs(user, mint, TOKEN_2022_PROGRAM_ID, 7n)).toHaveLength(2);
  });

  it("compute limit is measured plus margin, capped at 1.4 M, and the fee is charged on the limit", () => {
    expect(cuLimitFor(100_000, 0.12)).toBe(112_000);
    expect(cuLimitFor(1_390_000, 0.12)).toBe(1_400_000);
    expect(priorityFee(1_000n, 112_000n)).toBe(112n);
    const tx = assemble(user, "11111111111111111111111111111111", [tipIx(user, SystemProgram.programId, 1_000n)], 112_000, 1_000n);
    expect(tx.message.compiledInstructions).toHaveLength(3);
  });
});

describe("hot-reloadable parameters", () => {
  it("applies valid edits with an audit row and rejects invalid ones, keeping the previous set", () => {
    const dir = mkdtempSync(join(tmpdir(), "ca-"));
    const path = join(dir, "params.json");
    const store = new Store(":memory:");
    const pm = new ParamsManager(path, store);
    const before = pm.get().risk.kellyFraction;
    const p = JSON.parse(readFileSync(path, "utf8"));
    p.risk.kellyFraction = 0.25;
    writeFileSync(path, JSON.stringify(p));
    expect(pm.reload("test")).toBe(true);
    expect(pm.get().risk.kellyFraction).toBe(0.25);
    p.risk.kellyFraction = 0.9; // above the half-Kelly ceiling
    writeFileSync(path, JSON.stringify(p));
    expect(pm.reload("test")).toBe(false);
    expect(pm.get().risk.kellyFraction).toBe(0.25);
    const rows = store.all<{ accepted: number; diff: string }>("SELECT accepted, diff FROM params_audit ORDER BY id");
    expect(rows.map((r) => r.accepted)).toEqual([1, 1, 0]);
    expect(rows[1]!.diff).toContain("risk.kellyFraction");
    expect(before).not.toBe(0.25);
  });
});

describe("settings", () => {
  it("refuses unsafe setups and never exposes secrets", () => {
    const s = loadSettings({ CURVEALPHA_MODE: "live", CURVEALPHA_GRPC_TOKEN: "secret-token", CURVEALPHA_GRPC_ENDPOINT: "https://grpc.example:443/?api-key=abc" });
    const probs = settingsProblems(s);
    expect(probs.some((p) => /keypair/.test(p))).toBe(true);
    expect(probs.some((p) => /private RPC/.test(p))).toBe(true);
    const pub = JSON.stringify(publicSettings(s));
    expect(pub).not.toContain("secret-token");
    expect(pub).not.toContain("abc");
    expect(loadSettings({}).mode).toBe("paper");
  });
});
