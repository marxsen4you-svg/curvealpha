/**
 * Synthetic pump.fun market for integration tests.
 *
 * Tokens are created and traded by simulated wallets; every TradeEvent's
 * reserves come from the exact curve math, encoded with the official IDL
 * coder, wrapped in transactions exactly as the gRPC adapter delivers them.
 * Three token archetypes give the factors something real to find:
 *   rug     bundled sybil buys in the creation slot from freshly funded
 *           wallets, then the creator dumps
 *   dud     a little organic interest that fades
 *   runner  broad organic buying that accelerates, with ranked wallets early
 */
import { PublicKey } from "@solana/web3.js";
import { simulateSell, simulateV3Buy, type CurveState, type FeeSchedule, type GlobalParams } from "../../src/math/curve.js";
import type { RawTx } from "../../src/chain/events.js";
import { createEventBytes, rawTx, tradeEventBytes } from "./events.js";
import { rng } from "./gen.js";

type Kind = "rug" | "dud" | "runner";

interface SimToken {
  mint: PublicKey;
  creator: PublicKey;
  kind: Kind;
  createdAt: number;
  curve: CurveState;
  holders: Map<string, bigint>;
  dumpAt: number;
  dead: boolean;
}

export class SyntheticMarket {
  private r: () => number;
  private tokens: SimToken[] = [];
  private sigN = 0;
  readonly smartWallets: PublicKey[];
  private retail: PublicKey[];
  kinds = new Map<string, Kind>();

  constructor(private g: GlobalParams, private schedule: FeeSchedule, seed = 1) {
    this.r = rng(seed);
    this.smartWallets = Array.from({ length: 60 }, () => this.key());
    this.retail = Array.from({ length: 1500 }, () => this.key());
  }

  /** Deterministic keys, so a seeded run is reproducible end to end. */
  private key(): PublicKey {
    return new PublicKey(Uint8Array.from({ length: 32 }, () => Math.floor(this.r() * 256)));
  }

  private sig(): string {
    return `sim${this.sigN++}`;
  }

  private slot(t: number): number {
    return Math.floor(t / 400);
  }

  private trade(tok: SimToken, user: PublicKey, isBuy: boolean, amount: bigint, t: number, preBal = 5_000_000_000n): RawTx | null {
    const supply = this.g.tokenTotalSupply;
    let ev: Buffer;
    if (isBuy) {
      const b = simulateV3Buy(this.g, this.schedule, supply, tok.curve, amount);
      if (!b) return null;
      tok.curve = b.after;
      tok.holders.set(user.toBase58(), (tok.holders.get(user.toBase58()) ?? 0n) + b.tokens);
      ev = tradeEventBytes({ mint: tok.mint, user, creator: tok.creator, isBuy: true, sol: b.netSol, tokens: b.tokens, vS: b.after.virtualSolReserves, vT: b.after.virtualTokenReserves, rS: b.after.realSolReserves, rT: b.after.realTokenReserves, ts: Math.floor(t / 1000) });
    } else {
      const held = tok.holders.get(user.toBase58()) ?? 0n;
      const qty = amount > held ? held : amount;
      if (qty <= 0n) return null;
      const s = simulateSell(this.g, this.schedule, supply, tok.curve, qty);
      if (s.netSol <= 0n) return null;
      tok.curve = s.after;
      tok.holders.set(user.toBase58(), held - qty);
      ev = tradeEventBytes({ mint: tok.mint, user, creator: tok.creator, isBuy: false, sol: s.grossSol, tokens: qty, vS: s.after.virtualSolReserves, vT: s.after.virtualTokenReserves, rS: s.after.realSolReserves, rT: s.after.realTokenReserves, ts: Math.floor(t / 1000) });
    }
    const tx = rawTx(this.sig(), this.slot(t), user, [ev], preBal);
    tx.receivedAtMs = t;
    return tx;
  }

