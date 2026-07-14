---
"awcms-mini": patch
---

Harden the shared secret/PII redaction utility (`src/modules/_shared/redaction.ts`,
Issue #785) — surfaced independently by two security audits during epic
#738 Wave 3 (PR #783/#750 reference-data, PR #784/#754 integration-hub).

`findSecretShapedValues`/`SECRET_VALUE_PATTERNS` (used to reject a
credential-shaped value pasted into an innocently-named module settings
field, e.g. `publicLabel`) and `redactSecretsInText`/`TEXT_SECRET_PATTERNS`
(the free-text complement used by admin-page/CLI-worker error logging)
previously only recognized JWT/PEM/AWS-`AKIA`/`Bearer|Basic`/embedded
connection-string credential shapes. Both now also detect common vendor
secret-key formats: GitHub personal access token (`ghp_...`) and
fine-grained PAT (`github_pat_...`), OpenAI key (`sk-proj-...`/`sk-...`),
Slack bot/user OAuth token (`xoxb-...`/`xoxp-...`) and incoming-webhook URL
(`hooks.slack.com/services/...`), Stripe secret key
(`sk_live_...`/`sk_test_...`), and Google API key (`AIzaSy...`). Each
pattern keeps a minimum-length floor after its prefix so a short,
innocuous value that merely shares a prefix (e.g. a `sk-`-prefixed SKU
code) is never false-flagged. A generic high-entropy-string backstop was
evaluated and deliberately NOT added — this codebase legitimately stores
many long, high-entropy-looking values (UUID keys, content hashes,
idempotency keys) that would false-positive constantly at this
cross-module layer; sticking to explicit vendor patterns keeps the
false-positive rate near zero (documented residual: any secret shape not
on the list is still undetected).

New sibling function `redactSensitiveJsonValue` recurses into a top-level
JSON *array* (not just a top-level object, which is all
`redactSensitiveAttributes` has ever handled) — for a future consumer
whose payload is an array of records (e.g. a batch-webhook provider body)
rather than a single object. Purely additive: every existing call site
(`logging/application/audit-log.ts`, `lib/logging/logger.ts`,
`domain-event-runtime/domain/payload-redaction.ts`) keeps calling the
unchanged `redactSensitiveAttributes` and is unaffected.

Adversarial unit tests added for every new vendor shape (fabricated,
non-canonical fixtures — same convention as the existing JWT fixture, to
avoid tripping GitGuardian's own shape-based secret scanning on this PR),
the array-recursion case, and negative fixtures (UUID, content hash, a
short `sk-`-prefixed code, an ordinary webhook URL) confirming no
over-blocking.
