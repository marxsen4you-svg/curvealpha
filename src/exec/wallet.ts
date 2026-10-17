/**
 * Local signer. The private key is read from a file on the operator's
 * machine and held only in memory; it is never logged, stored, displayed or
 * sent anywhere. Only signed transactions leave the process.
 *
 * Hardware wallets: a Ledger needs a button press per signature, which cannot
 * meet a sub-second entry. The recommended setup is to keep savings on the
 * hardware wallet and fund a dedicated hot keypair with only the trading
 * bankroll (0.5 to 5 SOL), so the most a compromise or a bug can touch is that
 * bankroll.
 */
import { readFileSync, statSync } from "node:fs";
import { Keypair } from "@solana/web3.js";

export function loadKeypair(path: string): { keypair: Keypair; warnings: string[] } {
  const warnings: string[] = [];
  const st = statSync(path);
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
    warnings.push(`keypair file ${path} is readable by other users; run: chmod 600 ${path}`);
  }
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw) || raw.length !== 64) throw new Error("keypair file must be a JSON array of 64 numbers (solana-keygen format)");
  return { keypair: Keypair.fromSecretKey(Uint8Array.from(raw)), warnings };
}