  /** Everything that happens in [t, t + dt). */
  step(t: number, dt: number, createRatePerSec: number): RawTx[] {
    const out: RawTx[] = [];
    const lam = (rate: number) => this.r() < rate * (dt / 1000);
    if (lam(createRatePerSec)) {
      const u = this.r();
      const kind: Kind = u < 0.3 ? "rug" : u < 0.9 ? "dud" : "runner";
      const mint = this.key();
      const creator = this.key();
      const tok: SimToken = {
        mint,
        creator,
        kind,
        createdAt: t,
        curve: {
          virtualTokenReserves: this.g.initialVirtualTokenReserves,
          virtualSolReserves: this.g.initialVirtualSolReserves,
          realTokenReserves: this.g.initialRealTokenReserves,
          realSolReserves: 0n,
          tokenTotalSupply: this.g.tokenTotalSupply,
          complete: false,
          hasCreator: true,
          isMayhemMode: false,
          isCashbackCoin: false,
          creatorFeeBps: 0n,
        },
        holders: new Map(),
        dumpAt: t + 40_000 + this.r() * 50_000,
        dead: false,
      };
      this.tokens.push(tok);
      this.kinds.set(mint.toBase58(), kind);
      const words = ["moon", "dog", "cat", "pepe", "frog", "ai", "agent", "sol", "based", "chad", "wif", "hat", "zen", "orb", "lux"];
      const name = `${words[Math.floor(this.r() * words.length)]} ${words[Math.floor(this.r() * words.length)]}`;
      const ctx = rawTx(this.sig(), this.slot(t), creator, [createEventBytes({ mint, creator, name, symbol: name.slice(0, 4).toUpperCase() })]);
      ctx.receivedAtMs = t;
      out.push(ctx);
      const dev = this.trade(tok, creator, true, BigInt(Math.floor((0.2 + this.r() * 1.5) * 1e9)), t);
      if (dev) out.push(dev);
      if (kind === "rug") {
        for (let i = 0; i < 8; i++) {
          const w = this.key();
          const amt = 300_000_000n + BigInt(Math.floor(this.r() * 10_000_000));
          // freshly funded: the wallet held barely more than this buy
          const tx = this.trade(tok, w, true, amt, t, amt + 4_000_000n);
          if (tx) out.push(tx);
        }
      }
    }
    this.tokens = this.tokens.filter((x) => !x.dead && !x.curve.complete);
    for (const tok of this.tokens) {
      if (tok.dead || tok.curve.complete) continue;
      const age = (t - tok.createdAt) / 1000;
      if (age > 420) {
        tok.dead = true;
        continue;
      }
      let buyRate = 0;
      if (tok.kind === "dud") buyRate = 0.8 * Math.exp(-age / 40);
      else if (tok.kind === "runner") buyRate = age < 240 ? 0.6 + age / 40 : 2 * Math.exp(-(age - 240) / 120);
      else buyRate = 0.5 * Math.exp(-age / 30);
      if (lam(buyRate)) {
        const early = tok.kind === "runner" && age < 45 && this.r() < 0.5;
        const pool = early ? this.smartWallets : this.retail;
        const w = pool[Math.floor(this.r() * pool.length)]!;
        const tx = this.trade(tok, w, true, BigInt(Math.floor(Math.exp(Math.log(0.03e9) + this.r() * 3.5))), t);
        if (tx) out.push(tx);
      }
      const sellRate = tok.kind === "runner" ? (age > 200 ? 1.2 : 0.3) : 0.4 * Math.exp(-age / 120);
      if (lam(sellRate)) {
        const hs = [...tok.holders.entries()].filter(([w, v]) => v > 0n && w !== tok.creator.toBase58());
        if (hs.length) {
          const [w, v] = hs[Math.floor(this.r() * hs.length)]!;
          const tx = this.trade(tok, new PublicKey(w), false, (v * BigInt(Math.ceil(this.r() * 100))) / 100n, t);
          if (tx) out.push(tx);
        }
      }
      if (tok.kind === "rug" && t >= tok.dumpAt) {
        const held = tok.holders.get(tok.creator.toBase58()) ?? 0n;
        if (held > 0n) {
          const tx = this.trade(tok, tok.creator, false, held, t);
          if (tx) out.push(tx);
        }
        tok.dead = true;
      }
    }
    return out;
  }
}
