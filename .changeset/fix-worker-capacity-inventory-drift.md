---
"awcms-mini": minor
---

feat(database): flag an undeclared worker instance count, and gate the worker inventory that drifted twice (#930)

Wave 4 of #930 asked for capacity/preflight coverage of control-plane
workloads. Checking what was actually missing turned up something narrower and
more concrete than the issue text implied.

**The worker inventory had gone stale in five places at once.** The capacity
runbook described the `worker` process class as "the 9 unattended background
scripts"; `capacity-config.ts` listed all nine by name; `client.ts`,
`config/registry.ts` (twice), and `work-class-registry.ts` each repeated the
count. The registry actually holds 24. `config/registry.ts` even carried the
annotation "(count corrected by Issue #743)" — so the number had already been
corrected once and drifted again, with nothing failing either time.

That is worse than an ordinary stale doc, because the runbook's advice on
sizing `DATABASE_CAPACITY_WORKER_INSTANCES_MAX` is stated in terms of "N
distinct scripts". A stale N is advice to under-budget connections.

All five now defer to `JOB_WORK_CLASS_REGISTRY` via a new
`countRegisteredWorkerJobs()`, and `tests/unit/capacity-worker-inventory-drift.test.ts`
fails if a literal count reappears in any of them. The gate found two of the
five itself — the first, narrower regex missed
`"9 already-shipped scripts"` sitting three lines from a phrasing it caught,
and the broadened version then found a fourth copy in `config/registry.ts`
that manual grepping had missed. The test asserts the pattern still matches
the exact phrasings that went stale, so it cannot be quietly weakened into a
gate that can never fail.

**New finding: `worker_instances_max_undeclared` (severity `warning`).**
`job-runner.ts`'s advisory lock guarantees no single job name overlaps itself,
which is what makes the default of `1` look safe. It says nothing about two
different scripts firing in the same cron minute, each opening its own
worker-role pool. The runbook always said so in prose, and nothing enforced it.

The finding deliberately does **not** demand a larger number — a deployment
whose cron is staggered is correct at 1. It demands that the number be
*declared*: an undeclared 1 means nobody has considered job overlap, and that
is the only case worth reporting. Declaring 1 silences it. To make that
distinction possible, `CapacityConfig` now carries `instanceCountsDeclared`,
and a malformed value (`MAX=tree`) counts as undeclared — it falls back to the
default, so treating it as a declaration would let a typo silence the warning
it should trigger.

It is a `warning`, never a `fail`: preflight must not start refusing to run
for every existing deployment, most of which are fine.
