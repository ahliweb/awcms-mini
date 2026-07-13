# Data Lifecycle

Issue #745, epic #738 (`platform-evolution`), Wave 1. `type: "system"` —
ADR-0013 §1 classifies `data_lifecycle` as a System Foundation candidate,
the same layer as `logging`/`sync_storage`/`visitor_analytics`: platform
governance infrastructure every tenant shares the mechanism of, not a
tenant-facing business feature.

## Why this module exists

AWCMS-Mini already has several resource-specific retention/purge jobs
(`logs:audit:purge`, `analytics:purge`, `form-drafts:purge`, ...), each
hand-rolling its own retention semantics, batching, and audit trail. As
more high-volume tables accumulate (event outbox/delivery, webhook
inbox, sync queues, provider attempts, future usage/reporting
projections), that pattern doesn't scale — every module re-derives the
same governance questions (how long to keep data, whether to archive
before deleting, how legal holds interact with purge, how to batch
safely) slightly differently.

This module adds a **module-contributed registry** (a static, code-only
contract each owning module declares about its own high-volume tables)
plus a **safe lifecycle engine** (dry-run planning, bounded archive/
purge, legal holds) that operates on that contract — never on another
module's schema directly.

## What this module does NOT do

- **Own another module's table.** Per ADR-0013 §6 ("no shared-table
  write"), `data_lifecycle` never writes to `awcms_mini_audit_events`,
  `awcms_mini_visit_events`, or any other module's table directly. It
  owns exactly four tables of its own (below).
- **Duplicate an existing purge mechanism.** A table with an
  `executionMode: "delegated"` descriptor (e.g. `logging.audit_events`)
  keeps its existing job (`bun run logs:audit:purge`) as the sole
  mutator — this module only reads it for dry-run backlog visibility.
- **Assert one universal legal retention period.** Every descriptor
  declares its own `retentionClass`/bounds; see
  `docs/awcms-mini/data-lifecycle.md` §Pemetaan kepatuhan for why.
- **Automate partitioning.** `partition.eligible` is guidance/runbook
  metadata only — no descriptor in this PR triggers an actual
  `CREATE TABLE ... PARTITION OF` migration (issue #745 out of scope:
  "destructive migration of all existing tables in one PR").

## The descriptor contract (`HighVolumeTableDescriptor`)

