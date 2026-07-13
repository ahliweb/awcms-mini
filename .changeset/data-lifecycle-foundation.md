---
"awcms-mini": minor
---

Add the `data_lifecycle` System Foundation module (Issue #745, epic #738
`platform-evolution` Wave 1, ADR-0013 §1) — a module-contributed
high-volume table registry and safe lifecycle engine for retention,
partitioning guidance, archival, legal hold, and bounded purge.

- **Descriptor contract** (`HighVolumeTableDescriptor`,
  `src/modules/_shared/module-contract.ts`): owning modules declare their
  own high-volume tables (owner, tenant/global scope, cursor column,
  retention class + safe bounds, partition eligibility, archive policy,
  deletion behavior, legal-hold applicability/precedence, required
  indexes, batch limit, `"delegated"` vs `"generic"` execution mode) in
  their own `module.ts` — no shared-table writes, per ADR-0013 §6.
- **Registry validation gate** (`bun run data-lifecycle:registry:check`,
  wired into `bun run check`; also `security:readiness`'s
  `checkDataLifecycleRegistryValid`).
- **Legal holds** (`awcms_mini_data_lifecycle_legal_holds`) — scope,
  reason, authority reference, approval, audit, default-deny release
  (`legal_hold.create`/`.release` are separate permissions). Overrides
  ordinary retention/purge unconditionally, checked before any
  purge-eligibility branch, and cannot be bypassed by a
  `retentionDaysOverride` or by a descriptor declaring itself
  "not applicable" for holds.
- **Dry-run lifecycle planning** (`POST /api/v1/data-lifecycle/dry-run`)
  — zero-mutation, deterministic eligible/held/archived/purgeable/blocked
  counts for any registered descriptor.
- **Bounded archive/purge engine**
  (`bun run data-lifecycle:archive-purge`) built entirely on the shared
  worker runner (PR #713/Issue #697) — advisory lock, tenant-first
  batches, pause/resume cursors, retry classification. `"generic"`
  descriptors are archived (provider-neutral local/offline JSONL/CSV
  adapter, SHA-256 checksummed manifests) then purged;
  `"delegated"` descriptors (registered examples: `logging.audit_events`,
  `visitor_analytics.visit_events`, `form_drafts.form_drafts`) are only
  read for dry-run backlog visibility here — this engine never mutates
  them, real purge stays owned by each module's OWN existing job.
  `data_lifecycle`'s own run-history table
  (`awcms_mini_data_lifecycle_runs`) is the one `"generic"` adopter,
  proving real end-to-end execution without touching another module's
  schema. A legal hold created mid-invocation is re-checked at the start
  of EVERY batch pass (not just once per tenant per invocation), so it
  takes effect on the very next pass.
- **Legal hold now actually enforced by the 3 registered "delegated"
  adopters' own existing purge functions**
  (`purgeExpiredAuditEvents`/`purgeVisitorAnalyticsData`/
  `purgeExpiredFormDrafts`) — a `LegalHoldGuardPort`
  (`src/modules/_shared/ports/legal-hold-guard-port.ts`) lets each of
  these 3 modules ask "is my registered descriptor currently held?"
  without a forbidden circular cross-module import (Issue #685/ADR-0011);
  a held descriptor's real DELETE is skipped entirely. Without this, a
  hold created via the new API gave false confidence — `dry-run` would
  correctly report `purgeableCount: 0`, but the pre-existing scheduled
  purge jobs (untouched by the original version of this change) would
  still hard-delete the "held" rows on their normal schedule.
- **New API**: `GET /api/v1/data-lifecycle/registry`,
  `POST /api/v1/data-lifecycle/dry-run`,
  `GET /api/v1/data-lifecycle/runs`,
  `GET`/`POST /api/v1/data-lifecycle/legal-holds`,
  `POST /api/v1/data-lifecycle/legal-holds/{id}/release`. Real
  archive/purge execution stays an internal scheduled job, not exposed
  over HTTP (same posture as `logs:audit:purge`).
- New `AccessAction` value `"release"` (`identity-access/domain/
  access-control.ts`), classified high-risk.
- New config: `DATA_LIFECYCLE_ARCHIVE_ROOT_PATH` (doc 18).
- Fixed a real, empirically-confirmed timestamp precision bug found by
  this issue's own large-volume test: a cursor boundary value read back
  from Postgres as a JS `Date` loses microsecond precision, which
  previously made the purge upper bound silently exclude the boundary
  row (one row under-purged every cycle) and made the archive resume
  lower bound re-select the same boundary row on every subsequent pass
  (looping until the safety-bound pass limit). Both are fixed via a 1ms
  boundary safety margin — see `src/modules/data-lifecycle/README.md`
  §Timestamp precision. `dry-run-planner.ts`'s informational
  `archivedCount`/`purgeableCount` query now applies the SAME safety
  margin (shared via `domain/cursor-boundary.ts`), so the dry-run's
  reported counts never disagree with what the real purge pass actually
  deletes at the exact boundary row.
- CI's `quality` job (`.github/workflows/ci.yml`) now also runs
  `bun run data-lifecycle:registry:check` explicitly (it was already in
  `package.json`'s `check` composite, but not in CI's own hand-maintained
  step list).

Migrations `sql/057_awcms_mini_data_lifecycle_schema.sql` (four
tenant-scoped, RLS FORCE'd tables) and
`sql/058_awcms_mini_data_lifecycle_permissions.sql` (six permissions).
Docs: new `docs/awcms-mini/data-lifecycle.md` (operational guide +
UU PDP/PP PSTE/ISO 27001/27002/27005/27701/22301 compliance mapping,
without asserting one universal legal retention period),
`src/modules/data-lifecycle/README.md`, updates to doc 04 (ERD), doc 20
(threat model), `deployment-profiles.md`, `resilience-dr-verification.md`,
and a new skill (`.claude/skills/awcms-mini-data-lifecycle/`).
