/**
 * Logs carry an ISO timestamp and a level, optionally as JSON lines, and
 * never a secret: configured secret values and credentials embedded in
 * URLs (user:pass@, api-key= and token= query parameters, which RPC and gRPC
 * providers commonly put in endpoint URLs) are masked wherever they appear,
 * including inside error messages.
 */
import { describe, expect, it } from "vitest";
import { createLogger, redact, routeConsole } from "../src/util/log.js";

const T = Date.UTC(2026, 9, 18, 6, 30, 0);

describe("redaction", () => {
  it("masks configured secrets and URL credentials", () => {
    const s = redact("connect https://user:hunter22@rpc.example/?api-key=abc123&x=1 with token s3cr3t-token-value", ["s3cr3t-token-value"]);
    expect(s).toBe("connect https://[redacted]@rpc.example/?api-key=[redacted]&x=1 with token [redacted]");
  });
  it("ignores empty and very short secrets instead of masking every character", () => {
    expect(redact("plain text", ["", "a"])).toBe("plain text");
  });
});

describe("logger", () => {
  it("writes timestamped, levelled, redacted lines", () => {
    const lines: string[] = [];
    const log = createLogger({ secrets: ["tok-123456"], now: () => T, write: (l) => lines.push(l) });
    log.warn("feed silent", { endpoint: "https://grpc.example/?x-token=tok-123456" });
    expect(lines).toEqual(['2026-10-18T06:30:00.000Z WARN feed silent endpoint="https://grpc.example/?x-token=[redacted]"']);
  });

  it("writes JSON lines when asked, errors included", () => {
    const lines: string[] = [];
    const log = createLogger({ json: true, secrets: ["tok-123456"], now: () => T, write: (l) => lines.push(l) });
    log.error("send failed", new Error("401 for tok-123456"));
    expect(JSON.parse(lines[0]!)).toEqual({ ts: "2026-10-18T06:30:00.000Z", level: "error", msg: "send failed", error: "401 for [redacted]" });
  });

  it("routes console output through the logger", () => {
    const lines: string[] = [];
    const fakeConsole = { log: (..._a: unknown[]) => undefined, warn: (..._a: unknown[]) => undefined, error: (..._a: unknown[]) => undefined };
    routeConsole(createLogger({ secrets: ["hunter2-secret"], now: () => T, write: (l) => lines.push(l) }), fakeConsole);
    fakeConsole.log("started with", "hunter2-secret");
    fakeConsole.error("boom", new Error("bad hunter2-secret"));
    expect(lines).toEqual(["2026-10-18T06:30:00.000Z INFO started with [redacted]", "2026-10-18T06:30:00.000Z ERROR boom error=\"bad [redacted]\""]);
  });
});
