# Performance Suite — Representative Load, Soak, and Query-Plan Regression Budgets

Issue #744 (epic #738 `platform-evolution`, Wave 1). Depends on the merged
deployment-aware capacity model (Issue #743,
[`database-capacity-runbook.md`](database-capacity-runbook.md)) and reuses
the DR/chaos drill's own safety interlock and scenario-runner shape (Issue
#699, [`resilience-dr-verification.md`](resilience-dr-verification.md))
rather than reinventing either. Companion to skill
`awcms-mini-performance` (audit/tuning discipline — "measure before you
optimize") and doc 07 §Performance test awal (illustrative POS targets a
derived application replaces with its own).

## Why this exists

Before this issue, "performance" in this repo meant ad hoc `EXPLAIN
ANALYZE` during a tuning pass (skill `awcms-mini-performance`) plus a
single micro-benchmark proving metrics recording itself doesn't add
material overhead (Issue #698,
`tests/unit/observability-metrics-performance.test.ts`). Neither proves
anything about representative multi-tenant scale, long-running memory
stability, RLS query plans at volume, or how interactive and reporting
workloads compete for the same connection pool under load. This issue
closes that gap with a reproducible suite: deterministic synthetic
fixtures, load/soak/mixed-workload/saturation-and-recovery scenarios, and
versioned query-plan regression budgets — all runnable locally, in CI
(safe subset), or on a schedule (full lane).

## Architecture

```text
src/lib/performance/
  prng.ts                    deterministic seeded PRNG (mulberry32) — the
                              root of every reproducibility guarantee below
  scale-profiles.ts          safe/standard/large scale profiles: documented
                              tenant count, per-table row counts, noisy-
                              neighbor multiplier, soak duration
  fixture-generator.ts       pure row generators (no I/O) — same seed +
                              profile always produces the same fixture plan
  fixture-seeder.ts          I/O: bulk-inserts generated rows via
                              withTenant (RLS-enforced, never a privileged
                              bypass) using the unnest(...) + sql.array(...)
                              pattern for speed
  metrics-aggregate.ts       pure: p50/p95/p99 latency, throughput, error
                              rate from raw call samples
  process-metrics.ts         thin I/O: process CPU/memory sampling, plus a
                              read-only passthrough to the REAL work-class
                              gate snapshot (getWorkClassSaturation) and
                              pg_stat_activity/pg_locks for connection/lock
                              signals
  redaction.ts               pure: DSN credential redaction, deterministic
                              per-run UUID pseudonymization
  query-plan-budgets.ts      pure: versioned regression-budget registry +
                              EXPLAIN (FORMAT JSON) evaluator
  query-plan-runner.ts       I/O: runs EXPLAIN under RLS, rolled back always
  workload.ts                I/O: one real, withTenant-gated operation per
                              work class (interactive/critical_transaction/
                              reporting/background_sync/maintenance)
  scenario-context.ts        shared mutable state (sql client, fixture
                              plan, scale profile) — set once by the
                              orchestrator, read by every scenario
  scenarios/*.ts              ScenarioDefinition implementations, REUSING
                              src/lib/resilience/scenario-runner.ts's exact
                              types (runScenario, computeDrOverall) — not a
                              parallel/duplicated runner
  report.ts                  machine-readable + human report builders,
                              with redaction applied before anything is
                              written to disk

scripts/
  performance-suite.ts            bun run performance:suite
  performance-query-plan-check.ts bun run performance:query-plan:check
```

## Safety interlock — reused, not reinvented

