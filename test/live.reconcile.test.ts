/**
 * Live execution accounting, against a scripted RPC and block engine.
 *
 * Nothing here touches a network or a funded key: the connection and the
 * bundle client are fakes that follow the real response shapes, and the
 * signer is a throwaway keypair.
 *
 * What was wrong:
 *  - getTransaction returning null right after confirmation (RPC indexing
 *    lag) was read as a post-balance of 0: the whole wallet was recorded as
 *    spent, with 0 tokens.
 *  - a bundle that landed after the polling deadline was reported as failed,
 *    so its tokens were never tracked. A transaction can land until its
 *    blockhash expires; only after that is "did not land" a fact.
 *  - a transient RPC error while polling threw out of the order.
 *  - ATA rent was assumed (170 bytes, always newly created) instead of read
 *    from the token account's actual balance change.
 */
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { LiveExecutor } from "../src/exec/executor.js";
import { userAta } from "../src/exec/tx.js";
import { DEFAULT_PARAMS } from "../src/config/params.js";
import type { BundleClient } from "../src/exec/jito.js";

const user = Keypair.generate();
const mint = Keypair.generate().publicKey;
const ata = userAta(user.publicKey, mint, TOKEN_2022_PROGRAM_ID);
const tipAccount = Keypair.generate().publicKey;
const LAST_VALID = 1_000;

interface Script {
  /** status returned on each poll, in order; the last repeats */
  statuses: Array<"none" | "processed" | "confirmed" | "error" | "throw">;
  /** getTransaction results, in order; the last repeats */
  txs: Array<"null" | "tx">;
  /** wallet SOL before, and after the transaction lands */
  preSol: bigint;
  postSol: bigint;
  /** token account balance before and after, and its lamports before and after */
  preTokens: bigint | null;
  postTokens: bigint;
  ataLamportsPre: bigint;
  ataLamportsPost: bigint;
  fee: bigint;
  /** the transaction is visible on chain (balances moved) from this poll on */
  landsAtPoll: number;
}

function fakes(s: Script) {
  const calls = { polls: 0, blockHeightAtVerdict: 0, sends: 0 };
  let height = LAST_VALID - 20;
  const landed = () => calls.polls >= s.landsAtPoll;
  const conn = {
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: LAST_VALID }),
    simulateTransaction: async () => ({ value: { unitsConsumed: 80_000, err: null, logs: [] } }),
    getBlockHeight: async () => (height += 4),
    getBalance: async () => Number(landed() ? s.postSol : s.preSol),
    getTokenAccountBalance: async (pk: PublicKey) => {
      if (!pk.equals(ata)) throw new Error("unexpected account");
      const amount = landed() ? s.postTokens : s.preTokens;
      if (amount === null) throw new Error("could not find account");
      return { context: { slot: 1 }, value: { amount: amount.toString(), decimals: 6, uiAmount: null } };
    },
    getMinimumBalanceForRentExemption: async () => 1_513_840,
    getAccountInfo: async (pk: PublicKey) => {
      if (!pk.equals(ata)) return null;
      const lamports = landed() ? s.ataLamportsPost : s.ataLamportsPre;
      return lamports === 0n ? null : { lamports: Number(lamports), owner: TOKEN_2022_PROGRAM_ID, data: Buffer.alloc(170), executable: false };
    },
    getSignatureStatuses: async () => {
      const st = s.statuses[Math.min(calls.polls, s.statuses.length - 1)]!;
      calls.polls++;
      calls.blockHeightAtVerdict = height;
      if (st === "throw") throw new Error("fetch failed");
      if (st === "none") return { context: { slot: 1 }, value: [null] };
      if (st === "error") return { context: { slot: 1 }, value: [{ slot: 5, confirmations: 1, err: { InstructionError: [2, { Custom: 6002 }] }, confirmationStatus: "confirmed" }] };
      return { context: { slot: 1 }, value: [{ slot: 5, confirmations: 1, err: null, confirmationStatus: st }] };
    },
    getTransaction: async () => {
      const i = Math.min(txReads++, s.txs.length - 1);
      if (s.txs[i] === "null") return null;
      return {
        slot: 5,
        transaction: { message: { getAccountKeys: () => ({ staticAccountKeys: [user.publicKey, ata, mint, tipAccount] }) } },
        meta: {
          err: null,
          fee: Number(s.fee),
          preBalances: [Number(s.preSol), Number(s.ataLamportsPre), 0, 0],
          postBalances: [Number(s.postSol), Number(s.ataLamportsPost), 0, 0],
          preTokenBalances: s.preTokens === null ? [] : [{ accountIndex: 1, mint: mint.toBase58(), owner: user.publicKey.toBase58(), uiTokenAmount: { amount: s.preTokens.toString() } }],
          postTokenBalances: [{ accountIndex: 1, mint: mint.toBase58(), owner: user.publicKey.toBase58(), uiTokenAmount: { amount: s.postTokens.toString() } }],
          loadedAddresses: { writable: [], readonly: [] },
        },
      };
    },
  };
  let txReads = 0;
  const bundles = {
    randomTipAccount: async () => tipAccount.toBase58(),
    sendBundle: async () => {
      calls.sends++;
      return { bundleId: "bundle-1", route: "block-engine" as const };
    },
    inflightStatus: async () => ({ status: "Pending" as const, landedSlot: null }),
  } as unknown as BundleClient;
  let t = 0;
  const clock = { now: () => t, sleep: async (ms: number) => void (t += ms) };
  const exec = new LiveExecutor(conn as never, user, bundles, () => DEFAULT_PARAMS, clock);
  return { exec, calls };
}

