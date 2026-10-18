/**
 * Yellowstone gRPC ingestion with production reliability.
 *
 *  - Subscribes to every non-vote, successful transaction that touches the
 *    pump program, at processed commitment (detection speed), plus slot
 *    updates so dead (forked away) slots can be retracted.
 *  - Reconnects with capped exponential backoff and jitter. On reconnect it
 *    resubscribes with from_slot = last seen slot minus a rewind window, so
 *    the gap is replayed; replayed signatures are de-duplicated.
 *  - Sends a ping on an interval and treats silence beyond three intervals as
 *    a dead connection.
 *  - Pauses the gRPC stream when the processing queue is above its high-water
 *    mark (true flow control, not dropping).
 *
 * If the provider no longer has the requested from_slot (retention is short
 * on most plans), or the replay keeps failing for any other reason (three
 * attempts), the subscription continues live without it and the gap is
 * recorded so every token alive during it is marked incomplete.
 *
 * Transactions delivered by a replay carry the replay's receive time, not
 * their block's, so they are tagged (RawTx.replayed) and the engine never
 * scores the mints they touch.
 */
import bs58 from "bs58";
import type { RawTx } from "../chain/events.js";
import { PUMP_PROGRAM } from "../chain/events.js";

export interface IngestStatus {
  connected: boolean;
  lastSlot: number;
  reconnects: number;
  lastMessageAtMs: number;
  gaps: Array<{ fromSlot: number; toSlot: number; atMs: number }>;
  duplicatesSkipped: number;
  txReceived: number;
}

export interface IngestHandlers {
  onTx(tx: RawTx): void;
  onDeadSlot(slot: number): void;
  onConfirmedSlot(slot: number): void;
  /** A replay window could not be served; mints active in it have a data gap. */
  onGap(fromSlot: number, toSlot: number): void;
}

export interface IngestOptions {
  endpoint: string;
  xToken?: string;
  reconnectBaseMs: () => number;
  reconnectMaxMs: () => number;
  fromSlotRewind: () => number;
  pingIntervalSec: () => number;
  /** The Yellowstone client module; injectable for tests. */
  loadClientModule?: () => Promise<unknown>;
}

/** Replay attempts that fail, for any reason, before continuing live and recording a gap. */
export const MAX_REPLAY_FAILURES = 3;
/** Slots of slack on the estimated end of a replay (slot times vary around 400 ms). */
const REPLAY_SLACK_SLOTS = 50;

/** Fixed-size set of recent signatures for replay de-duplication. */
export class RecentSet {
  private set = new Set<string>();
  private ring: string[];
  private i = 0;
  constructor(size: number) {
    this.ring = new Array<string>(size);
  }
  /** True if newly added, false if already present. */
  add(k: string): boolean {
    if (this.set.has(k)) return false;
    const old = this.ring[this.i];
    if (old !== undefined) this.set.delete(old);
    this.ring[this.i] = k;
    this.i = (this.i + 1) % this.ring.length;
    this.set.add(k);
    return true;
  }
}

