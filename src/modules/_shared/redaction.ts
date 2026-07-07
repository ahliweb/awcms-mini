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
  "credential",
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

function collectKeysDeep(value: unknown, keys: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectKeysDeep(item, keys);
    }
  } else if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(
      value as Record<string, unknown>
    )) {
      keys.add(key);
      collectKeysDeep(nested, keys);
    }
  }
}

/**
 * Every secret-shaped key present anywhere in `input` (recursively through
 * nested objects/arrays), by name — used to *reject* input containing a key
 * like `apiToken`/`credential` outright (module settings, Issue #516) rather
 * than silently redact-and-store it, since a value the app never persisted
 * can't leak later. `redactSensitiveAttributes` above stays the read-side/
 * defense-in-depth complement for values already at rest.
 */
export function findSensitiveKeys(
  input: Record<string, unknown> | undefined
): string[] {
  if (input === undefined) {
    return [];
  }

  const keys = new Set<string>();
  collectKeysDeep(input, keys);

  return [...keys].filter(isSensitiveKey);
}
