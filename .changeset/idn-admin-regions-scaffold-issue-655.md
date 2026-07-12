---
"awcms-mini": minor
---

Scaffold the `idn_admin_regions` module (Issue #655, epic #654 — master
data wilayah administratif Indonesia dari `cahyadsn/wilayah`, MIT
License). Registers the `idn_admin_regions` module descriptor (`version
0.1.0`, `status experimental`, `type base`, depends on `identity_access`,
`logging`, `module_management`) in `src/modules/index.ts`, and seeds five
new ABAC permissions (`idn_admin_regions.region.read`,
`idn_admin_regions.dataset.read`, `.dataset.import`, `.dataset.activate`,
`.dataset.rollback`) via migration `048`. No dataset schema, vendored
source files, parser, import pipeline, activation/rollback, lookup API,
or admin UI yet — those land in later issues of the same epic (see
`.claude/skills/awcms-mini-idn-admin-regions/SKILL.md`).

Also fixes a false positive in `scripts/db-migrate.ts`'s
`assertNoTransactionControl` transaction-control guard: a migration
whose data literally contains the word "rollback" inside a quoted SQL
string literal (exactly this issue's own permission seed row) was
previously rejected as if it contained a top-level `ROLLBACK;`
statement. String literal contents are now stripped before the scan,
the same way dollar-quoted PL/pgSQL block bodies already were.
