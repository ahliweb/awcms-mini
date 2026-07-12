---
"awcms-mini": minor
---

Add a shared worker runner (`src/lib/jobs/job-runner.ts`, `./advisory-lock.ts`,
`./batching.ts`, `./retry-classification.ts`, Issue #697, epic #679) for
`scripts/*.ts` cron/systemd worker scripts: a per-job-name PostgreSQL advisory
lock (`pg_try_advisory_lock`, non-blocking, session-level) that safely
skips a concurrent duplicate run instead of both racing to mutate the same
data; a timeout + SIGTERM/SIGINT-aware cancellation with guaranteed lock
release on success, thrown error, timeout, or termination; generic bounded
tenant/item batching (`iterateTenantsInBatches`/`runBoundedBatches`,
generalizing the `MAX_PASSES_PER_TENANT` loop several scripts hand-rolled
independently); a retry classification helper (`classifyError`) that
reuses `tenant-context.ts`'s existing SQLSTATE-class split; and structured,
already-redacted JSON telemetry (via Issue #687's `sanitizeErrorForLog`) —
printed to stdout and optionally to `--json-output=<path>`, the same
pattern `production-preflight.ts` already established.

`scripts/audit-log-purge.ts` (tenant-iterating maintenance job) and
`scripts/modules-sync.ts` (non-tenant-loop job) are migrated to the new
runner as the two representative proofs-of-concept the issue calls for —
both gain a `--dry-run` mode and advisory-lock duplicate-run protection
with UNCHANGED mutation behavior for a normal (non-dry-run) invocation.
Every other existing scheduled script (`sync:objects:dispatch`,
`email:dispatch`, `blog:publish:scheduled`, `form-drafts:purge`,
`analytics:rollup`, `analytics:purge`) is intentionally left as-is —
adoption is incremental, not all-at-once (see
`docs/awcms-mini/deployment-profiles.md` §Shared worker runner).

No new orchestration platform, job queue, or external dependency is
introduced — this is an internal, in-process helper; scheduling remains an
external cron/systemd timer/container scheduler invoking `bun run <script>`
exactly as before.
