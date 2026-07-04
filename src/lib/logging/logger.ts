/**
 * Structured logger AWCMS-Mini (Pino) dengan redaction wajib (doc 10).
 * Jangan pakai console.* ad-hoc di jalur HTTP — gunakan child logger ber-requestId.
 */
import { pino, type Logger } from "pino";
import { getConfig } from "../config";
import { SENSITIVE_KEY_PATTERNS } from "./redact";

function buildRedactPaths(): string[] {
  // Redact key sensitif pada level atas dan satu tingkat bersarang umum.
  const paths: string[] = [];
  for (const key of SENSITIVE_KEY_PATTERNS) {
    paths.push(key, `*.${key}`, `req.headers.${key}`);
  }
  paths.push("req.headers.authorization", "req.headers.cookie");
  return paths;
}

let cachedLogger: Logger | undefined;

export function rootLogger(): Logger {
  if (!cachedLogger) {
    const config = getConfig();
    cachedLogger = pino({
      level: config.logLevel,
      base: { service: "awcms-mini", nodeId: config.node.nodeId },
      redact: { paths: buildRedactPaths(), censor: "[REDACTED]" }
    });
  }
  return cachedLogger;
}

export type RequestLogContext = {
  requestId: string;
  correlationId?: string;
  tenantId?: string;
  moduleKey?: string;
};

export function childLoggerForRequest(context: RequestLogContext): Logger {
  return rootLogger().child(context);
}

/** Untuk test: reset logger singleton. */
export function resetLoggerCache(): void {
  cachedLogger = undefined;
}
