---
"awcms-mini": major
---

refactor(module-composition)!: hapus penuh jalur aplikasi-turunan (ADR-0024)

Menghapus permukaan yang khusus jalur aplikasi-turunan sesuai keputusan ADR-0024 (keluarga AWCMS = template dipakai-langsung, tidak ada repo derivatif): seam `src/modules/application-registry.ts`, gerbang `bun run extension:check` (`scripts/extension-check.ts`, dari script `check` + `.github/workflows/ci.yml` + `production:preflight`), konsep migration namespace turunan 900–999, tipe komposisi `ApplicationModuleRegistry`/`ModuleMigrationNamespace`, dan seluruh mesin manifest kompatibilitas turunan (`src/modules/module-management/domain/extension-compatibility.ts`, `src/modules/_shared/extension-manifest-contract.ts`, `src/modules/_shared/capability-contract-versions.ts`, `extension.manifest.json`).

`src/modules/module-management/domain/module-composition.ts` kini memvalidasi satu registry base (`validateComposedModuleRegistry(registry)`/`composeModuleRegistry(registry)`/`buildComposedModuleInventory(registry)` menerima `readonly ModuleDescriptor[]`, bukan `{ base, application }`); check turunan-only (`prohibited_base_override`, `invalid_module_type`, `migration_namespace_overlap`) dan `mergeModuleRegistries` dihapus. Check base-load-bearing (DAG, duplicate module key, capability binding, deployment profile, navigation, job descriptor) dipertahankan. `MODULE_CONTRACT_VERSION` naik `1.4.0` → `2.0.0` (MAJOR: tipe diekspor dihapus).

Fixture `tests/fixtures/derived-application-example/` direlokasi jadi test-support non-derived `tests/fixtures/example-domain-modules/` (mengekspor `exampleDomainModules`) — cakupan test #740 (komposisi), #755 (kontrak kesiapan ERP), dan #874 (SaaS commercial contract) dipertahankan setara. Gate `modules:compose:check` + `modules:composition:inventory:check` tetap ada (validasi registry base). Men-supersede ADR-0013/0014/0015, meng-amend ADR-0012/0020. Tanpa migration.