Both scripts import `authorizeDrDrill` from
`src/lib/resilience/target-guard.ts` UNCHANGED — the exact same
non-overridable production-target guard `scripts/dr-drill.ts` (Issue #699)
already uses:

- `APP_ENV=production` is refused unconditionally, no override flag.
- `DATABASE_URL`'s host must be a recognized local/isolated allowlist
  entry (default-deny for anything unrecognized).
- `--confirm-non-production=<APP_ENV value>` is a required typo-catcher.

See [`resilience-dr-verification.md`](resilience-dr-verification.md) for
the full safety-interlock flowchart — it applies identically here.

## Synthetic data — deterministic, configurable, documented distributions

`scale-profiles.ts` defines three versioned profiles:

| Profile    | Tenants | Noisy-neighbor multiplier | Soak duration | Used by                                   |
| ---------- | ------: | ------------------------: | ------------: | ----------------------------------------- |
| `safe`     |       5 |                        6x |   0 (skipped) | CI's `quality` job, both scripts' default |
| `standard` |      20 |                       10x |           60s | manual investigation                      |
| `large`    |      50 |                       15x |          600s | `--full` scheduled/manual lane            |

Every profile seeds eight representative tables per tenant — audit
(`awcms_mini_audit_events`), ABAC decisions
(`awcms_mini_abac_decision_logs`), analytics
(`awcms_mini_visitor_sessions`), outbox/delivery
(`awcms_mini_sync_outbox`), sync queue
(`awcms_mini_object_sync_queue`), idempotency
(`awcms_mini_idempotency_keys`), a representative tenant-scoped
business/content table (`awcms_mini_blog_posts`, also the full-text-search
and admin-post-list query-plan budgets' driving table), and its sibling
content table (`awcms_mini_blog_pages`, the admin-page-list budget's
driving table — added by Issue #838, which could not otherwise register
that budget: **a query-plan budget over an empty table is a vacuous gate**,
since PostgreSQL Seq Scans a 0-row relation regardless of which indexes
exist). The LAST tenant in every profile is
the designated noisy-neighbor tenant, whose row counts are multiplied —
never an accident of scale, always the same deterministic position for a
given seed.

All randomness flows through `prng.ts`'s seeded `mulberry32` generator —
`Math.random()`/`crypto.randomUUID()` never appear anywhere in the
generator, so `buildFixturePlan(profile, seed)` is byte-identical across
runs/machines for the same inputs (`tests/unit/performance-fixture-generator.test.ts`
proves this directly). Every string field is drawn from a small fixed
vocabulary — synthetic data only, never anything resembling a real
customer identifier, credential, or PII (the issue's own non-negotiable
requirement).

Row TIMESTAMPS are equally seed-deterministic, not just row counts/ids:
every `generate*` row generator computes `createdAt` relative to
`deriveDeterministicAnchor(seed)` — a pure function of the seed alone,
never `Date.now()`/`new Date()`. An earlier version of this suite
computed that anchor from the real wall clock at seed time, which meant
the same `(scaleProfile, seed)` pair produced different absolute row
timestamps depending on which real day the suite happened to run —
silently breaking release-to-release comparability. Both
`tests/unit/performance-fixture-generator.test.ts` and
`tests/integration/performance-fixture-seeder.integration.test.ts` assert
byte-identical `createdAt` values across two runs separated by a real
wall-clock gap.

Fixture seeding writes through `withTenant` (`fixture-seeder.ts`), the SAME
chokepoint every production mutation goes through — RLS is genuinely
enforced during seeding, not bypassed by a privileged connection, so a
freshly-seeded database is real proof that "RLS cross-tenant negative
tests remain active in the large-data environment" (an acceptance
criterion), not an assumption.

## Workload scenarios — real work-class-gated operations, not simulations

`workload.ts` maps the issue's workload-model list onto this repo's five
work classes (`src/lib/database/work-class.ts`), each going through the
real `withTenant`:

| Work class             | Workload model (issue's own list)  | Real operation                                                                                                     |
| ---------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `interactive`          | interactive API reads/writes       | RLS-scoped keyset-style audit-event read (same shape as `GET /api/v1/logs/audit`)                                  |
| `critical_transaction` | critical idempotent transactions   | Real idempotency store (`findIdempotencyRecord`/`saveIdempotencyRecord`)                                           |
| `reporting`            | reporting/analytics reads          | RLS-scoped severity-histogram aggregate                                                                            |
| `background_sync`      | sync/event/job workloads           | `FOR UPDATE SKIP LOCKED` outbox-claim probe (same shape as `object-dispatch.ts`)                                   |
| `maintenance`          | controlled degradation / retention | The REAL `purgeExpiredAuditEvents` (Issue #447), retention window set so it matches zero rows against fixture data |

Scenarios (`src/lib/performance/scenarios/*.ts`), each a `ScenarioDefinition`
reusing `src/lib/resilience/scenario-runner.ts`'s exact `runScenario`/
`computeDrOverall`:

| Scenario                         | Tier | What it proves                                                                                                                                                                                                                                                                                                 |
| -------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `interactive-load`               | safe | p50/p95/p99/throughput/error-rate under concurrent interactive reads                                                                                                                                                                                                                                           |
| `critical-transaction-integrity` | safe | N concurrent racers for the SAME idempotency key -> exactly 1 row persists (atomicity under load)                                                                                                                                                                                                              |
| `reporting-under-load`           | safe | Concurrent reporting reads never break concurrent critical-transaction correctness                                                                                                                                                                                                                             |
| `background-sync-claim-load`     | safe | `FOR UPDATE SKIP LOCKED` claim throughput/error-rate under concurrency                                                                                                                                                                                                                                         |
| `saturation-and-recovery`        | safe | **Core proof**: deliberately over-subscribes the real "maintenance" work-class gate (capacity 5), asserts the exact expected count of immediate `503 DATABASE_BUSY` + `Retry-After: 2` rejections, confirms the gate drains back to `active=0/queued=0`, and a follow-up call succeeds (recovery demonstrated) |
| `soak-stability`                 | full | Repeated interactive calls for the scale profile's `soakDurationMs`; asserts RSS growth stays under a generous ceiling (no unbounded growth) — self-skips at the `safe` profile (`soakDurationMs = 0`)                                                                                                         |

`saturation-and-recovery` is the concrete answer to the issue's own
"Saturation behavior matches #743 and recovery is demonstrated"
acceptance criterion — it does not simulate backpressure, it drives the
REAL bounded FIFO queue (Issue #743) to its documented capacity (`"maintenance"`'s
max concurrency 1 x (1 + default queue multiplier 4) = 5) and asserts on
the real, already-shipped 503+`Retry-After` behavior.

## Query-plan regression budgets

`query-plan-budgets.ts` is the versioned governance artifact — eight real
production query shapes: one per category Issue #744 names (RLS-scoped
pagination, full-text search, outbox claim, retention-purge batch,
reporting aggregate — plus a second RLS-pagination example), and the two
`admin_list` budgets Issue #838 added for the blog admin post/page lists.
Each carries:

- `forbiddenNodeTypes`/`requiredNodeTypesAny` — plan SHAPE assertions
  (e.g. "must never contain a Seq Scan", "must contain an Index/Bitmap
  scan").
- `maxTotalCost`/`maxExecutionTimeMs` — versioned numeric budgets.
- `approval: { approvedBy, approvedAt, reason }` — the "explicit process
  for approving intentional threshold changes" the issue requires. There
  is no env var or flag that widens a budget — the ONLY way to change one
  is a reviewable source diff to this file, the same governance pattern
  `src/lib/database/work-class-registry.ts`/
  `docs/awcms-mini/work-class-registry.generated.json` already established
  for a different drift-sensitive registry.

`query-plan-runner.ts` runs `EXPLAIN (FORMAT JSON, ANALYZE, BUFFERS)` for
each budget's real SQL text against a REAL, RLS-enforced connection
(`app.current_tenant_id` set via `SET LOCAL`, exactly like `withTenant`),
inside a transaction that is **always rolled back** — even the two
write-shaped queries (outbox claim's `UPDATE`, retention-purge's inner
`SELECT`) never permanently mutate seeded fixture data.

### The adversarial proof (why this gate can be trusted)

A checker that has only ever been exercised against already-good input
proves nothing about whether it can catch a real regression — exactly the
gap this epic's own sibling PRs (#769/#740, #770/#743) each shipped once
this wave. This issue ships TWO independent adversarial proofs:

1. **Pure-function proof** (`tests/unit/performance-query-plan-budgets.test.ts`)
   — hand-built `EXPLAIN` JSON containing a `Seq Scan`, asserting
   `evaluateQueryPlan` fails it.
2. **Real-Postgres proof**
   (`tests/integration/performance-query-plan-check.integration.test.ts`)
   — `REGRESSION_FIXTURE_QUERY`/`REGRESSION_FIXTURE_BUDGET`
   (`query-plan-runner.ts`, deliberately NOT part of the real
   `QUERY_PLAN_BUDGETS` registry) run the SAME table with the planner's
   index/bitmap-scan strategies forced off (`SET LOCAL enable_indexscan =
off`, etc.) for that one `EXPLAIN` — reproducing exactly what an
   incident with a missing/disabled/defeated index looks like in real
   `EXPLAIN` output, and asserting the gate genuinely reports a failing
   `Seq Scan` result against a REAL PostgreSQL planner, not just a
   hand-built fixture.

   (An earlier version of this fixture just added an unindexed `message
ILIKE` predicate on top of an indexed `tenant_id` filter — empirically,
   PostgreSQL still chose an efficient Index Scan on the `tenant_id`
   prefix with the extra predicate applied as a `Filter:`, because RLS
   always injects `tenant_id = current_setting(...)` and every RLS-scoped
   table here has a `(tenant_id, ...)`-leading index. Forcing the planner
   GUCs is the correct, honest way to reproduce "index missing/disabled",
   not a workaround for a flaky test.)

### Choosing a budget's signal: plan SHAPE first, cost second (Issue #838)

The five original budgets all forbid `Seq Scan`, so a new budget is
tempting to copy from them. Issue #838 measured what actually happens and
found that would have registered a **gate that passes the very regression
it exists to catch**:

| Blog admin post list, `safe` scale | Plan                                                     | Root cost |
| ---------------------------------- | -------------------------------------------------------- | --------- |
| `..._tenant_updated_idx` present   | `Limit -> Index Scan`                                    | 62.06     |
| index genuinely `DROP`ped          | `Limit -> Sort -> Bitmap Heap Scan -> Bitmap Index Scan` | 939.88    |

There is **no Seq Scan in the regression**. RLS always injects
`tenant_id = current_setting(...)`, and these tables have other
`(tenant_id, ...)`-leading indexes, so the planner just picks a different
index and adds a `Sort`. A `forbiddenNodeTypes: ["Seq Scan"]` +
`requiredNodeTypesAny: [..., "Bitmap Heap Scan"]` budget passes that plan
happily.

So an `admin_list` budget's primary signal is `Sort`/`Incremental Sort`
being **forbidden**: these queries exist to have their `ORDER BY` served
by the index's own order, and a sort node means that stopped being true —
whatever the cause (index dropped, `ORDER BY` column changed, a filter
defeating the partial predicate). `maxTotalCost` is the second,
independent line of defence, not the first.

`tests/unit/performance-query-plan-budgets.test.ts` pins this down against
the real measured plans above, **including an explicit assertion that the
naive Seq-Scan-only budget does NOT fire on the regression** — so the
budgets cannot be "simplified" back into vacuity. The paired integration
test goes further and performs the real `DROP INDEX` (restoring it in a
`finally`), which is the check Issue #838's own Definition of Done asks
for.

### Known limitation: the budgets' cost bound rides on stale statistics

The `EXPLAIN` cost a budget compares against is only meaningful if
PostgreSQL's planner statistics are accurate, and in this suite they
generally are **not**:

- Both scripts and the integration harness run as the least-privilege
  `awcms_mini_app` role, which does not own these tables. PostgreSQL
  **skips** an `ANALYZE` of a table the role does not own with a WARNING,
  not an error — so `beforeAll`'s `ANALYZE` in
  `performance-query-plan-check.integration.test.ts` is a silent no-op
  (verified against `pg_stat_user_tables.last_analyze`, which never
  changes).
- Issue #782 already root-caused the same class of problem for
  `audit-events-tenant-activity-reporting` (~11 pre-ANALYZE vs ~1088 once
  autovacuum catches up).

Consequences worth knowing before trusting or recalibrating any number
here:

- Plan-SHAPE assertions survive a bad statistics regime; cost assertions
  do not. Measured: with the index dropped, the same regression costs
  939.88 against an accurately-ANALYZEd database but ~8 in the integration
  suite — while the `Sort` node is present in **both**. This is the
  concrete reason `admin_list` budgets lead with shape.
- `blog-posts-fulltext-search` currently passes CI only because of this.
  Against a `VACUUM FULL ANALYZE`d database at the same `safe` scale it
  measures **939.5 against its approved `maxTotalCost` of 800** — i.e. it
  is latently red and would fail the moment the statistics become
  accurate. Fixing the no-op `ANALYZE` therefore requires recalibrating
  that budget in the same reviewed change (an approved threshold change,
  per the governance rule above) and is deliberately NOT bundled into
  Issue #838.

## Machine-readable + human report artifacts

Both scripts accept `--json-output=<path>` (machine-readable) and
`performance-suite.ts` additionally accepts `--report-path=<path>`
(concise human Markdown). Every report passes through `redaction.ts`'s
`redactReport` before being written — which runs THREE passes, in order:

- `redactDatabaseUrl` builds `environment.databaseUrlRedacted` at the
  source, keeping only `scheme://<redacted>@host:port/database`.
- `redactDsnPatternsDeep` is a defensive backstop over the WHOLE report
  tree (not just that one known field) that replaces any DSN-shaped
  substring embedded anywhere else — e.g. a raw `error.message` that
  leaked into a scenario's `detail` or a query-plan `finding` — the same
  way, wherever it appears.
- `redactUuidsDeep` is a second defensive backstop, also over the whole
  tree, that replaces any UUID-shaped SUBSTRING anywhere in the report
  (not only a value that is nothing but a UUID) with a stable per-run
  pseudonym (`id#1`, `id#2`, ...) — never the real tenant/user id.

The JSON report's `environment` section documents hardware/container/
database configuration explicitly (platform, arch, CPU count, total
memory, Bun version, scale profile, tenant count, planned row totals) plus
an explicit disclaimer: **numbers are comparable release-to-release on the
SAME environment, never a universal production capacity guarantee** — the
same disclosure doc 07's own "Performance test awal" table already makes
for its illustrative POS targets.

Example (redacted):

```json
{
  "environment": {
    "generatedAt": "2026-07-13T00:00:00.000Z",
    "appEnv": "test",
    "databaseUrlRedacted": "postgres://<redacted>@localhost:5432/awcms-mini",
    "scaleProfileId": "safe",
    "tenantCount": 5,
    "noisyNeighborMultiplier": 6,
    "totalSeededRowsPlanned": 37500,
    "hardware": {
      "platform": "linux",
      "arch": "x64",
      "cpuCount": 8,
      "totalMemoryMb": 16384,
      "bunVersion": "1.3.14"
    },
    "disclaimer": "Numbers reflect THIS container/hardware/database configuration..."
  },
  "tier": "safe",
  "overall": "pass",
  "scenarios": [
    /* ScenarioResult[] — name, tier, status, detail, durationMs, metrics */
  ],
  "queryPlanChecks": [],
  "seedSummary": {
    "tenantCount": 5,
    "rowCounts": { "...": "..." },
    "durationMs": 989
  }
}
```

## Safe subset vs. full lane

- **Safe (CI, every PR — `.github/workflows/ci.yml`'s `quality` job):**
  `bun run performance:suite -- --confirm-non-production=test` (default
  `safe` scale, 5 scenarios) and
  `bun run performance:query-plan:check -- --confirm-non-production=test`
  (6 registered budgets). Both run as the least-privilege `awcms_mini_app`
  role (a dedicated CI step activates its login first, mirroring
  `e2e-smoke`'s own established pattern — see ci.yml's own comments) so
  RLS is genuinely enforced, not bypassed. Together these complete in a
  few seconds against the `safe` fixture scale — comparable in cost to the
  existing DR-drill safe-tier step, not a material addition to PR CI time.
- **Full (`--full`, scheduled/manual only — NEVER wired into `bun run
check` or every-PR CI):**
  ```bash
  APP_ENV=staging DATABASE_URL=<staging-or-isolated-url> \
  bun run performance:suite -- --confirm-non-production=staging --full \
    --json-output=/tmp/performance-report.json \
    --report-path=/tmp/performance-report.md
  ```
  Uses the `large` scale profile by default (override with `--scale=`),
  adds the `soak-stability` scenario. Recommended cadence: alongside a
  release rehearsal or before a major infrastructure/capacity change, same
  discipline as `production-preflight-runbook.md`'s H-7/H-3 rehearsal and
  `resilience-dr-verification.md`'s full DR-drill cadence.

## Comparing two releases/commits

Run the safe or full lane with the SAME `--seed` on two different commits
(or against a before/after infrastructure change), diff the two
`--json-output` reports' `scenarios[].metrics` and `queryPlanChecks[]`
sections, and confirm `environment` matches closely enough to be
comparable (same scale profile, similar hardware). A metrics or
query-plan regression between the two runs is the signal to investigate —
not a hard CI gate on latency deltas (deliberately: absolute wall-clock
numbers are only ever comparable on matching hardware, per the report's
own disclaimer).

## Running locally

```bash
# Safe subset (fast, a few seconds):
APP_ENV=test DATABASE_URL=postgres://...@localhost:.../db \
bun run performance:suite -- --confirm-non-production=test
APP_ENV=test DATABASE_URL=postgres://...@localhost:.../db \
bun run performance:query-plan:check -- --confirm-non-production=test

# Full lane (large scale + soak, minutes):
APP_ENV=test DATABASE_URL=postgres://...@localhost:.../db \
bun run performance:suite -- --confirm-non-production=test --full
```

`DATABASE_URL` should point at the least-privilege `awcms_mini_app` role
(or any connection where RLS is genuinely enforced) — a superuser
connection will still run without error, but the RLS-enforcement proof
this suite exists to provide is only meaningful under the real
least-privilege role, exactly like every other RLS-sensitive integration
test in this repo.

## Known limitations

- Absolute latency numbers depend heavily on the container/hardware/
  database configuration they were measured on (see the report's own
  `disclaimer` field) — never presented as a universal production
  guarantee, per the issue's own non-negotiable requirement.
- The `soak-stability` scenario only runs in the `full` lane
  (`soakDurationMs > 0`); the `safe` lane cannot prove long-run memory
  stability by design (it must stay fast).
- Background job CONCURRENCY (as opposed to connection budget) is not yet
  gated through `work-class.ts` for the 9 real worker scripts (documented
  limitation, `database-capacity-runbook.md` §Known limitation, Issue
  #743) — this suite's `background_sync`/`maintenance` workloads exercise
  the WORK-CLASS gate directly (the mechanism this suite is built to
  prove), not the job-runner's own advisory-lock serialization, which
  already has its own dedicated proof (`worker-interruption` resilience
  scenario).

## Related documents

- [`database-capacity-runbook.md`](database-capacity-runbook.md) — the
  fleet-wide connection-budget model this suite's `saturation-and-recovery`
  scenario exercises the process-local half of (work-class gate, not
  cross-instance capacity).
- [`resilience-dr-verification.md`](resilience-dr-verification.md) — the
  target-guard/scenario-runner patterns this suite reuses directly.
- [`database-pooling.md`](database-pooling.md) — work-class concurrency
  ceilings/queue-depth formula this suite's scenarios drive to capacity.
- Skill `awcms-mini-performance` — the audit/tuning discipline this suite
  complements (measure -> find bottleneck -> fix -> re-measure).
