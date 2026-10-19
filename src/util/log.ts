/**
 * Logging: one line per event with an ISO timestamp and a level, as text
 * (journald-friendly) or JSON lines (CURVEALPHA_LOG_FORMAT=json), with every
 * secret masked. The process routes console output through it, so every
 * module's messages get the same treatment.
 *
 * Masked: the configured secret values (gRPC token, X bearer, Jito UUID,
 * anything else passed in), credentials in URLs (user:pass@host) and
 * key-like query parameters (api-key=, token=, x-token=, ...), which RPC
 * and gRPC providers commonly embed in endpoint URLs.
 */
export type Level = "info" | "warn" | "error";

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, err?: unknown, fields?: Record<string, unknown>): void;
}

const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const KEY_PARAMS = /([?&](?:api[-_]?key|x[-_]?token|access[-_]?token|token|key|secret|auth)=)[^&\s"']+/gi;

export function redact(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join("[redacted]");
  return out.replace(URL_CREDENTIALS, "$1[redacted]@").replace(KEY_PARAMS, "$1[redacted]");
}

const stringify = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

export function createLogger(o: { secrets?: Array<string | undefined>; json?: boolean; now?: () => number; write?: (line: string, level: Level) => void } = {}): Logger {
  const secrets = o.secrets ?? [];
  const now = o.now ?? Date.now;
  const write = o.write ?? ((line: string, level: Level) => (level === "info" ? process.stdout : process.stderr).write(line + "\n"));
  const emit = (level: Level, msg: string, fields: Record<string, unknown>) => {
    const ts = new Date(now()).toISOString();
    if (o.json) {
      write(redact(stringify({ ts, level, msg, ...fields }), secrets), level);
      return;
    }
    const tail = Object.entries(fields)
      .map(([k, v]) => ` ${k}=${typeof v === "string" ? JSON.stringify(v) : stringify(v)}`)
      .join("");
    write(redact(`${ts} ${level.toUpperCase()} ${msg}${tail}`, secrets), level);
  };
  return {
    info: (msg, fields = {}) => emit("info", msg, fields),
    warn: (msg, fields = {}) => emit("warn", msg, fields),
    error: (msg, err, fields = {}) => emit("error", msg, err === undefined ? fields : { ...fields, error: err instanceof Error ? err.message : stringify(err) }),
  };
}

type ConsoleLike = { log: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };

/** Send console.log / warn / error through the logger (strings joined, an Error becomes the error field). */
export function routeConsole(log: Logger, target: ConsoleLike = console): void {
  const split = (args: unknown[]) => {
    const err = args.find((a) => a instanceof Error);
    const text = args
      .filter((a) => a !== err)
      .map((a) => (typeof a === "string" ? a : stringify(a)))
      .join(" ");
    return { text, err };
  };
  target.log = (...a) => log.info(split(a).text);
  target.warn = (...a) => {
    const { text, err } = split(a);
    log.warn(text, err ? { error: (err as Error).message } : {});
  };
  target.error = (...a) => {
    const { text, err } = split(a);
    log.error(text, err);
  };
}
