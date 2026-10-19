/**
 * Preflight: the checks that must pass before the engine may start, and
 * that must fail closed whenever trading safety cannot be established.
 * Each check is a pure function of what was read, so it is tested here on
 * literal inputs; the CLI wires the real reads (read-only RPC, the Jito tip
 * endpoint, the local database).
 */
import { describe, expect, it } from "vitest";
import { pumpSdk } from "../src/chain/sdk.js";
import { DISC } from "../src/chain/events.js";
import {
  checkConsensus,
  checkDispatch,
  checkEventDiscriminators,
  checkNode,
  checkProgramVersion,
  checkProtocolState,
  checkTipFloor,
  summarize,
  VERIFIED_DEPLOY_SLOTS,
} from "../src/ops/preflight.js";
import { MAINNET_GLOBAL, curveSchedule } from "./helpers/gen.js";

describe("protocol drift", () => {
  it("passes when the deployed program is the one this build was verified against", () => {
    expect(checkProgramVersion("pump", VERIFIED_DEPLOY_SLOTS.pump, null, "live").status).toBe("pass");
  });

  it("an upgraded program is a warning in paper mode and a failure in live mode, until acknowledged", () => {
    const upgraded = VERIFIED_DEPLOY_SLOTS.pump + 1_000;
    expect(checkProgramVersion("pump", upgraded, null, "paper").status).toBe("warn");
    const live = checkProgramVersion("pump", upgraded, null, "live");
    expect(live.status).toBe("fail");
    expect(live.detail).toMatch(/upgraded/);
    expect(checkProgramVersion("pump", upgraded, upgraded, "live").status).toBe("pass");
  });

  it("the event discriminators the parser hard-codes match the SDK's IDL", () => {
    expect(checkEventDiscriminators(pumpSdk.pumpIdl).status).toBe("pass");
    const drifted = { ...pumpSdk.pumpIdl, events: pumpSdk.pumpIdl.events.map((e: { name: string; discriminator: number[] }) => (e.name === "TradeEvent" ? { ...e, discriminator: [1, 2, 3, 4, 5, 6, 7, 8] } : e)) };
    const r = checkEventDiscriminators(drifted);
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/TradeEvent/);
    expect([...DISC.trade]).not.toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("the deployed program must dispatch the instructions the live path sends", () => {
    expect(checkDispatch(["Program log: Instruction: BuyExactQuoteInV3"], ["Program log: Instruction: SellV3"]).status).toBe("pass");
    const r = checkDispatch(["Program log: AnchorError occurred. Error Code: InstructionFallbackNotFound."], ["Program log: Instruction: SellV3"]);
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/buy_exact_quote_in_v3/);
  });
});

describe("protocol state", () => {
  it("accepts a plausible fee schedule and says what it is", () => {
    const r = checkProtocolState(MAINNET_GLOBAL, curveSchedule());
    expect(r.status).toBe("pass");
    expect(r.detail).toMatch(/bps/);
  });

  it("refuses an empty fee table or fees no curve has ever charged", () => {
    expect(checkProtocolState(MAINNET_GLOBAL, { feeTiers: [] }).status).toBe("fail");
    const huge = { feeTiers: [{ marketCapLamportsThreshold: 0n, lpFeeBps: 0n, protocolFeeBps: 900n, creatorFeeBps: 300n }] };
    expect(checkProtocolState(MAINNET_GLOBAL, huge).status).toBe("fail");
    expect(checkProtocolState({ ...MAINNET_GLOBAL, initialVirtualTokenReserves: 0n }, curveSchedule()).status).toBe("fail");
  });
});

describe("consensus (getAgGenesisCert, Agave 4.3)", () => {
  it("reports TowerBFT while the RPC answers null and Alpenglow once it returns a certificate", () => {
    const tower = checkConsensus({ result: null });
    expect(tower.status).toBe("pass");
    expect(tower.detail).toMatch(/TowerBFT/);
    const ag = checkConsensus({ result: { slot: 459_653_000 } });
    expect(ag.status).toBe("pass");
    expect(ag.detail).toMatch(/Alpenglow active/);
  });

  it("warns, never passes silently, when the RPC cannot say (method missing before Agave 4.3, or any error)", () => {
    const old = checkConsensus({ error: { code: -32601, message: "Method not found" } });
    expect(old.status).toBe("warn");
    expect(old.detail).toMatch(/Agave 4\.3/);
    expect(checkConsensus({ error: { code: -32000, message: "boom" } }).status).toBe("warn");
  });
});

describe("environment", () => {
  it("requires Node 22.13 or newer", () => {
    expect(checkNode("v22.13.0").status).toBe("pass");
    expect(checkNode("v24.11.1").status).toBe("pass");
    expect(checkNode("v22.12.9").status).toBe("fail");
    expect(checkNode("v20.18.0").status).toBe("fail");
  });

  it("a missing or stale tip floor fails live and warns paper (entries are refused either way)", () => {
    const now = 1_000_000;
    const fresh = { p25: 1n, p50: 2n, p75: 3n, p95: 4n, p99: 5n, ema50: 2n, atMs: now - 5_000 };
    expect(checkTipFloor(fresh, now, "live").status).toBe("pass");
    expect(checkTipFloor(null, now, "live").status).toBe("fail");
    expect(checkTipFloor(null, now, "paper").status).toBe("warn");
    expect(checkTipFloor({ ...fresh, atMs: now - 120_000 }, now, "live").status).toBe("fail");
  });

  it("the run is ok only when nothing failed", () => {
    expect(summarize([{ name: "a", status: "pass", detail: "" }, { name: "b", status: "warn", detail: "" }]).ok).toBe(true);
    expect(summarize([{ name: "a", status: "pass", detail: "" }, { name: "b", status: "fail", detail: "" }]).ok).toBe(false);
  });
});
