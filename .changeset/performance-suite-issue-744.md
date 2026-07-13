---
"awcms-mini": minor
---

Add a reproducible performance suite (Issue #744, epic #738
platform-evolution): deterministic synthetic multi-tenant fixtures
(`src/lib/performance/fixture-generator.ts`/`fixture-seeder.ts`, safe/
standard/large scale profiles, one designated noisy-neighbor tenant),
load/mixed-workload/saturation-and-recovery scenarios covering every
work class (`bun run performance:suite`, reusing the resilience-drill
scenario-runner and safety interlock unchanged), and versioned
query-plan regression budgets for RLS-scoped pagination, full-text
search, outbox claim, retention-purge, and reporting queries
(`bun run performance:query-plan:check`), including an adversarial
regression fixture proving the gate genuinely fails a bad plan against
real PostgreSQL. Both commands produce a redacted machine-readable JSON
report plus a human Markdown summary, documenting hardware/container/
database configuration so results are comparable release-to-release.
The safe subset (small deterministic fixtures, five fast scenarios, six
query-plan budgets) runs on every PR via `.github/workflows/ci.yml`'s
`quality` job; the heavier `--full` lane (large fixture scale plus a
soak-stability scenario) is documented for scheduled/manual runs only.
See `docs/awcms-mini/performance-suite.md`.
