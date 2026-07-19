# Extension Contract Incompatible Fixtures (Issue #741)

Nine `extension.manifest.json` fixtures, each an exact clone of
[`../derived-application-example/extension.manifest.json`](../derived-application-example/extension.manifest.json)
(the COMPATIBLE case) with **exactly one deliberate defect** — proving
`bun run extension:check` fails for distinct reasons, not the same check
run five times (Issue #741 acceptance criterion: "At least five
incompatible fixtures prove the gates fail for distinct reasons").
Consumed by
[`tests/unit/extension-check-fixtures.test.ts`](../../unit/extension-check-fixtures.test.ts),
which spawns the REAL CLI (`bun run scripts/extension-check.ts --manifest=<fixture>`)
as a child process for each case and asserts both a non-zero exit code
and the SPECIFIC issue type in the printed report — not just that the
underlying validator function returns the right boolean.

| Fixture directory                 | Deliberate defect                                                                                                                                   | Primary issue type triggered               |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `base-version-range/`             | `compatibleAwcmsMiniRange` set to `">=99.0.0 <100.0.0"`, excluding this repo's real current version                                                 | `base_version_range_incompatible`          |
| `module-contract-version/`        | `moduleContractVersion` set to `"2.0.0"` — major differs from the real `MODULE_CONTRACT_VERSION`                                                    | `module_contract_version_unsupported`      |
| `saas-contract-version/`          | `saasContractVersion` set to `"2.0.0"` — major differs from the real `SAAS_CONTRACT_VERSION` (Issue #874)                                           | `saas_contract_version_unsupported`        |
| `unknown-capability/`             | Adds a `capabilities.requires` entry for `"totally_unknown_capability"`, unknown to both the base registry and the manifest's own `provides`        | `capability_unknown`                       |
| `capability-version-mismatch/`    | `public_content` required at version `"9.0.0"` — the base's real registered version is `"1.0.0"`                                                    | `capability_version_unsupported`           |
| `duplicate-migration/`            | The same `900_example_crm_schema.sql` entry declared twice in `historicalChecksums`                                                                 | `duplicate_migration_identifier`           |
| `migration-checksum-changed/`     | A historical checksum that does not match the real fixture SQL file's actual content                                                                | `migration_checksum_changed`               |
| `stale-api-contract/`             | `consumes.openApiContractVersion` set to `"5.0.0"` — the real OpenAPI contract is `"1.0.0"`                                                         | `stale_api_contract_assumption`            |
| `deployment-profile-unsupported/` | `example_crm`'s own `deploymentProfiles` narrowed to `["production", "staging"]` while `deployment.requiredProfiles` still requires `"offline-lan"` | `deployment_profile_unsupported_by_module` |

Every fixture reuses
[`../derived-application-example/sql/900_example_crm_schema.sql`](../derived-application-example/sql/900_example_crm_schema.sql)
as its `--migrations-dir` target (illustration-only SQL, never applied to
a real database) — only the JSON manifest differs between cases, so each
test run isolates its one intended failure instead of exercising a
different underlying registry/module shape per case.

## What this is not

Not a template for a real derived repository's own manifest — see
[`docs/adr/0015-derived-application-compatibility-manifest.md`](../../../docs/adr/0015-derived-application-compatibility-manifest.md)
and
[`docs/awcms-mini/derived-application-guide.md`](../../../docs/awcms-mini/derived-application-guide.md)
for that. These fixtures exist purely to prove the compatibility gates
reject each distinct incompatibility class end-to-end.
