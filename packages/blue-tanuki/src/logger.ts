/**
 * Structured logger — minimal, dependency-free.
 *
 * Design intent (Phase 4-S3):
 *   1. Replace ad-hoc `console.log("[scope] ...")` calls in gateway entry
 *      points with a logger that knows about scopes and structured fields.
 *   2. Keep the text format byte-compatible with the previous prefix style
 *      so operators reading existing runbooks see the same shape, and tests
 *      that grep stdout (smoke scripts, etc.) continue to match.
 *   3. Optional JSON mode for machine ingestion (local validation, log aggregators).
 *      JSON-mode output is one object per line with fixed top-level keys:
 *        ts, level, scope, msg, ...fields
 *
 * What this is NOT:
 *   - Not a full observability stack. No spans, no metrics export.
 *   - Not async. Writes go straight to stdout/stderr; reordering is best-effort.
 *   - Not a replacement for the audit chain. Logs are operational; the
 *     hash-chain is the tamper-evident record. They serve different purposes.
 *
 * Environment variables:
 *   BLUE_TANUKI_LOG_FORMAT = "text" (default) | "json"
 *   BLUE_TANUKI_LOG_LEVEL  = "debug" | "info" (default) | "warn" | "error"
 *
 * Failure mode: if either env var is malformed, we fall back to defaults
 * silently. Logging itself must never crash a process.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFormat = "text" | "json";

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LoggerOptions {
  scope?: string;
  level?: LogLevel;
  format?: LogFormat;
  /** Defaults to process.stdout.write / process.stderr.write. */
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** Defaults to () => new Date().toISOString(). Override for deterministic tests. */
  now?: () => string;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** Create a child logger with a sub-scope. */
  child(scope: string): Logger;
}

function parseLevel(raw: string | undefined): LogLevel {
  if (!raw) return "info";
  const v = raw.toLowerCase();
  if (v === "debug" || v === "info" || v === "warn" || v === "error") {
    return v;
  }
  return "info";
}

function parseFormat(raw: string | undefined): LogFormat {
  if (raw === "json") return "json";
  return "text";
}

/**
 * Resolve effective options from env + explicit overrides. Explicit options
 * take precedence; env fills in the rest with safe defaults.
 */
function resolve(opts: LoggerOptions): Required<Omit<LoggerOptions, "scope">> & {
  scope: string;
} {
  const env = (typeof process !== "undefined" ? process.env : {}) as NodeJS.ProcessEnv;
  return {
    scope: opts.scope ?? "blue-tanuki",
    level: opts.level ?? parseLevel(env.BLUE_TANUKI_LOG_LEVEL),
    format: opts.format ?? parseFormat(env.BLUE_TANUKI_LOG_FORMAT),
    out:
      opts.out ??
      ((line: string): void => {
        process.stdout.write(line + "\n");
      }),
    err:
      opts.err ??
      ((line: string): void => {
        process.stderr.write(line + "\n");
      }),
    now: opts.now ?? ((): string => new Date().toISOString()),
  };
}

class LoggerImpl implements Logger {
  private readonly scope: string;
  private readonly level: LogLevel;
  private readonly format: LogFormat;
  private readonly out: (line: string) => void;
  private readonly err: (line: string) => void;
  private readonly now: () => string;

  constructor(opts: LoggerOptions = {}) {
    const r = resolve(opts);
    this.scope = r.scope;
    this.level = r.level;
    this.format = r.format;
    this.out = r.out;
    this.err = r.err;
    this.now = r.now;
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.write("debug", msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>): void {
    this.write("info", msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.write("warn", msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>): void {
    this.write("error", msg, fields);
  }

  child(scope: string): Logger {
    return new LoggerImpl({
      scope,
      level: this.level,
      format: this.format,
      out: this.out,
      err: this.err,
      now: this.now,
    });
  }

  private write(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const sink = level === "warn" || level === "error" ? this.err : this.out;
    if (this.format === "json") {
      sink(this.renderJson(level, msg, fields));
    } else {
      sink(this.renderText(level, msg, fields));
    }
  }

  private renderText(
    level: LogLevel,
    msg: string,
    fields?: Record<string, unknown>,
  ): string {
    const fieldsPart =
      fields && Object.keys(fields).length > 0
        ? " " +
          Object.entries(fields)
            .map(([k, v]) => `${k}=${formatFieldText(v)}`)
            .join(" ")
        : "";
    // Level appears only for warn/error to keep info lines visually identical
    // to the legacy `[scope] msg` style and avoid breaking smoke-script greps.
    const levelTag = level === "warn" || level === "error" ? `${level.toUpperCase()} ` : "";
    return `[${this.scope}] ${levelTag}${msg}${fieldsPart}`;
  }

  private renderJson(
    level: LogLevel,
    msg: string,
    fields?: Record<string, unknown>,
  ): string {
    const obj: Record<string, unknown> = {
      ts: this.now(),
      level,
      scope: this.scope,
      msg,
    };
    if (fields) {
      for (const [k, v] of Object.entries(fields)) {
        // Avoid clobbering reserved keys.
        if (k === "ts" || k === "level" || k === "scope" || k === "msg") continue;
        obj[k] = v;
      }
    }
    return JSON.stringify(obj);
  }
}

function formatFieldText(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "string") {
    // Quote only when it contains whitespace, '=', or '"'; otherwise keep it
    // bare so log lines stay compact and grep-friendly.
    if (/[\s="]/.test(v)) return JSON.stringify(v);
    return v;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Construct a logger. Pass {scope} to set the prefix (e.g. "gateway").
 */
export function createLogger(opts: LoggerOptions = {}): Logger {
  return new LoggerImpl(opts);
}