const buy = { mint: mint.toBase58(), tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(), budgetLamports: 50_000_000n, minTokensOut: 1n, tipLamports: 10_000n };

// a buy of 50 000 000 lamports on the curve, a new ATA (1 513 840 rent), a 10 000 tip and a 5 160 fee
const base: Script = {
  statuses: ["none", "confirmed"],
  txs: ["tx"],
  preSol: 2_000_000_000n,
  postSol: 2_000_000_000n - 50_000_000n - 1_513_840n - 10_000n - 5_160n,
  preTokens: null,
  postTokens: 1_234_567_890n,
  ataLamportsPre: 0n,
  ataLamportsPost: 1_513_840n,
  fee: 5_160n,
  landsAtPoll: 1,
};

describe("live buy accounting", () => {
  it("reads the real deltas of a confirmed buy, splitting off the rent the token account actually took", async () => {
    const { exec } = fakes(base);
    const f = await exec.buy(buy);
    expect(f.ok).toBe(true);
    expect(f.tokens).toBe(1_234_567_890n);
    expect(f.lamports).toBe(50_000_000n);
    expect(f.rentLamports).toBe(1_513_840n);
    expect(f.networkLamports).toBe(5_160n);
    expect(f.estimate ?? false).toBe(false);
  });

  it("charges no rent when the token account already existed", async () => {
    const { exec } = fakes({ ...base, preTokens: 0n, ataLamportsPre: 2_074_080n, ataLamportsPost: 2_074_080n, postSol: base.postSol + 1_513_840n });
    const f = await exec.buy(buy);
    expect(f.rentLamports).toBe(0n);
    expect(f.lamports).toBe(50_000_000n);
  });

  it("waits for a confirmed transaction that the RPC has not indexed yet", async () => {
    const { exec } = fakes({ ...base, txs: ["null", "null", "tx"] });
    const f = await exec.buy(buy);
    expect(f.ok).toBe(true);
    expect(f.lamports).toBe(50_000_000n);
    expect(f.tokens).toBe(1_234_567_890n);
  });

  it("reconciles from balances when a confirmed transaction never becomes readable, never from a missing post-balance", async () => {
    const { exec } = fakes({ ...base, txs: ["null"] });
    const f = await exec.buy(buy);
    expect(f.ok).toBe(true);
    expect(f.estimate).toBe(true);
    expect(f.tokens).toBe(1_234_567_890n);
    // SOL that left the wallet, less the tip and the rent: never the wallet balance
    expect(f.lamports).toBeLessThan(buy.budgetLamports + 20_000n);
    expect(f.lamports).toBeGreaterThan(buy.budgetLamports - 20_000n);
  });

  it("finds a bundle that lands after the polling deadline", async () => {
    // nothing visible for the whole 8 s polling window (20 polls), then it lands
    const { exec } = fakes({ ...base, statuses: [...Array(22).fill("none"), "confirmed"], landsAtPoll: 21 });
    const f = await exec.buy(buy);
    expect(f.ok).toBe(true);
    expect(f.tokens).toBe(1_234_567_890n);
  });

  it("calls a buy failed only once its blockhash has expired and nothing moved", async () => {
    const { exec, calls } = fakes({ ...base, statuses: ["none"], landsAtPoll: Number.MAX_SAFE_INTEGER });
    const f = await exec.buy(buy);
    expect(f.ok).toBe(false);
    expect(calls.blockHeightAtVerdict).toBeGreaterThan(LAST_VALID);
    expect(f.error).toMatch(/expired/);
  });

  it("keeps polling through transient RPC errors", async () => {
    const { exec } = fakes({ ...base, statuses: ["throw", "throw", "confirmed"], landsAtPoll: 2 });
    const f = await exec.buy(buy);
    expect(f.ok).toBe(true);
    expect(f.tokens).toBe(1_234_567_890n);
  });

  it("reports a transaction that landed with an error as failed, without waiting", async () => {
    const { exec, calls } = fakes({ ...base, statuses: ["error"], landsAtPoll: Number.MAX_SAFE_INTEGER });
    const f = await exec.buy(buy);
    expect(f.ok).toBe(false);
    expect(f.error).toMatch(/landed with error/);
    expect(calls.polls).toBe(1);
  });
});

describe("live holdings read", () => {
  it("reads the wallet's balance of a mint, 0 without a token account, and unknown on an RPC error", async () => {
    const held = fakes({ ...base, landsAtPoll: 0 }).exec;
    expect(await held.holdingsOf(mint.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58())).toBe(1_234_567_890n);
    const none = fakes({ ...base, landsAtPoll: Number.MAX_SAFE_INTEGER }).exec;
    expect(await none.holdingsOf(mint.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58())).toBe(0n);
    const down = new LiveExecutor({ getAccountInfo: async () => { throw new Error("fetch failed"); } } as never, user, {} as BundleClient, () => DEFAULT_PARAMS, { now: () => 0, sleep: async () => undefined });
    expect(await down.holdingsOf(mint.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58())).toBeNull();
  });
});
