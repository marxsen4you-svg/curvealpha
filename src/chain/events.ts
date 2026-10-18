/**
 * Pump program events from a transaction.
 *
 * The program emits Anchor events through a self CPI (emit_cpi): an inner
 * instruction to the pump program whose data is the 8 byte event instruction
 * tag, the 8 byte event discriminator, then the borsh payload. Older code
 * paths log them as "Program data: <base64>" instead; both are read. Payloads
 * are decoded with the official IDL coder, which tolerates every historical
 * event length.
 */
import { pumpSdk } from "./sdk.js";

export const EVENT_IX_TAG = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);
export const DISC = {
  trade: Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]),
  create: Buffer.from([27, 114, 169, 77, 222, 235, 99, 118]),
  complete: Buffer.from([95, 114, 97, 156, 212, 46, 152, 8]),
};
export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

/** Transport-neutral transaction, filled by the Yellowstone adapter or by tests. */
export interface RawTx {
  signature: string;
  slot: number;
  /** Local receive time; block time is not part of a processed update. */
  receivedAtMs: number;
  /** Static keys followed by loaded writable then loaded readonly addresses. */
  accountKeys: string[];
  innerIxs: Array<{ programIdIndex: number; data: Uint8Array }>;
  logs: string[];
  preBalances: bigint[];
  postBalances: bigint[];
  failed: boolean;
  /** Signer of the transaction (fee payer). */
  feePayer: string;
  /**
   * Delivered as part of a from_slot replay after a reconnect: its receive
   * time is the replay's, not its block's, so timing measured from it is wrong.
   */
  replayed?: boolean;
}

export interface CreateEvt {
  kind: "create";
  signature: string;
  slot: number;
  receivedAtMs: number;
  mint: string;
  bondingCurve: string;
  creator: string;
  user: string;
  name: string;
  symbol: string;
  uri: string;
  timestampSec: number;
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  tokenTotalSupply: bigint;
  tokenProgram: string;
  isMayhemMode: boolean;
  isCashbackEnabled: boolean;
  quoteIsSol: boolean;
  creatorFeeBps: bigint;
}

export interface TradeEvt {
  kind: "trade";
  signature: string;
  slot: number;
  /** Position of the event inside the transaction, for stable ordering. */
  seq: number;
  receivedAtMs: number;
  mint: string;
  user: string;
  isBuy: boolean;
  solAmount: bigint;
  tokenAmount: bigint;
  fee: bigint;
  creatorFee: bigint;
  timestampSec: number;
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  realSolReserves: bigint;
  realTokenReserves: bigint;
  creator: string;
  ixName: string;
  /** The trader's SOL balance before this transaction, when the trader signed it. */
  userPreBalance: bigint | null;
  feePayer: string;
}

export interface CompleteEvt {
  kind: "complete";
  signature: string;
  slot: number;
  receivedAtMs: number;
  mint: string;
  bondingCurve: string;
}

export type PumpEvt = CreateEvt | TradeEvt | CompleteEvt;

const sdk = () => pumpSdk.PUMP_SDK;
const big = (x: { toString(): string }) => BigInt(x.toString());
const WSOL = "So11111111111111111111111111111111111111112";

function decode(tx: RawTx, payload: Buffer, seq: number): PumpEvt | null {
  const disc = payload.subarray(0, 8);
  const body = payload.subarray(8);
  try {
    if (disc.equals(DISC.trade)) {
      const e = sdk().decodeTradeEventBc(body);
      const user = e.user.toBase58();
      const idx = tx.accountKeys.indexOf(user);
      return {
        kind: "trade",
        signature: tx.signature,
        slot: tx.slot,
        seq,
        receivedAtMs: tx.receivedAtMs,
        mint: e.mint.toBase58(),
        user,
        isBuy: e.isBuy,
        solAmount: big(e.solAmount),
        tokenAmount: big(e.tokenAmount),
        fee: big(e.fee),
        creatorFee: big(e.creatorFee),
        timestampSec: Number(e.timestamp.toString()),
        virtualSolReserves: big(e.virtualSolReserves),
        virtualTokenReserves: big(e.virtualTokenReserves),
        realSolReserves: big(e.realSolReserves),
        realTokenReserves: big(e.realTokenReserves),
        creator: e.creator.toBase58(),
        ixName: e.ixName ?? "",
        userPreBalance: idx >= 0 && idx < tx.preBalances.length ? tx.preBalances[idx]! : null,
        feePayer: tx.feePayer,
      };
    }
    if (disc.equals(DISC.create)) {
      const e = sdk().decodeCreateEventBc(body);
      const quote = e.quoteMint ? e.quoteMint.toBase58() : "11111111111111111111111111111111";
      return {
        kind: "create",
        signature: tx.signature,
        slot: tx.slot,
        receivedAtMs: tx.receivedAtMs,
        mint: e.mint.toBase58(),
        bondingCurve: e.bondingCurve.toBase58(),
        creator: e.creator.toBase58(),
        user: e.user.toBase58(),
        name: e.name,
        symbol: e.symbol,
        uri: e.uri,
        timestampSec: Number(e.timestamp.toString()),
        virtualTokenReserves: big(e.virtualTokenReserves),
        virtualSolReserves: big(e.virtualSolReserves),
        realTokenReserves: big(e.realTokenReserves),
        tokenTotalSupply: big(e.tokenTotalSupply),
        tokenProgram: e.tokenProgram ? e.tokenProgram.toBase58() : "",
        isMayhemMode: Boolean(e.isMayhemMode),
        isCashbackEnabled: Boolean(e.isCashbackEnabled),
        quoteIsSol: quote === "11111111111111111111111111111111" || quote === WSOL,
        creatorFeeBps: big(e.creatorFeeBps ?? 0),
      };
    }
    if (disc.equals(DISC.complete)) {
      const e = sdk().decodeCompleteEventBc(body);
      return {
        kind: "complete",
        signature: tx.signature,
        slot: tx.slot,
        receivedAtMs: tx.receivedAtMs,
        mint: e.mint.toBase58(),
        bondingCurve: e.bondingCurve.toBase58(),
      };
    }
  } catch {
    // a payload that does not decode is skipped, never guessed at
    return null;
  }
  return null;
}

/** Every pump event in a transaction, in program order. Failed transactions yield nothing. */
export function parsePumpEvents(tx: RawTx): PumpEvt[] {
  if (tx.failed) return [];
  const out: PumpEvt[] = [];
  const seen = new Set<string>();
  let seq = 0;
  for (const ix of tx.innerIxs) {
    if (tx.accountKeys[ix.programIdIndex] !== PUMP_PROGRAM) continue;
    const data = Buffer.from(ix.data);
    if (data.length < 16 || !data.subarray(0, 8).equals(EVENT_IX_TAG)) continue;
    const payload = data.subarray(8);
    const e = decode(tx, payload, seq++);
    if (e) {
      out.push(e);
      seen.add(payload.toString("base64"));
    }
  }
  for (const line of tx.logs) {
    if (!line.startsWith("Program data: ")) continue;
    const payload = Buffer.from(line.slice("Program data: ".length), "base64");
    if (payload.length < 8 || seen.has(payload.toString("base64"))) continue;
    const e = decode(tx, payload, seq++);
    if (e) out.push(e);
  }
  return out;
}
