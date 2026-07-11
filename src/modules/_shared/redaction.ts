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
 * WhatsApp/email/cookie/IP values to a response, log line, or audit
 * attributes.
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
  "email",
  "cookie"
] as const;

/**
 * Issue #687 — `"ip"` cannot join `REDACTION_KEYS` above as a plain substring:
 * `isSensitiveKey`'s `.includes()` check would then also match every key that
 * merely *contains* the letters "ip" consecutively — `description`,
 * `shipping`, `recipient`, `equipment`, `membership` all do — silently
 * mangling innocuous, non-sensitive fields. Verified before adding this list
 * (see `tests/audit-log.test.ts`'s negative fixtures). Instead this is an
 * exact-match allowlist of the actual key *shapes* an IP address field is
 * given in this codebase and in common upstream conventions, compared after
 * stripping every non-alphanumeric character — so `"ip"`, `"ipAddress"`,
 * `"ip_address"`, `"client-ip"`, `"remote_addr"`, and `"x-forwarded-for"` all
 * normalize to one of the entries below, while `"description"`/`"shipping"`/
 * `"recipient"` normalize to themselves and never match.
 */
const EXACT_SENSITIVE_KEY_SYNONYMS = new Set([
  "ip",
  "ipaddress",
  "clientip",
  "remoteaddr",
  "remoteaddress",
  "xforwardedfor"
]);

const REDACTED_VALUE = "[REDACTED]";

function normalizeKeyForExactMatch(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();

  if (
    REDACTION_KEYS.some((redactionKey) => normalized.includes(redactionKey))
  ) {
    return true;
  }

  return EXACT_SENSITIVE_KEY_SYNONYMS.has(normalizeKeyForExactMatch(key));
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
 *
 * This is a heuristic, not a DLP solution — trivially evaded by anyone who
 * actually wants to smuggle a secret through (splitting a JWT across two
 * fields, wrapping it in surrounding text or another encoding, adding
 * whitespace inside the pattern). It closes the "innocent/accidental paste"
 * gap the key-name check can't, not every adversarial exfiltration path.
 */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  // Third (signature) segment deliberately unbounded (`*`, not `{5,}`) —
  // PR #712 follow-up (security review): a truncated/short-signature JWT
  // (e.g. from a log line cut off mid-token) still leaks its header/payload
  // claims (`sub`/`tenant_id`/`roles`, etc) and must still be flagged.
  /^eyJ[a-zA-Z0-9_-]{5,}\.[a-zA-Z0-9_-]{5,}\.[a-zA-Z0-9_-]*$/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /^AKIA[0-9A-Z]{16}$/,
  /^(Bearer|Basic)\s+\S+/i,
  // Password character class deliberately excludes only `/` and whitespace
  // (not `:`/`@`, which are extremely common password characters) — PR
  // #712 follow-up (security review): the previous `[^:@/\s]+` class made
  // this pattern fail to match at all when the password itself contained
  // `:`, and truncate mid-password when it contained `@`. Relying on the
  // greedy `+` backtracking to the LAST `@` in the run (not the first) is
  // what correctly separates "password" from "host" when both `:` and `@`
  // appear inside the password itself.
  /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:@/\s]+:[^/\s]+@/
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

/**
 * Free-text complement to `isSensitiveKey` (Issue #687 — normalizing and
 * redacting server-side/worker error logging). `redactSensitiveAttributes`
 * only helps when a secret sits behind a sensitive *key* in a structured
 * object; a caught `Error`'s `.message`/`.stack` (or a nested `.cause` chain)
 * is unstructured prose that might echo a credential back verbatim (e.g. a
 * Postgres connection error containing the DSN, or a hand-rolled `` `password=${value}` ``
 * debug string) with no key at all to check. This is the generic sibling of
 * `src/modules/email/domain/email-log-redaction.ts`'s
 * `redactEmailAddressesInText` (which only handles the email-address shape)
 * — deliberately conservative, matching the same secret *shapes*
 * `SECRET_VALUE_PATTERNS` above already treats as essentially never a
 * legitimate thing to leave unredacted: a JWT, a PEM private key block, an
 * AWS access key id, a `Bearer`/`Basic` auth header value, a connection
 * string with an embedded `user:pass@` credential, or a `key=value`/
 * `key: value` pair whose key name looks like a credential. Same heuristic
 * caveat as `SECRET_VALUE_PATTERNS`: closes the "raw exception detail
 * accidentally contains a secret" gap, not a full DLP scanner.
 */
const TEXT_SECRET_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  replacement: string;
}> = [
  {
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED_PRIVATE_KEY]"
  },
  {
    // Fallback for a TRUNCATED PEM block with no matching END marker (a log
    // line cut off by a buffer/provider limit before the key finished) —
    // PR #712 follow-up (security review): without this, the paired
    // pattern above never matches at all in that case, and the entire raw
    // base64 key body passes through unredacted. Runs after the paired
    // pattern (which already consumed/replaced every well-formed block),
    // so it only ever finds a genuinely-unterminated one. Deliberately
    // over-redacts any trailing non-key text following a lone BEGIN marker
    // in this edge case — the safe direction, unlike leaving a key
    // unredacted.
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*$/g,
    replacement: "[REDACTED_PRIVATE_KEY]"
  },
  {
    // Third (signature) segment deliberately unbounded — see the matching
    // comment on `SECRET_VALUE_PATTERNS` above (PR #712 follow-up).
    pattern: /eyJ[a-zA-Z0-9_-]{5,}\.[a-zA-Z0-9_-]{5,}\.[a-zA-Z0-9_-]*/g,
    replacement: "[REDACTED_JWT]"
  },
  {
    pattern: /AKIA[0-9A-Z]{16}/g,
    replacement: "[REDACTED_AWS_KEY]"
  },
  {
    // Password character class deliberately excludes only `/` and
    // whitespace — see the matching comment on `SECRET_VALUE_PATTERNS`
    // above (PR #712 follow-up) for why `:`/`@` must be allowed inside it
    // and why the greedy `+` (backtracking to the LAST `@`) is required.
    pattern: /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^:@/\s]+:[^/\s]+@/g,
    replacement: "$1[REDACTED]@"
  },
  {
    pattern: /\b(Bearer|Basic)\s+\S+/gi,
    replacement: "$1 [REDACTED]"
  },
  {
    // `password=hunter2`, `password: "hunter2"`, `apiKey=abc123`, etc. — the
    // same credential-shaped key names as `REDACTION_KEYS` above, but here
    // matched inline within free text rather than as an object key. The
    // negative lookahead excludes a value starting with `Bearer `/`Basic ` —
    // that shape is already fully handled (scheme preserved) by the
    // `Bearer|Basic` pattern above; without the lookahead, an
    // `authorization: Bearer <token>` line would be redacted twice, once by
    // each pattern, garbling the scheme word.
    pattern:
      /\b(password|passwordHash|token|accessToken|refreshToken|apiKey|secret|credential|authorization)\b(\s*[:=]\s*)(?!(?:Bearer|Basic)\b)("[^"]*"|'[^']*'|\S+)/gi,
    replacement: "$1$2[REDACTED]"
  }
];

export function redactSecretsInText(text: string): string {
  let output = text;

  for (const { pattern, replacement } of TEXT_SECRET_PATTERNS) {
    output = output.replace(pattern, replacement);
  }

  return output;
}
