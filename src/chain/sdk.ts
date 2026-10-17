/**
 * Single entry point to pump.fun's official SDKs.
 *
 * @pump-fun/pump-sdk 4.1.0 ships an ESM build that fails to link (its
 * agent-payments dependency re-exports names from a CommonJS module), so the
 * CommonJS builds are loaded here through createRequire. Every other module
 * imports pump SDK symbols from this file only.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const pumpSdk: any = require("@pump-fun/pump-sdk");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const pumpSwapSdk: any = require("@pump-fun/pump-swap-sdk");
