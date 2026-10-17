/**
 * Writes crates/curve-core/vectors.txt: cases whose expected values come from
 * pump.fun's official SDK (not from CurveAlpha), so the Rust implementation is
 * checked against the program's reference arithmetic independently.
 *
 * Line format (space separated):
 *   kind vT vS rT rS hasCreator mayhem creatorBps configurable mintSupply baseBal amount tiers expected
 * tiers: threshold:lp:protocol:creator joined by commas, or F for the fixture table. expected is ERR when the SDK throws.
 */
import { writeFileSync } from "node:fs";
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { pumpSdk } from "../src/chain/sdk.js";
import { randBig, randLog, randomCase, rng, toSdkCurve, toSdkFeeConfig, toSdkGlobal } from "../test/helpers/gen.js";

const PER_KIND = Number(process.env.VECTORS ?? 2000);
const r = rng(4242);
const lines: string[] = [];

function expected(fn: () => { toString(): string }): string {
  try {
    return fn().toString();
  } catch {
    return "ERR";
  }
}

for (let i = 0; i < PER_KIND; i++) {
  const c = randomCase(r, { fixture: i % 2 === 0 });
  const g = toSdkGlobal(c.global);
  const fc = toSdkFeeConfig(c.schedule);
  const bc = toSdkCurve(c.curve);
  const ms = new BN(c.mintSupply.toString());
  const bal = new BN(c.curveBaseTokenBalance.toString());
  // "F" stands for the PumpSwap mainnet fixture table, spelled out in the Rust test
  const tiers = i % 2 === 0 ? "F" : c.schedule.feeTiers
    .map((t) => `${t.marketCapLamportsThreshold}:${t.lpFeeBps}:${t.protocolFeeBps}:${t.creatorFeeBps}`)
    .join(",");
  const head = (kind: string) =>
    [
      kind,
      c.curve.virtualTokenReserves,
      c.curve.virtualSolReserves,
      c.curve.realTokenReserves,
      c.curve.realSolReserves,
      c.curve.hasCreator ? 1 : 0,
      c.curve.isMayhemMode ? 1 : 0,
      c.curve.creatorFeeBps,
      c.global.creatorFeeConfigurable ? 1 : 0,
      c.mintSupply,
      c.curveBaseTokenBalance,
    ].join(" ");

  const sol = randLog(r, 1n, 200_000_000_000n);
  const tokens = randLog(r, 1n, 800_000_000_000_000n);
  const crossing = c.curve.realTokenReserves + randBig(r, 1n, 150_000_000_000_000n);
  const bigBudget = randLog(r, 1_000_000_000n, 400_000_000_000n);
  const base = { global: g, feeConfig: fc, mintSupply: ms, bondingCurve: bc, quoteMint: PublicKey.default };

  lines.push(`${head("buy_sol")} ${sol} ${tiers} ${expected(() => pumpSdk.getBuyTokenAmountFromSolAmount({ ...base, amount: new BN(sol.toString()) }))}`);
  lines.push(`${head("buy_cost")} ${tokens} ${tiers} ${expected(() => pumpSdk.getBuySolAmountFromTokenAmount({ ...base, amount: new BN(tokens.toString()) }))}`);
  lines.push(`${head("sell")} ${tokens} ${tiers} ${expected(() => pumpSdk.getSellSolAmountFromTokenAmount({ ...base, amount: new BN(tokens.toString()) }))}`);
  for (const b of [sol, bigBudget]) {
    lines.push(
      `${head("v3_in")} ${b} ${tiers} ${expected(() =>
        pumpSdk.getBuyV3TokenAmountFromQuoteAmount({ ...base, curveBaseTokenBalance: bal, amount: new BN(b.toString()) }),
      )}`,
    );
  }
  for (const t of [tokens, crossing]) {
    lines.push(
      `${head("v3_tokens")} ${t} ${tiers} ${expected(() =>
        pumpSdk.getBuyV3QuoteAmountFromTokenAmount({ ...base, curveBaseTokenBalance: bal, amount: new BN(t.toString()) }),
      )}`,
    );
  }
}

writeFileSync(new URL("../crates/curve-core/vectors.txt", import.meta.url), lines.join("\n") + "\n");
console.log(`wrote ${lines.length} vectors`);
