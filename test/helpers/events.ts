/** Builds genuine pump event bytes with the official IDL coder, for parser tests. */
import BN from "bn.js";
import { BorshCoder } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { pumpSdk } from "../../src/chain/sdk.js";
import { DISC, EVENT_IX_TAG, PUMP_PROGRAM, type RawTx } from "../../src/chain/events.js";

const coder = new BorshCoder(pumpSdk.pumpIdl);
const bn = (x: bigint | number) => new BN(x.toString());

export function tradeEventBytes(f: {
  mint: PublicKey;
  user: PublicKey;
  creator: PublicKey;
  isBuy: boolean;
  sol: bigint;
  tokens: bigint;
  vS: bigint;
  vT: bigint;
  rS: bigint;
  rT: bigint;
  ts?: number;
}): Buffer {
  const body = coder.types.encode("TradeEvent", {
    mint: f.mint,
    sol_amount: bn(f.sol),
    token_amount: bn(f.tokens),
    is_buy: f.isBuy,
    user: f.user,
    timestamp: bn(f.ts ?? 1_760_700_000),
    virtual_sol_reserves: bn(f.vS),
    virtual_token_reserves: bn(f.vT),
    real_sol_reserves: bn(f.rS),
    real_token_reserves: bn(f.rT),
    fee_recipient: PublicKey.default,
    fee_basis_points: bn(95),
    fee: bn((f.sol * 95n + 9999n) / 10000n),
    creator: f.creator,
    creator_fee_basis_points: bn(30),
    creator_fee: bn((f.sol * 30n + 9999n) / 10000n),
    track_volume: false,
    total_unclaimed_tokens: bn(0),
    total_claimed_tokens: bn(0),
    current_sol_volume: bn(0),
    last_update_timestamp: bn(0),
    ix_name: f.isBuy ? "buy_exact_quote_in_v3" : "sell_v3",
    mayhem_mode: false,
    cashback_fee_basis_points: bn(0),
    cashback: bn(0),
    buyback_fee_basis_points: bn(0),
    buyback_fee: bn(0),
    shareholders: [],
    quote_mint: PublicKey.default,
    quote_amount: bn(f.sol),
    virtual_quote_reserves: bn(f.vS),
    real_quote_reserves: bn(f.rS),
    holder_rewards_bps: bn(0),
    holder_rewards: bn(0),
    creator_fee_unclaimed: bn(0),
  });
  return Buffer.concat([EVENT_IX_TAG, DISC.trade, body]);
}

export function createEventBytes(f: { mint: PublicKey; creator: PublicKey; name: string; symbol: string }): Buffer {
  const body = coder.types.encode("CreateEvent", {
    name: f.name,
    symbol: f.symbol,
    uri: "https://example.invalid/meta.json",
    mint: f.mint,
    bonding_curve: Keypair.generate().publicKey,
    user: f.creator,
    creator: f.creator,
    timestamp: bn(1_760_700_000),
    virtual_token_reserves: bn(1_073_000_000_000_000n),
    virtual_sol_reserves: bn(30_000_000_000n),
    real_token_reserves: bn(793_100_000_000_000n),
    token_total_supply: bn(1_000_000_000_000_000n),
    token_program: new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
    is_mayhem_mode: false,
    is_cashback_enabled: false,
    quote_mint: PublicKey.default,
    virtual_quote_reserves: bn(30_000_000_000n),
    creator_fee_bps: bn(0),
    is_holder_reward: false,
    depth: 0,
  });
  return Buffer.concat([EVENT_IX_TAG, DISC.create, body]);
}

export function rawTx(signature: string, slot: number, payer: PublicKey, events: Buffer[], preBal = 1_000_000_000n): RawTx {
  return {
    signature,
    slot,
    receivedAtMs: Date.now(),
    accountKeys: [payer.toBase58(), PUMP_PROGRAM],
    innerIxs: events.map((d) => ({ programIdIndex: 1, data: d })),
    logs: [],
    preBalances: [preBal, 1n],
    postBalances: [preBal, 1n],
    failed: false,
    feePayer: payer.toBase58(),
  };
}
