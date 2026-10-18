/**
 * Last-resort process fault handlers.
 *
 * Every launched promise in the engine already catches its own errors; these
 * handlers are for whatever slips through. An unhandled rejection is not
 * allowed to terminate the engine (Node's default since v15), because a
 * restart in the middle of an order is worse than halting entries: it is
 * logged and recorded, new entries stop, and exits keep running. An uncaught
 * exception means some state may be inconsistent: what can be flushed is
 * flushed and the process exits non-zero, so the supervisor restarts it and
 * the open positions are restored from the database.
 */
import type { EventEmitter } from "node:events";

export interface FaultHandlerDeps {
  proc: Pick<EventEmitter, "on">;
  halt(reason: string): void;
  record(message: string): void;
  flush(): void;
  exit(code: number): void;
  log(message: string, err: unknown): void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function installFaultHandlers(d: FaultHandlerDeps): void {
  d.proc.on("unhandledRejection", (reason: unknown) => {
    const m = message(reason);
    d.log("unhandled rejection", reason);
    try {
      d.record(`unhandled rejection: ${m}`);
    } finally {
      d.halt(`unexpected error: ${m}. Review the log, then clear the halt.`);
    }
  });
  d.proc.on("uncaughtException", (err: unknown) => {
    d.log("uncaught exception, flushing state and exiting", err);
    try {
      d.flush();
    } catch (e) {
      d.log("flush during fault exit failed", e);
    }
    d.exit(1);
  });
}
