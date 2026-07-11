---
"awcms-mini": minor
---

Normalize and redact server-side/worker error logging (Issue #687, epic
#679 platform-hardening) — narrow remediation on top of the existing
structured-logger/audit-trail foundation (Issue 10.1/#403/#447), not a
replacement for it.

Every admin SSR page (`src/pages/admin/**/*.astro`, 24 files) and CLI
worker script (`scripts/*.ts`, 19 files including `scripts/api-spec-check.ts`)
that used to call `console.error(label, error)` raw, or hand-extract
`error.message` via `error instanceof Error ? error.message : String(error)`
and print it directly, now goes through two new call-site helpers:
`logAdminPageError`/`logScriptFailure` (`src/lib/logging/error-log.ts`),
built on `sanitizeErrorForLog`/`safeErrorDetail`
(`src/lib/logging/error-sanitizer.ts`). Both redact a caught error's own
`.message`/`.stack` — including a nested `.cause` chain — via a new
`redactSecretsInText` (`src/modules/_shared/redaction.ts`), the free-text
complement to the existing key-based `redactSensitiveAttributes`: it masks
JWTs, PEM private key blocks, AWS access key ids, `Bearer`/`Basic` auth
header values, connection-string credentials, and `key=value`-shaped
secrets embedded in otherwise-unstructured exception text.

`REDACTION_KEYS` (key-based redaction) gains `"cookie"`. IP-address key
names (`ip`, `ipAddress`, `client_ip`, `remoteAddr`, `x-forwarded-for`,
etc.) are redacted via a new exact-match synonym allowlist rather than a
plain substring check — a substring `"ip"` would also match `description`/
`shipping`/`recipient`/`equipment`, which must NOT be redacted.

New gate `bun run logging:lint:check` (`scripts/logging-lint-check.ts`,
wired into `bun run check`) fails the build if the old raw
`console.error`/`console.warn` pattern reappears in
`src/pages/admin/**`, `src/pages/api/v1/**`, or `scripts/*.ts`.

Public API response shape (`fail()`/`ok()`) is unchanged — verified no
client-facing response ever included a raw `error.message`/`.stack`.
