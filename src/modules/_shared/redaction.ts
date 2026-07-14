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

/**
 * Sibling to `redactSensitiveAttributes` that also accepts a top-level JSON
 * *array* (Issue #785 — a batch-webhook provider body, e.g.
 * `integration_hub`'s normalized event payload/`raw_body_snippet`, is often
 * an array of records rather than a single object; `redactSensitiveAttributes`
 * above only ever recurses into a top-level *object*, so an array passed to
 * it directly would need the caller to map over it manually, and a caller
 * that forgot to would silently persist/log every element completely
 * unredacted).
 *
 * Deliberately a NEW, additive export rather than a change to
 * `redactSensitiveAttributes`'s own signature — every existing call site
 * (`logging/application/audit-log.ts`, `lib/logging/logger.ts`,
 * `domain-event-runtime/domain/payload-redaction.ts`) is typed to only ever
 * pass a plain object (or `undefined`), so widening that function's
 * parameter type could subtly change its inferred return type at each call
 * site (e.g. `logger.ts`'s `...redactedContext` object-spread) for zero
 * benefit to any of them. Reuses the same internal `redactValue` the object
 * path already calls per-property, so array/object/primitive/`null` all
 * behave identically to how `redactRecord` already treats a nested value at
 * any depth — only the TOP-LEVEL type accepted is wider here.
 *
 * `null` is returned unchanged (never coerced to `undefined` or `{}`) and
 * any primitive is returned as-is (nothing to recurse into) — both already
 * fall out of `redactValue`'s existing `Array.isArray` / `typeof === "object"`
 * checks with no special-casing needed here.
 */
export function redactSensitiveJsonValue(
  input: Record<string, unknown> | unknown[] | null | undefined
): Record<string, unknown> | unknown[] | null | undefined {
  if (input === undefined || input === null) {
    return input;
  }

  return redactValue(input) as Record<string, unknown> | unknown[];
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
  /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:@/\s]+:[^/\s]+@/,
  // --- Issue #785 (surfaced independently by both #750's and #754's
  // security review during epic #738 Wave 3): common vendor secret-key
  // formats, each anchored to the WHOLE value like the patterns above (this
  // function checks one already-isolated string value, not free text — see
  // `TEXT_SECRET_PATTERNS` below for the unanchored, embedded-in-prose
  // equivalents of the same shapes).
  //
  // GitHub personal access token, plus its OAuth/GitHub-App-installation
  // token siblings — `gho_` (OAuth), `ghu_`/`ghs_` (GitHub App
  // user-to-server/server-to-server), `ghr_` (refresh token) — added in
  // the PR #791 review round (security-auditor: same fixed-length real
  // format, 36 base62 chars after the prefix, and same blast radius as
  // `ghp_`, previously slipped through completely undetected).
  /^gh[opsru]_[A-Za-z0-9]{36}$/,
  // GitHub fine-grained personal access token — real tokens run much
  // longer than this floor, but the format has no official fixed length,
  // so `{22,}` only guards against a short non-secret string that merely
  // happens to start with the literal prefix.
  /^github_pat_[A-Za-z0-9_]{22,}$/,
  // OpenAI key — new project/service-account/admin-scoped keys
  // (`sk-proj-...`/`sk-svcacct-...`/`sk-admin-...`, the latter two added
  // in the PR #791 review round — same hyphenated body shape as
  // `sk-proj-`) run to 100+ characters and include `-`/`_`; classic keys
  // (`sk-...`) are ~48 alphanumeric characters with no separators.
  // Classic-key floor tightened from `{20,}` to `{40,}` in the PR #791
  // review round (reviewer: the comment above already says real classic
  // keys are ~48 chars, so a `{20,}` floor left unnecessary false-positive
  // room against a short internal `sk-`-prefixed code) — the hyphenated
  // family keeps its original `{20,}` floor since a legitimate real body
  // there already runs much longer regardless.
  /^sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}$/,
  /^sk-[A-Za-z0-9]{40,}$/,
  // Slack OAuth/app-level/legacy tokens — `xoxb`/`xoxp` (bot/user, already
  // covered) plus `xoxa` (app-level), `xoxe`/`xoxe.xoxp` (rotated/refresh),
  // `xoxs` (legacy workspace) — added in the PR #791 review round
  // (security-auditor: same privilege class, previously slipped through
  // completely undetected). Real tokens are hyphen-separated segments
  // (workspace id, bot/installation id, secret); `{10,}` after the prefix
  // is a floor, not the exact real length.
  /^xox(?:[abps]|e\.xoxp|e)-[A-Za-z0-9-]{10,}$/,
  // Stripe secret keys (live/test) and their same-privilege-class sibling
  // restricted keys (`rk_live_`/`rk_test_`) — added in the PR #791 review
  // round (security-auditor). Real keys run ~24+ alphanumeric characters
  // after the prefix.
  /^(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}$/,
  // Stripe webhook signing secret — added in the PR #791 review round
  // (security-auditor). Real secrets run much longer than this floor.
  /^whsec_[A-Za-z0-9]{20,}$/,
  // Google API key — fixed-length real format (`AIzaSy` + 33 chars from
  // `[A-Za-z0-9_-]`).
  /^AIzaSy[A-Za-z0-9_-]{33}$/,
  // Slack incoming-webhook URL — unanchored (unlike every pattern above)
  // because the value may legitimately carry a scheme prefix
  // (`https://`) or trailing query text; the three-segment
  // `/services/<T>/<B>/<secret>` path is what's actually diagnostic, not
  // the exact surrounding string.
  /hooks\.slack\.com\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+/
];

