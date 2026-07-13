---
"awcms-mini": minor
---

Publish a derived-application compatibility manifest schema, reusable
test kit, and semantic-version gates (Issue #741, epic #738
`platform-evolution`, Wave 1, ADR-0015) — a new `bun run extension:check`
(`scripts/extension-check.ts`) validates a derived repository's own
`extension.manifest.json`/`.yaml` against this release's actual base
SemVer range, module-contract version (`MODULE_CONTRACT_VERSION`, new
`src/modules/_shared/module-contract.ts` export), capability contract
versions (new `src/modules/_shared/capability-contract-versions.ts`
registry), historical migration checksum immutability/ordering (reusing
`scripts/db-migrate.ts`'s own checksum primitives), declared deployment
profile requirements, and OpenAPI/AsyncAPI contract staleness — while
also always re-running Issue #740's `composeModuleRegistry` against the
real base + application registry.

Wired into three real gates so an incompatible manifest actually blocks
something (not just a standalone report): `package.json`'s `check`
composite, `.github/workflows/ci.yml`'s `quality` job as an explicit
named step, and `scripts/production-preflight.ts`'s stage list — the
same three places Issue #740's `modules:compose:check` was wired, for
the identical reasoning. Absent a manifest (this base repository's own
default state), the check passes trivially, so the base build is
unaffected.

Ships one compatible fixture
(`tests/fixtures/derived-application-example/extension.manifest.json`)
and eight incompatible fixtures
(`tests/fixtures/extension-contract-incompatible/`), each failing for a
genuinely distinct reason, proven both at the pure-function level
(`tests/unit/extension-compatibility.test.ts`) and via a real spawned CLI
process (`tests/unit/extension-check-fixtures.test.ts`). New dependency-
free SemVer utility at `src/lib/semver/compare.ts`. Documented in
`docs/adr/0015-derived-application-compatibility-manifest.md` and
`docs/awcms-mini/extension-compatibility-policy.md`.
