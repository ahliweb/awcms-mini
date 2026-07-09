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

/**
 * Value-shape complement to `isSensitiveKey`/`findSensitiveKeys` (module
 * settings follow-up, epic #555 security audit — `validateModuleSettingsPatch`
 * only checked key *names*, so a credential could still be written into an
 * innocently-named field like `publicLabel` and stored/returned raw).
 * Deliberately conservative — only patterns that are essentially never a
 * legitimate label/URL/flag value — to keep false positives near zero:
 * a JWT (three base64url segments), a PEM private key block, an AWS access
 * key id, a raw `Bearer `/`Basic ` auth-header value, or a connection string
 * with an embedded `user:pass@` credential.
 */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /^eyJ[a-zA-Z0-9_-]{5,}\.[a-zA-Z0-9_-]{5,}\.[a-zA-Z0-9_-]{5,}$/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /^AKIA[0-9A-Z]{16}$/,
  /^(Bearer|Basic)\s+\S+/i,
  /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:@/\s]+:[^:@/\s]+@/
];

function isSecretShapedValue(value: unknown): boolean {
  return (
    typeof value === "string" &&
    SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))
  );
}

function collectSecretShapedValuePaths(
  value: unknown,
  path: string,
  paths: string[]
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectSecretShapedValuePaths(item, `${path}[${index}]`, paths)
    );
    return;
  }

  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(
      value as Record<string, unknown>
    )) {
      collectSecretShapedValuePaths(
        nested,
        path ? `${path}.${key}` : key,
        paths
      );
    }
    return;
  }

  if (isSecretShapedValue(value)) {
    paths.push(path);
  }
}

/**
 * Every key path (dot notation, e.g. `webhook.publicLabel`, array indices as
 * `[n]`) whose string value looks like a credential, *regardless of the
 * key's own name* — used to reject module settings patches the same way
 * `findSensitiveKeys` rejects a secret-shaped key name: a value the app
 * never persisted can't leak later. Never includes the value itself, only
 * the path, so the rejection message stays safe to return to the client.
 */
export function findSecretShapedValues(
  input: Record<string, unknown> | undefined
): string[] {
  if (input === undefined) {
    return [];
  }

  const paths: string[] = [];
  collectSecretShapedValuePaths(input, "", paths);

  return paths;
}