export function backoffMs(attempt: number, base: number, max: number, rand = Math.random): number {
  const exp = Math.min(max, base * 2 ** Math.min(attempt, 20));
  return Math.floor(exp / 2 + rand() * (exp / 2));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** Convert a Yellowstone SubscribeUpdateTransaction into the neutral RawTx. */
export function toRawTx(update: Any, receivedAtMs: number): RawTx | null {
  const info = update?.transaction;
  const tx = info?.transaction;
  const meta = info?.meta;
  const msg = tx?.message;
  if (!info || !tx || !meta || !msg) return null;
  const keys: string[] = [
    ...msg.accountKeys.map((k: Uint8Array) => bs58.encode(k)),
    ...(meta.loadedWritableAddresses ?? []).map((k: Uint8Array) => bs58.encode(k)),
    ...(meta.loadedReadonlyAddresses ?? []).map((k: Uint8Array) => bs58.encode(k)),
  ];
  const inner: RawTx["innerIxs"] = [];
  for (const group of meta.innerInstructions ?? []) {
    for (const ix of group.instructions ?? []) inner.push({ programIdIndex: ix.programIdIndex, data: ix.data });
  }
  return {
    signature: bs58.encode(info.signature),
    slot: Number(update.slot),
    receivedAtMs,
    accountKeys: keys,
    innerIxs: inner,
    logs: meta.logMessages ?? [],
    preBalances: (meta.preBalances ?? []).map((x: string) => BigInt(x)),
    postBalances: (meta.postBalances ?? []).map((x: string) => BigInt(x)),
    failed: Boolean(meta.err),
    feePayer: keys[0] ?? "",
  };
}

export class YellowstoneIngest {
  readonly status: IngestStatus = {
    connected: false,
    lastSlot: 0,
    reconnects: 0,
    lastMessageAtMs: 0,
    gaps: [],
    duplicatesSkipped: 0,
    txReceived: 0,
  };
  private stream: Any = null;
  private stopped = false;
  private paused = false;
  private seen = new RecentSet(200_000);
  private attempt = 0;
  private pingTimer: NodeJS.Timeout | null = null;
  private replayFailures = 0;
  /** While set, transactions at or below this slot are replayed history, not live. */
  private replayUntilSlot: number | null = null;

  constructor(
    private opts: IngestOptions,
    private h: IngestHandlers,
  ) {}

  /** Pause or resume the gRPC stream (called by the queue). */
  setPaused(pause: boolean): void {
    this.paused = pause;
    if (!this.stream) return;
    if (pause) this.stream.pause?.();
    else this.stream.resume?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    try {
      this.stream?.end?.();
      this.stream?.destroy?.();
    } catch {
      /* closing */
    }
  }

  async start(): Promise<void> {
    while (!this.stopped) {
      const resumeFrom = this.status.lastSlot > 0 ? Math.max(0, this.status.lastSlot - this.opts.fromSlotRewind()) : null;
      // the replay re-sends history up to about the live tip: estimate it from the outage length
      this.replayUntilSlot =
        resumeFrom === null ? null : this.status.lastSlot + Math.ceil((Date.now() - this.status.lastMessageAtMs) / 400) + REPLAY_SLACK_SLOTS;
      let failed = false;
      let gotData = false;
      try {
        gotData = await this.runOnce(resumeFrom);
      } catch (err) {
        this.status.connected = false;
        failed = true;
        if (resumeFrom !== null && /from.?slot|not available|too old|retention|out.?of.?range/i.test(String(err))) this.replayFailures = MAX_REPLAY_FAILURES;
      }
      if (resumeFrom !== null && (failed || !gotData) && ++this.replayFailures >= MAX_REPLAY_FAILURES) {
        // the replay cannot be served: continue live and record the gap
        this.status.gaps.push({ fromSlot: resumeFrom, toSlot: this.status.lastSlot, atMs: Date.now() });
        this.h.onGap(resumeFrom, this.status.lastSlot);
        this.status.lastSlot = 0;
        this.replayFailures = 0;
        continue;
      }
      if (this.stopped) break;
      this.status.reconnects++;
      const wait = backoffMs(this.attempt++, this.opts.reconnectBaseMs(), this.opts.reconnectMaxMs());
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  /** One subscription until it ends; resolves true if any message arrived. */
  private async runOnce(fromSlot: number | null): Promise<boolean> {
    const mod: Any = await (this.opts.loadClientModule ?? (() => import("@triton-one/yellowstone-grpc")))();
    const Client = mod.default?.default ?? mod.default;
    const { CommitmentLevel, SlotStatus } = mod;
    const client = new Client(this.opts.endpoint, this.opts.xToken, {
      "grpc.max_receive_message_length": 64 * 1024 * 1024,
    });
    await client.connect();
    const stream = await client.subscribe();
    this.stream = stream;
    const request: Any = {
      accounts: {},
      slots: { slots: { filterByCommitment: false, interslotUpdates: false } },
      transactions: {
        pump: { vote: false, failed: false, accountInclude: [PUMP_PROGRAM], accountExclude: [], accountRequired: [] },
      },
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      accountsDataSlice: [],
      commitment: CommitmentLevel.PROCESSED,
      ...(fromSlot !== null ? { fromSlot: String(fromSlot) } : {}),
    };
    await new Promise<void>((resolve, reject) => {
      stream.write(request, (err: unknown) => (err ? reject(err) : resolve()));
    });
    this.status.connected = true;
    this.status.lastMessageAtMs = Date.now();
    if (this.paused) stream.pause?.();

    let pingId = 1;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      const silentFor = Date.now() - this.status.lastMessageAtMs;
      if (silentFor > 3 * this.opts.pingIntervalSec() * 1000) {
        stream.destroy?.(new Error(`no message for ${silentFor} ms`));
        return;
      }
      stream.write({ ...request, fromSlot: undefined, ping: { id: pingId++ } }, () => undefined);
    }, this.opts.pingIntervalSec() * 1000);

    let gotData = false;
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (u: Any) => {
        const now = Date.now();
        this.status.lastMessageAtMs = now;
        this.attempt = 0;
        gotData = true;
        this.replayFailures = 0;
        if (u.transaction) {
          const tx = toRawTx(u.transaction, now);
          if (!tx) return;
          if (this.replayUntilSlot !== null) {
            if (tx.slot <= this.replayUntilSlot) tx.replayed = true;
            else this.replayUntilSlot = null; // past the replay: live from here
          }
          if (tx.slot > this.status.lastSlot) this.status.lastSlot = tx.slot;
          if (!this.seen.add(tx.signature)) {
            this.status.duplicatesSkipped++;
            return;
          }
          this.status.txReceived++;
          this.h.onTx(tx);
        } else if (u.slot) {
          const slot = Number(u.slot.slot);
          if (u.slot.status === SlotStatus.SLOT_DEAD) this.h.onDeadSlot(slot);
          else if (u.slot.status === SlotStatus.SLOT_CONFIRMED) this.h.onConfirmedSlot(slot);
        }
      });
      stream.on("error", (e: unknown) => reject(e));
      stream.on("end", () => resolve());
      stream.on("close", () => resolve());
    });
    this.status.connected = false;
    return gotData;
  }
}

export { PUMP_PROGRAM };