Defined in `src/modules/_shared/module-contract.ts` (alongside
`ModulePermissionDescriptor`/`ModuleJobDescriptor`/etc. — same
"module declares its own array, a central aggregator reads
`listModules()`" shape). A module contributes one entry per high-volume
table in its own `module.ts`'s `dataLifecycle` array:

```ts
dataLifecycle: [
  {
    key: "logging.audit_events", // "<ownerModuleKey>.<tableShortName>", unique
    tableName: "awcms_mini_audit_events",
    ownerModuleKey: "logging", // must equal this module's own key
    scope: "tenant", // "tenant" | "global"
    cursorColumn: "created_at", // batching/ordering column
    retentionClass: "audit_security",
    retentionMinDays: 365,
    retentionMaxDays: 1825,
    defaultRetentionDays: 730,
    partition: { eligible: true, granularity: "monthly", rationale: "..." },
    archive: { archivable: false, rationale: "..." },
    deletion: { mode: "hard_delete", rationale: "..." },
    legalHold: { applicable: true, precedence: "overrides_retention" },
    requiredIndexes: [{ columns: ["tenant_id", "created_at"], purpose: "..." }],
    batchLimit: 5000,
    backupRestoreNotes: "...",
    executionMode: "delegated",
    existingAdopter: {
      jobCommand: "bun run logs:audit:purge",
      purgeFunctionRef:
        "src/modules/logging/application/audit-purge.ts#purgeExpiredAuditEvents",
      description: "..."
    }
  }
];
```

This is **trusted code-only metadata** — never tenant/request-controlled,
never itself duplicated into a mutable settings table (issue #745 scope:
"do not duplicate immutable descriptor facts in mutable settings").

### `executionMode`: `"delegated"` vs `"generic"`

- **`"delegated"`** — the owning module already has its own hand-rolled
  purge function/job. `data_lifecycle`'s engine may READ the table for a
  dry-run count (safe, read-only) but never mutates it. Requires
  `existingAdopter` documenting what it adopts.
- **`"generic"`** — no existing mechanism; the owning module opts the
  table into `data_lifecycle`'s own bounded archive/purge execution,
  using ONLY the metadata declared right here (table/tenant/cursor
  column names, batch limit) — never an unsanctioned cross-module schema
  access. Must NOT also declare `existingAdopter`.

**This PR's one `"generic"` adopter is `data_lifecycle`'s own run-history
table** (`data_lifecycle.data_lifecycle_runs`, declared in this module's
own `module.ts`) — the module dogfoods its own generic engine on data it
owns outright, which is also the only way to prove real (non-delegated)
archive/purge execution without reaching into another module's schema to
do it. Three existing tables are registered as representative
`"delegated"` adopters: `logging.audit_events`, `visitor_analytics.
visit_events`, `form_drafts.form_drafts`.

## Registry validation gate

`domain/lifecycle-registry.ts`'s `validateLifecycleRegistry` — pure
code, no I/O — checks every contributed descriptor: unique `key`/
`tableName`, `ownerModuleKey` matches the declaring module, valid
`scope`/`retentionClass`, `retentionMinDays <= defaultRetentionDays <=
retentionMaxDays`, partition/archive/deletion/legalHold policies
present and internally consistent (in particular:
`legalHold.applicable: true` MUST pair with `precedence:
"overrides_retention"` — this cannot be declared away), at least one
required index (a tenant+cursor composite specifically for `"generic"`
descriptors, whose bounded queries need it for query-plan safety —
`"delegated"` descriptors only need to document SOME index, since their
real query path is owned elsewhere), a sane `batchLimit`, and
`executionMode`/`existingAdopter` consistency.

Wired into `bun run check` via `bun run data-lifecycle:registry:check`
(`scripts/data-lifecycle-registry-check.ts`) — same shape as `modules:
dag:check`. Also re-checked by `security:readiness`'s
`checkDataLifecycleRegistryValid` (defense in depth: visible from the
go-live checklist too, not only CI).

## Legal holds

`domain/legal-hold.ts` (pure rules) + `application/legal-hold-service.ts`
(persistence + audit). A legal hold record — scope (a specific
descriptor key, or `null` for tenant-wide), reason, authority reference,
start/end, approval, audit — **overrides ordinary retention/purge**
whenever it applies, checked BEFORE anything else that could report a
row purgeable (`dry-run-planner.ts`'s `planLifecycleDryRun`, first
branch).

**Cannot be silently bypassed**: `legalHold.applicable` on a descriptor
is documentation/guidance only, deliberately NOT consulted by the
enforcement path (`evaluateLegalHoldForDescriptor`) — an actual hold
record targeting a descriptor's `key` (or tenant-wide) always applies,
regardless of what that descriptor's own metadata claims. Nor can a
`retentionDaysOverride` widen eligibility around a hold — the hold check
runs first and unconditionally.

**Default-deny release**: `legal_hold.create` and `legal_hold.release`
are separate permissions (`data-lifecycle-permissions.ts`) — a role
holding `create` does not implicitly hold `release`. Both are reason-
required, permission-gated, `Idempotency-Key`-required, and audited
`critical`.

## Dry-run lifecycle planning

`application/dry-run-planner.ts`'s `planLifecycleDryRun` — generic
across any `scope: "tenant"` descriptor, entirely `SELECT count(*)`
statements, zero mutation. Reports `eligibleCount`/`heldCount`/
`archivedCount`/`purgeableCount`/`blockedCount` (a descriptor with
`archive.archivable: false` reports `blockedCount: 0`, everything
eligible-and-not-held is immediately `purgeable`; an archivable
descriptor reports `blockedCount` for eligible rows not yet archived).
`planLifecycleDryRunForAllDescriptors` runs this across every
tenant-scoped descriptor, catching per-descriptor failures individually.

On-demand via `POST /api/v1/data-lifecycle/dry-run` (zero persistence,
no `Idempotency-Key` needed — genuinely zero side effect) or as part of
the scheduled job (which DOES persist a run-history row per descriptor
per tenant per invocation, for backlog-over-time visibility).

## Bounded archive/purge engine

`application/archive-purge-job.ts`'s `runDataLifecycleArchivePurge`,
wrapped by `scripts/data-lifecycle-archive-purge.ts` (`bun run
data-lifecycle:archive-purge`) using the shared worker runner
(`src/lib/jobs/*`, PR #713/Issue #697) — advisory lock, timeout,
SIGTERM/SIGINT-aware cancellation, JSON telemetry. No new locking/
batching mechanism is added here.

- Tenant-first iteration; legal holds re-fetched fresh per tenant per
  invocation (a hold created mid-backlog takes effect on the very next
  pass).
- `"generic"` descriptors: bounded archive pass (SELECT batch -> write
  via the archive port OUTSIDE any DB transaction -> record manifest +
  advance cursor in a new transaction), then a bounded purge pass
  (single-transaction bounded `DELETE ... RETURNING`, purging only rows
  already covered by an archive manifest when `archive.archivable`).
  Only `deletion.mode === "hard_delete"` is executed; a differently
  declared mode is refused (not silently mis-executed).
- `"delegated"` descriptors: a dry-run snapshot only, recorded to
  `awcms_mini_data_lifecycle_runs` — never mutated.
- `--dry-run` mode: no mutation for either kind, snapshot recorded.

### Timestamp precision (read before touching cursor comparisons)

Every cursor-boundary comparison in this file is padded by
`CURSOR_BOUNDARY_SAFETY_MARGIN_MS` (1ms). This is NOT decorative —
`timestamptz` has microsecond resolution but a value read back through
Bun.SQL as a JS `Date` only has millisecond resolution, silently
truncating the true value DOWN. An earlier version of this file compared
un-padded truncated values directly, which (confirmed empirically,
caught by this module's own large-volume integration test):

- **Purge upper bound** (`cursor <= archivedThrough`): permanently
  excluded the boundary row itself (one row short every single archive
  cycle — a real, undrained backlog remnant, not a rare edge case).
- **Archive resume lower bound** (`cursor > resumeAfter`): the boundary
  row satisfied its OWN resume filter again on every subsequent pass,
  looping until `DEFAULT_MAX_PASSES` (50) — re-archiving the same single
  row into up to 49 redundant manifests.

If you touch this file's boundary logic, re-run
`tests/integration/data-lifecycle-archive-purge-job.integration.test.ts`
(the large-volume test specifically) — it is the regression guard for
both.

## Provider-neutral archive port

`domain/archive-port.ts` (interface) + `infrastructure/local-archive-
adapter.ts` (the DEFAULT, only-implemented-in-this-PR adapter):
filesystem JSONL/CSV artifacts under `DATA_LIFECYCLE_ARCHIVE_ROOT_PATH`
(doc 18), SHA-256 checksummed, one manifest row per artifact
(`awcms_mini_data_lifecycle_archive_manifests`: location, row count,
cursor range, checksum, schema version, format, restore procedure
reference). `external_object_storage` is a valid `archive.port` value a
descriptor can declare (forward-compatible typing) but has no concrete
adapter yet — issue #745 scope says "optional external adapter", not
"required now".

Restore procedure: see `docs/awcms-mini/data-lifecycle.md` §Restore
procedure (local/offline archive) — `ArchivePort.read()` reads an
artifact back for reconciliation/testing; it deliberately never writes
back into the source table itself (that stays a manual, documented
operator procedure, same "no shared-table write" boundary).

## Schema (migration `057_awcms_mini_data_lifecycle_schema.sql`)

Four tenant-scoped tables (`ENABLE`+`FORCE ROW LEVEL SECURITY`) — this
module owns exactly these, never another module's table:

- **`awcms_mini_data_lifecycle_legal_holds`** — the one genuine runtime/
  tenant override this system needs.
- **`awcms_mini_data_lifecycle_cursors`** — bounded-job pause/resume
  state per (tenant, descriptor, phase).
- **`awcms_mini_data_lifecycle_archive_manifests`** — archive artifact
  evidence.
- **`awcms_mini_data_lifecycle_runs`** — dry-run/archive/purge execution
  history, categorized AGGREGATE counts only (never row contents/PII).
  Also a registered `"generic"` descriptor of its own (see above).

`awcms_mini_worker` grants are narrow and explicit (migration 057's own
tail): `SELECT` only on legal holds (the worker reads holds, never
creates/releases them — that stays an admin/API action via
`awcms_mini_app`), full DML on cursors/manifests/runs. `awcms_mini_app`
needs no explicit grant — all four tables are RLS-FORCE'd tenant-scoped,
already covered by migration 013's blanket `ALTER DEFAULT PRIVILEGES`.

## Permission seed (migration `058_awcms_mini_data_lifecycle_permissions.sql`)

Verbatim match to `domain/data-lifecycle-permissions.ts`'s
`DATA_LIFECYCLE_PERMISSIONS` (single source of truth reused by
`module.ts`, the migration, and every route handler):

| Permission key                      | Action    | Notes                                                              |
| ----------------------------------- | --------- | ------------------------------------------------------------------ |
| `data_lifecycle.registry.read`      | `read`    | Code-declared metadata only                                        |
| `data_lifecycle.legal_hold.read`    | `read`    |                                                                    |
| `data_lifecycle.legal_hold.create`  | `create`  | Does not imply release                                             |
| `data_lifecycle.legal_hold.release` | `release` | New `AccessAction` (Issue #745); default-deny separate from create |
| `data_lifecycle.plan.analyze`       | `analyze` | On-demand dry-run trigger                                          |
| `data_lifecycle.runs.read`          | `read`    | Aggregated counts only                                             |

## API (`src/pages/api/v1/data-lifecycle/*`)

- `GET /api/v1/data-lifecycle/registry` — list descriptors (metadata
  only).
- `POST /api/v1/data-lifecycle/dry-run` — on-demand plan for one
  descriptor.
- `GET /api/v1/data-lifecycle/runs` — run history.
- `GET`/`POST /api/v1/data-lifecycle/legal-holds` — list/create.
- `POST /api/v1/data-lifecycle/legal-holds/{id}/release` — release.

Real archive/purge execution is deliberately **not** exposed over HTTP —
same administrative-operation posture `scripts/audit-log-purge.ts`'s own
header documents ("not something any tenant-scoped role should be able
to trigger over the API").

## Configuration

One new env var: `DATA_LIFECYCLE_ARCHIVE_ROOT_PATH` (doc 18) — the local/
offline archive adapter's filesystem root. Everything else (retention
days, batch limits) is owned by each descriptor in code, or by a
delegated adopter's own existing env var (e.g.
`AUDIT_LOG_RETENTION_DAYS`) — never re-declared here.

## How to register a new high-volume table (playbook)

1. In your OWNING module's `module.ts`, add a `dataLifecycle: [...]`
   entry describing your table (see contract above). Pick
   `executionMode: "delegated"` if you already have a purge mechanism
   (the common case — keep it, just document it via
   `existingAdopter`), or `"generic"` only if you have none yet and want
   `data_lifecycle`'s engine to own bounded archive/purge for you.
2. Run `bun run data-lifecycle:registry:check` — fix any validation
   errors it reports (they name the exact field and why).
3. If `"generic"`: ensure your table has an `id uuid PRIMARY KEY` (this
   engine's bounded DELETE assumes it, per doc 04's global column
   standard) and the composite index the registry check demands.
4. Update `docs/awcms-mini/data-lifecycle.md` §Pemetaan kepatuhan and
   doc 04's retention table with your new descriptor's retention
   rationale — never assert one universal legal retention period.
5. Add a changeset.

## Known limitations

- **Cross-tenant/global-scope execution**: `scope: "global"` descriptors
  are accepted by the registry validator (forward-compatible typing) but
  the dry-run planner and archive/purge engine only implement the
  `scope: "tenant"` path end-to-end in this PR — a global-scope
  descriptor is skipped by `planLifecycleDryRunForAllDescriptors`/
  `runDataLifecycleArchivePurge`, not silently mis-executed. No
  registered descriptor today declares `scope: "global"`.
- **Cursor ties**: resume is strictly `cursor >= lastProcessed + 1ms`
  (archive) / `cursor <= archivedThrough + 1ms` (purge) — see "Timestamp
  precision" above. Two genuinely different rows landing within that
  same 1ms window at a batch boundary is a narrow, undocumented-as-
  eliminated edge case (not exercised by any registered descriptor's
  real write pattern).
- **External object-storage archive adapter**: not implemented (see
  Archive port above) — `local_offline` only.
- **No dedicated admin UI screen**: the API exists; a `/admin/data-
lifecycle` screen (registry browser, legal hold management, run
  history) is a reasonable follow-up, not required by this issue's
  acceptance criteria.
- **Partitioning is guidance only**: no automation, see "What this
  module does NOT do" above.
