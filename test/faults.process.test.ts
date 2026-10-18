/**
 * Last-resort process handlers. An unhandled rejection anywhere must not
 * terminate the engine (Node's default since v15): it is logged, recorded,
 * and new entries stop until an operator clears the halt. An uncaught
 * exception means state may be inconsistent: state is flushed and the
 * process exits non-zero so the supervisor restarts it cleanly.
 */
import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { installFaultHandlers } from "../src/util/faults.js";

function harness() {
  const proc = new EventEmitter();
  const halts: string[] = [];
  const logged: string[] = [];
  const exits: number[] = [];
  let flushed = 0;
  installFaultHandlers({
    proc,
    halt: (r) => halts.push(r),
    record: (m) => logged.push(m),
    flush: () => flushed++,
    exit: (code) => exits.push(code),
    log: () => undefined,
  });
  return { proc, halts, logged, exits, flushed: () => flushed };
}

describe("process fault handlers", () => {
  it("an unhandled rejection halts entries and is recorded, and the process keeps running", () => {
    const h = harness();
    h.proc.emit("unhandledRejection", new Error("getSignatureStatuses: fetch failed"), Promise.resolve());
    expect(h.halts).toHaveLength(1);
    expect(h.halts[0]).toMatch(/unexpected error: getSignatureStatuses: fetch failed/);
    expect(h.logged[0]).toMatch(/fetch failed/);
    expect(h.exits).toEqual([]);
  });

  it("an uncaught exception flushes state and exits non-zero", () => {
    const h = harness();
    h.proc.emit("uncaughtException", new TypeError("cannot read properties of undefined"));
    expect(h.flushed()).toBe(1);
    expect(h.exits).toEqual([1]);
  });

  it("a failing flush still exits", () => {
    const proc = new EventEmitter();
    const exits: number[] = [];
    installFaultHandlers({ proc, halt: () => undefined, record: () => undefined, flush: () => { throw new Error("disk full"); }, exit: (c) => exits.push(c), log: () => undefined });
    proc.emit("uncaughtException", new Error("boom"));
    expect(exits).toEqual([1]);
  });
});
