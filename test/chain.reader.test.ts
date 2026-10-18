/**
 * The chain reader that rebuilds a held mint's curve after a restart.
 * fetchCurve existed but was never called; restore now depends on it, so its
 * decoding (the curve account through the official IDL coder, the mint and
 * token account fields by offset) is checked against encoded account data.
 */
import { describe, expect, it } from "vitest";
import BN from "bn.js";
import { BorshCoder } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { pumpSdk } from "../src/chain/sdk.js";
import { curveReader } from "../src/chain/accounts.js";

const coder = new BorshCoder(pumpSdk.pumpIdl);

async function curveAccount(over: Record<string, unknown>): Promise<Buffer> {
  return coder.accounts.encode("BondingCurve", {
    virtual_token_reserves: new BN("900000000000000"),
    virtual_quote_reserves: new BN("35766666667"),
    real_token_reserves: new BN("620100000000000"),
    real_quote_reserves: new BN("5766666667"),
    token_total_supply: new BN("1000000000000000"),
    complete: false,
    creator: Keypair.generate().publicKey,
    is_mayhem_mode: false,
    is_cashback_coin: false,
    quote_mint: PublicKey.default,
    creator_fee_bps: new BN(0),
    can_edit_creator_fee: false,
    is_holder_reward: false,
    creator_fee: new BN(0),
    protocol_fees: new BN(0),
    depth: 0,
    initial_virtual_quote_reserves: new BN("30000000000"),
    post_complete_base_out: new BN(0),
    post_complete_quote_in: new BN(0),
    ...over,
  });
}

function mintAccount(supply: bigint): Buffer {
  const b = Buffer.alloc(82);
  b.writeBigUInt64LE(supply, 36);
  return b;
}

function tokenAccount(amount: bigint): Buffer {
  const b = Buffer.alloc(170);
  b.writeBigUInt64LE(amount, 64);
  return b;
}

describe("curve reader for restored positions", () => {
  it("reads the curve, its creator, the mint's token program and the read slot", async () => {
    const creator = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    const curveData = await curveAccount({ creator });
    const conn = {
      getAccountInfo: async (pk: PublicKey) => (pk.equals(mint) ? { owner: TOKEN_2022_PROGRAM_ID, data: mintAccount(1_000_000_000_000_000n) } : null),
      getMultipleAccountsInfoAndContext: async () => ({
        context: { slot: 458_200_123 },
        value: [{ data: curveData }, { data: tokenAccount(700_000_000_000_000n) }, { data: mintAccount(1_000_000_000_000_000n) }],
      }),
    };
    const read = curveReader(conn as never);
    const a = (await read(mint.toBase58()))!;
    expect(a.slot).toBe(458_200_123);
    expect(a.creator).toBe(creator.toBase58());
    expect(a.tokenProgram).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
    expect(a.curve.virtualSolReserves).toBe(35_766_666_667n);
    expect(a.curve.virtualTokenReserves).toBe(900_000_000_000_000n);
    expect(a.curve.realSolReserves).toBe(5_766_666_667n);
    expect(a.curve.complete).toBe(false);
  });

  it("returns null when the mint no longer exists", async () => {
    const conn = { getAccountInfo: async () => null, getMultipleAccountsInfoAndContext: async () => ({ context: { slot: 1 }, value: [null, null, null] }) };
    expect(await curveReader(conn as never)(Keypair.generate().publicKey.toBase58())).toBeNull();
  });
});
