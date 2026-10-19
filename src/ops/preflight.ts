/**
 * Preflight: everything that must hold before the engine may start, checked
 * without sending a transaction or touching a key. It fails closed: any
 * failed check means "do not start". Warnings are printed and do not stop a
 * paper run; in live mode the checks that protect real funds are failures.
 *
 * Protocol drift. pump.fun upgrades its program without notice (three SDK
 * major or minor releases between 7 and 13 October 2026, and a program
 * deploy on 13 October). This build's curve math, fee handling and
 * instruction builders were verified against the program deployed at the
 * slots below (differential tests against @pump-fun/pump-sdk 4.1.0, and a
 * read-only simulation showing the deployed program dispatches the v3 buy
 * and sell instructions, on 17 October 2026). The on-chain IDL account is
 * not a usable reference: it was still missing the v3 instructions after
 * that deploy. A different deploy slot means the program changed after
 * verification; live trading stays blocked until an operator acknowledges
 * it (`curvealpha preflight --accept-program-upgrade`), which is recorded.
 */
import type { Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { DISC } from "../chain/events.js";
import { pumpSdk } from "../chain/sdk.js";
import { PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID, fetchProtocolState } from "../chain/accounts.js";
import type { FeeSchedule, GlobalParams } from "../math/curve.js";
import type { TipFloor } from "../exec/tips.js";
import { assemble, buyIxs, sellIxs } from "../exec/tx.js";

export type CheckStatus = "pass" | "warn" | "fail" | "skip";
export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

/** Program deploy slots this build was verified against (see the header). */
export const VERIFIED_DEPLOY_SLOTS = { pump: 456_494_698, pumpswap: 454_596_406 } as const;

type Mode = "paper" | "live";
const res = (name: string, status: CheckStatus, detail: string): CheckResult => ({ name, status, detail });

export function checkNode(version: string): CheckResult {
  const [maj, min] = version.replace(/^v/, "").split(".").map(Number) as [number, number];
  const ok = maj > 22 || (maj === 22 && min >= 13);
  return res("node", ok ? "pass" : "fail", ok ? `Node ${version}` : `Node ${version}: 22.13 or newer is required (node:sqlite)`);
}

export function checkProgramVersion(program: keyof typeof VERIFIED_DEPLOY_SLOTS, deploySlot: number, acknowledgedSlot: number | null, mode: Mode): CheckResult {
  const verified = VERIFIED_DEPLOY_SLOTS[program];
  if (deploySlot === verified) return res(`${program} program`, "pass", `deployed at slot ${deploySlot}, the version this build was verified against`);
  if (acknowledgedSlot === deploySlot) return res(`${program} program`, "pass", `deployed at slot ${deploySlot}; upgrade since verification acknowledged by the operator`);
  const detail = `${program} program upgraded: deployed at slot ${deploySlot}, this build was verified against slot ${verified}. Run the test suite and paper mode against it, then acknowledge with --accept-program-upgrade.`;
  return res(`${program} program`, mode === "live" ? "fail" : "warn", detail);
}

export function checkEventDiscriminators(idl: { events?: Array<{ name: string; discriminator: number[] }> }): CheckResult {
  const want: Record<string, Buffer> = { TradeEvent: DISC.trade, CreateEvent: DISC.create, CompleteEvent: DISC.complete };
  const bad = Object.entries(want).filter(([name, disc]) => {
    const e = idl.events?.find((x) => x.name === name);
    return !e || !Buffer.from(e.discriminator).equals(disc);
  });
  return bad.length === 0
    ? res("event discriminators", "pass", "Trade, Create and Complete match the SDK's IDL")
    : res("event discriminators", "fail", `${bad.map(([n]) => n).join(", ")} no longer match the SDK's IDL: events would be silently skipped`);
}

export function checkDispatch(buyLogs: string[], sellLogs: string[]): CheckResult {
  const missing = [
    ...(buyLogs.some((l) => l.includes("Instruction: BuyExactQuoteInV3")) ? [] : ["buy_exact_quote_in_v3"]),
    ...(sellLogs.some((l) => l.includes("Instruction: SellV3")) ? [] : ["sell_v3"]),
  ];
  return missing.length === 0
    ? res("instruction dispatch", "pass", "the deployed program dispatches buy_exact_quote_in_v3 and sell_v3 (read-only simulation)")
    : res("instruction dispatch", "fail", `the deployed program does not dispatch ${missing.join(" and ")}: live orders would fail`);
}

export function checkProtocolState(global: GlobalParams, schedule: FeeSchedule): CheckResult {
  if (global.initialVirtualTokenReserves === 0n || global.initialVirtualSolReserves === 0n || global.tokenTotalSupply === 0n) {
    return res("protocol state", "fail", "Global has zero reserves or supply: the account did not decode as expected");
  }
  if (schedule.feeTiers.length === 0) return res("protocol state", "fail", "FeeConfig has no fee tiers");
  // no pump.fun curve has charged more than a few percent; far more means the layout or the decoder drifted
  const worst = schedule.feeTiers.reduce((m, t) => {
    const total = t.lpFeeBps + t.protocolFeeBps + t.creatorFeeBps;
    return total > m ? total : m;
  }, 0n);
  if (worst > 500n) return res("protocol state", "fail", `a fee tier totals ${worst} bps, implausible for a curve: refusing to trade on it`);
  const t0 = schedule.feeTiers[0]!;
  return res("protocol state", "pass", `${schedule.feeTiers.length} fee tier(s), first ${t0.protocolFeeBps} bps protocol + ${t0.creatorFeeBps} bps creator + ${t0.lpFeeBps} bps lp`);
}

export function checkTipFloor(floor: TipFloor | null, nowMs: number, mode: Mode): CheckResult {
  const fresh = floor !== null && nowMs - floor.atMs <= 60_000;
  if (fresh) return res("jito tip floor", "pass", `p50 ${floor.p50} lamports, ema50 ${floor.ema50}`);
  return res("jito tip floor", mode === "live" ? "fail" : "warn", floor ? "tip floor is stale: entries will be refused" : "tip floor unreachable: entries will be refused until it answers");
}

export function summarize(results: CheckResult[]): { ok: boolean; results: CheckResult[] } {
  return { ok: !results.some((r) => r.status === "fail"), results };
}

/** Slot at which an upgradeable program was last deployed (from its ProgramData account). */
export async function programDeploySlot(conn: Connection, programId: PublicKey): Promise<number> {
  const prog = await conn.getAccountInfo(programId, "confirmed");
  if (!prog || prog.data.length < 36) throw new Error(`program ${programId.toBase58()} not found or not upgradeable`);
  const programData = new PublicKey(prog.data.subarray(4, 36));
  const pd = await conn.getAccountInfo(programData, { commitment: "confirmed", dataSlice: { offset: 0, length: 12 } });
  if (!pd) throw new Error(`program data account ${programData.toBase58()} not found`);
  return Number(pd.data.readBigUInt64LE(4));
}

/**
 * Simulate the pump buy and sell instructions alone (no ATA creation, no
 * tip) with signature verification off: nothing is signed or sent. The
 * accounts are not expected to validate; only whether the program logs
 * the instruction name, which Anchor does on dispatch, is read.
 */
export async function simulateDispatch(conn: Connection, payer: PublicKey): Promise<{ buyLogs: string[]; sellLogs: string[] }> {
  const mint = new PublicKey("So11111111111111111111111111111111111111112");
  const buy = (await buyIxs(payer, mint, TOKEN_2022_PROGRAM_ID, 1_000_000n, 1n))[1]!;
  const sell = (await sellIxs(payer, mint, TOKEN_2022_PROGRAM_ID, 1_000n, 0n, false))[0]!;
  const logs = async (ix: typeof buy) => {
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    const sim = await conn.simulateTransaction(assemble(payer, blockhash, [ix], 200_000, 0n), { sigVerify: false, replaceRecentBlockhash: true });
    return sim.value.logs ?? [];
  };
  return { buyLogs: await logs(buy), sellLogs: await logs(sell) };
}

export interface PreflightContext {
  mode: Mode;
  conn: Connection;
  nowMs: number;
  acknowledgedSlot: (program: string) => number | null;
  tipFloor: () => Promise<TipFloor | null>;
  /** Checks already done by the caller (settings, database, parameters, key file). */
  local: CheckResult[];
}

/** Every remote check, each isolated so one failure does not hide the others. */
export async function runPreflight(c: PreflightContext): Promise<{ ok: boolean; results: CheckResult[] }> {
  const out: CheckResult[] = [checkNode(process.version), ...c.local, checkEventDiscriminators(pumpSdk.pumpIdl)];
  const attempt = async (name: string, f: () => Promise<CheckResult>) => {
    try {
      out.push(await f());
    } catch (e) {
      out.push(res(name, "fail", `could not check: ${e instanceof Error ? e.message : String(e)}`));
    }
  };
  await attempt("rpc", async () => res("rpc", "pass", `reachable, slot ${await c.conn.getSlot("confirmed")}`));
  await attempt("protocol state", async () => {
    const s = await fetchProtocolState(c.conn);
    return checkProtocolState(s.global, s.schedule);
  });
  await attempt("pump program", async () => checkProgramVersion("pump", await programDeploySlot(c.conn, PUMP_PROGRAM_ID), c.acknowledgedSlot("pump"), c.mode));
  await attempt("pumpswap program", async () => checkProgramVersion("pumpswap", await programDeploySlot(c.conn, PUMP_AMM_PROGRAM_ID), c.acknowledgedSlot("pumpswap"), c.mode));
  await attempt("instruction dispatch", async () => {
    const g = await c.conn.getAccountInfo(pumpSdk.GLOBAL_PDA, "confirmed");
    if (!g) throw new Error("Global account not found");
    const payer: PublicKey = pumpSdk.PUMP_SDK.decodeGlobal(g).feeRecipient; // a funded account; only the simulated fee payer
    const { buyLogs, sellLogs } = await simulateDispatch(c.conn, payer);
    return checkDispatch(buyLogs, sellLogs);
  });
  await attempt("jito tip floor", async () => checkTipFloor(await c.tipFloor(), c.nowMs, c.mode));
  return summarize(out);
}

export function formatPreflight(r: { ok: boolean; results: CheckResult[] }): string {
  const mark: Record<CheckStatus, string> = { pass: "PASS", warn: "WARN", fail: "FAIL", skip: "SKIP" };
  const lines = r.results.map((x) => `${mark[x.status]}  ${x.name.padEnd(22)} ${x.detail}`);
  lines.push(r.ok ? "Preflight passed." : "Preflight FAILED: do not start until every FAIL is resolved.");
  return lines.join("\n");
}
