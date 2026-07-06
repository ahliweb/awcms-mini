import { redactSensitiveAttributes } from "../../modules/_shared/redaction";

/**
 * Structured JSON logger (Issue 10.1, doc 10 §Logger redaction). Independent
 * of the DB audit trail (`src/modules/logging/application/audit-log.ts`) —
 * "Audit melengkapi, bukan menggantikan, domain event & structured log" (doc
 * 10): these are two separate, complementary mechanisms, not the same one.
 * This logger has no I/O beyond `console.log`; nothing here touches the
 * database.
 */
export type LogLevel = "debug" | "info" | "warning" | "error";

export type LogContext = {
  correlationId?: string;
  tenantId?: string;
  moduleKey?: string;
  [key: string]: unknown;
};

const LOG_LEVEL_SEVERITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warning: 30,
  error: 40
};

function currentThreshold(): number {
  const configured = process.env.LOG_LEVEL as LogLevel | undefined;

  return LOG_LEVEL_SEVERITY[configured ?? "info"] ?? LOG_LEVEL_SEVERITY.info;
}

/**
 * One already-redacted structured log line, as passed to `console.log` and,
 * if registered, to the extension-point sink below.
 */
export type LogEntry = {
  timestamp: string;
  level: LogLevel;
  message: string;
  [key: string]: unknown;
};

/**
 * Extension point (Issue #447 — activating the logging system operationally,
 * not building a new one). `stdout`/`console.log` stays the source of truth
 * for every log line unconditionally (doc 20 §Batasan — capture/rotation is
 * a deployment-layer job: docker logging driver/systemd journal, not
 * application code) — this hook is purely *additive*: a derived application
 * (e.g. AWPOS) can register a consumer to forward already-redacted log
 * entries to its own alerting/export pipeline (ISO 27001 A.8.16) without
 * touching this file. Default is `null` (no-op) — zero behavior change for
 * every deployment that never calls `setLogSink`.
 *
 * Deliberately NOT a real SIEM/monitoring integration (out of scope per doc
 * 20 §Matrix kepatuhan A.8.16 and Issue #437's explicit scope boundary) —
 * just the pluggable point a real one would attach to. A sink must not
 * throw/block: it runs synchronously right after the line is written, and
 * any error it raises is caught and reported via a plain `console.error`
 * (never re-thrown) so a broken sink can never take down the app it's
 * attached to.
 */
export type LogSink = (entry: LogEntry) => void;

let registeredSink: LogSink | null = null;

export function setLogSink(sink: LogSink | null): void {
  registeredSink = sink;
}

/** Test/introspection helper — mirrors `resetRateLimitStoreForTests` style. */
export function getLogSink(): LogSink | null {
  return registeredSink;
}

/**
 * Writes one JSON line to stdout. Gated by `LOG_LEVEL` (default `"info"`) —
 * `debug` lines are only emitted when `LOG_LEVEL=debug`. Context is redacted
 * with the same `redactSensitiveAttributes` used by the audit trail, so a
 * caller can never accidentally leak a password/token/NPWP/phone/email into
 * a log line either.
 */
export function log(
  level: LogLevel,
  message: string,
  context?: LogContext
): void {
  if (LOG_LEVEL_SEVERITY[level] < currentThreshold()) {
    return;
  }

  const redactedContext = redactSensitiveAttributes(context);
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...redactedContext
  };

  console.log(JSON.stringify(entry));

  if (registeredSink) {
    try {
      registeredSink(entry);
    } catch (error) {
      // A derived app's sink is never allowed to break core logging.
      console.error(
        "Log sink threw — ignoring (Issue #447 extension point):",
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}
