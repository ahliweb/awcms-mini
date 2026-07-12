---
"awcms-mini": minor
---

Add pending/orphan R2 media lifecycle cleanup and DB-vs-R2 reconciliation
for the news-portal R2-only media registry (Issue #690, epic #679
platform-hardening — "runtime/worker hardening" wave, following
#691/#689/#694/#695/#687/#697).

`bun run news-media:reconcile` (`scripts/news-media-r2-reconcile.ts`) is a
new job built directly on the shared worker runner (`src/lib/jobs/
job-runner.ts`, Issue #697) from day one. It is a complete no-op unless
`NEWS_MEDIA_R2_ENABLED=true`. Every run categorizes each active tenant's
`awcms_mini_news_media_objects` rows against a real R2 bucket listing into
five buckets: `healthy`, `orphanInDb` (DB expects an object R2 doesn't
have — report-only, never auto-mutated), `expiredPending`
(`pending_upload`/`uploaded`/`failed` rows past `NEWS_MEDIA_R2_PENDING_TTL_MINUTES`
— R2 object deleted then the row hard-deleted), `staleOrphaned`
(`status='orphaned'` rows past a new `NEWS_MEDIA_R2_ORPHAN_GRACE_DAYS`
grace period, default/minimum 30 days — R2 object deleted then the row
soft-deleted), and `orphanInR2` (an R2 object with no matching DB row at
all — a real gap left by `purgeNewsMediaObject` never deleting its own R2
object, closed asynchronously here).

Every mutation is an atomic, guarded UPDATE/DELETE re-verified at the
moment of the mutation — critically, `orphanInR2` candidates get an
additional immediate point-lookup recheck (`objectKeyExistsForTenant`)
right before deletion, so an object that just got a brand-new DB row
between this run's snapshot and its delete step is never removed. Reruns
are idempotent by construction (a cleaned-up row/object no longer matches
the next run's candidate criteria). A per-tenant R2 listing failure is
reported and skipped, never crashing the job or blocking another tenant's
run or unrelated database work.

`--dry-run` reports every category's counts with zero mutations.
Migration 046 adds `awcms_mini_news_media_objects.orphaned_at` (tracks
exactly when a row became orphaned, independent of `updated_at`) and grants
the least-privilege `awcms_mini_worker` role (Issue #683) the DML this job
needs. `config:validate` now enforces the new
`NEWS_MEDIA_R2_ORPHAN_GRACE_DAYS` 30-day minimum
(`checkNewsMediaR2OrphanGraceLowerBound`).

No local filesystem fallback and no binary payload in PostgreSQL — this
job only ever talks to Cloudflare R2 metadata/objects and
`awcms_mini_news_media_objects` metadata, and never logs signed URLs,
credentials, or object bytes.

`docs/awcms-mini/news-portal/r2-backup-lifecycle.md` gains a new Operator
SOP section; `18_configuration_env_reference.md`,
`full-online-r2-architecture.md` §4, and `deployment-profiles.md`'s job
registry/shared worker runner sections are updated to match.
