/**
 * Cross-cutting redaction (doc 10 §Logger redaction, skill
 * `awcms-mini-sensitive-data`, skill `awcms-mini-audit-log`). Shared by both
 * the DB audit trail (`src/modules/logging/application/audit-log.ts`) and the
 * structured JSON logger (`src/lib/logging/logger.ts`) so the redaction key
 * list is defined exactly once.
 *
 * Pure function, no I/O: any object key whose name *contains* (case
 * insensitive) one of the redaction keys below has its value replaced with
 * the literal string `"[REDACTED]"`, recursively through nested objects and
 * arrays of objects. Never send raw password/token/API key/NPWP/NIK/phone/
 * WhatsApp/email values to a response, log line, or audit attributes.
 */
const REDACTION_KEYS = [
  "password",
  "passwordhash",
  "token",
  "accesstoken",
  "refreshtoken",
  "apikey",
  "secret",
  "authorization",
  "npwp",
  "nik",
  "phone",
  "whatsapp",
  "email"
] as const;

const REDACTED_VALUE = "[REDACTED]";

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();

  return REDACTION_KEYS.some((redactionKey) =>
    normalized.includes(redactionKey)
  );
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }

  if (value && typeof value === "object") {
    return redactRecord(value as Record<string, unknown>);
  }

  return value;
}

function redactRecord(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    output[key] = isSensitiveKey(key) ? REDACTED_VALUE : redactValue(value);
  }

  return output;
}

export function redactSensitiveAttributes(
  input: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (input === undefined) {
    return undefined;
  }

  return redactRecord(input);
}