// Issue #785 — a generic high-entropy-string backstop (flag any long
// random-looking blob regardless of vendor prefix) was deliberately NOT
// added to the list above after evaluating it against this codebase's own
// realistic non-secret data: `profile_identity`/every other tenant-scoped
// table's UUID primary/foreign keys, `sync_storage`'s content hashes,
// idempotency keys, and correlation ids are ALL long, high-entropy-looking
// strings that are legitimately stored and returned every day. Unlike
// `social-publishing/domain/social-account-validation.ts`'s own
// `looksLikeRawSecretToken` (which applies a *whole-field* entropy check
// only to a field whose entire declared purpose is to hold a secret
// reference), `findSecretShapedValues`/`SECRET_VALUE_PATTERNS` here scan
// arbitrary metadata/settings values across every module — a blanket
// entropy heuristic at this generic layer would flag routine,
// already-legitimate identifiers constantly. Sticking to explicit
// vendor-prefix patterns keeps the false-positive rate near zero, at the
// accepted cost of missing any secret shape not on this list (documented
// residual, same caveat as the rest of this heuristic — see the file-level
// doc comment and this function's own doc comment below).

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
  // --- Issue #785: free-text equivalents of the vendor-prefix shapes added
  // to `SECRET_VALUE_PATTERNS` above — same formats, unanchored so they
  // match when embedded anywhere in prose (an error message, a stack
  // trace) rather than being the entire string.
  {
    // `{36,}` — a MINIMUM, not the exact `{36}` count `SECRET_VALUE_PATTERNS`
    // above uses. PR #791 review round (reviewer, Low): the pre-existing
    // `AKIA[0-9A-Z]{16}` pattern has the same fixed-length-match design and
    // wasn't changed here (real AWS ids are always exactly that length,
    // not exploitable today), but this free-text/log-scrubbing regex is
    // NEW, so an exact `{36}` here would leave any same-charset tail (e.g.
    // a token 4 characters longer than expected) sitting in plaintext
    // directly next to the `[REDACTED_GITHUB_TOKEN]` tag — the opposite of
    // what redaction is for. A minimum-length match sweeps the whole
    // same-charset run into the tag instead. Covers `ghp_` and its
    // OAuth/GitHub-App-installation siblings (`gho_`/`ghu_`/`ghs_`/`ghr_`)
    // in one pattern — see the matching comment on `SECRET_VALUE_PATTERNS`.
    pattern: /gh[opsru]_[A-Za-z0-9]{36,}/g,
    replacement: "[REDACTED_GITHUB_TOKEN]"
  },
  {
    pattern: /github_pat_[A-Za-z0-9_]{22,}/g,
    replacement: "[REDACTED_GITHUB_TOKEN]"
  },
  {
    // Hyphenated key family (`sk-proj-`/`sk-svcacct-`/`sk-admin-`) checked
    // first — see the matching comment on `SECRET_VALUE_PATTERNS` for why
    // the classic `sk-...` pattern's alphanumeric-only class can never
    // match one of these on its own (the literal `-` inside the family
    // name breaks that run), so ordering here is for readability, not
    // correctness.
    pattern: /sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/g,
    replacement: "[REDACTED_OPENAI_KEY]"
  },
  {
    // Floor tightened from `{20,}` to `{40,}` to match the anchored
    // pattern's tightening — see that comment on `SECRET_VALUE_PATTERNS`.
    pattern: /sk-[A-Za-z0-9]{40,}/g,
    replacement: "[REDACTED_OPENAI_KEY]"
  },
  {
    pattern: /xox(?:[abps]|e\.xoxp|e)-[A-Za-z0-9-]{10,}/g,
    replacement: "[REDACTED_SLACK_TOKEN]"
  },
  {
    pattern: /(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g,
    replacement: "[REDACTED_STRIPE_KEY]"
  },
  {
    pattern: /whsec_[A-Za-z0-9]{20,}/g,
    replacement: "[REDACTED_STRIPE_KEY]"
  },
  {
    // `{33,}` — a MINIMUM, not the exact `{33}` count `SECRET_VALUE_PATTERNS`
    // above uses — same tail-leak fix and rationale as the GitHub pattern
    // above (PR #791 review round, reviewer, Low).
    pattern: /AIzaSy[A-Za-z0-9_-]{33,}/g,
    replacement: "[REDACTED_GOOGLE_API_KEY]"
  },
  {
    pattern: /https?:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g,
    replacement: "[REDACTED_SLACK_WEBHOOK]"
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
