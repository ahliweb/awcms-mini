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

  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      ...redactedContext
    })
  );
}
