# Fixture: contoh modul domain (example-domain-modules)

Kumpulan **test-support** in-repo berisi contoh modul _domain_ ilustratif yang
dipakai HANYA oleh test untuk menguji mesin komposisi/enforcement base terhadap
metadata modul realistis yang sengaja **tidak** di-ship oleh registry base
sendiri. **Bukan** modul nyata, dan **tidak pernah** terdaftar di registry base
(`src/modules/index.ts`) — hanya di-import oleh test yang membutuhkan contoh
metadata modul domain.

> **Sejarah (ADR-0024).** Fixture ini dulunya `derived-application-example/` dan
> mensimulasikan sebuah repo aplikasi-turunan (`ApplicationModuleRegistry` +
> `extension.manifest.json` + migration namespace 900–999). ADR-0024 menghapus
> jalur aplikasi-turunan — keluarga AWCMS kini template dipakai-langsung — jadi
> fixture direlokasi menjadi test-support non-derived: modul domain yang
> di-compose langsung dengan `listBaseModules()`.

## Isi

- `index.ts` — mengekspor `exampleDomainModules` (`readonly ModuleDescriptor[]`),
  daftar tiga contoh modul domain yang di-compose sebuah test dengan
  `listBaseModules()`.
- `modules/example-crm/module.ts` — satu modul domain contoh (`example_crm`)
  yang bergantung pada dua modul base (`tenant_admin`, `identity_access`),
  menyediakan capability `example_crm_directory`, serta permission/navigation/
  job — cukup untuk membuktikan setiap check komposisi (Issue #740) berjalan
  pada modul domain.
- `modules/example-loyalty/module.ts` — modul domain contoh (`example_loyalty`)
  yang bergantung pada `example_crm` (edge domain→domain) dan meng-konsumsi
  capability-nya sebagai binding wajib; juga menyumbang satu feature/meter/quota
  ke SaaS commercial contract registry (Issue #874) — membuktikan modul domain
  bisa menambah metadata komersial tanpa mengedit file registry base.
- `modules/example-erp-extension/` — modul domain contoh (`example_erp_extension`,
  Issue #755, ADR-0020) plus `posting-engine.ts` dan `period-lock-adapter.ts`
  yang menjalankan kontrak kesiapan ERP base (`_shared/business-transaction-contract.ts`,
  `_shared/ports/period-lock-port.ts`) end-to-end secara pure/in-memory —
  idempoten posting, period-lock fail-closed, penolakan cross-tenant/legal-entity,
  reversal-sebagai-transaksi-baru. Diuji `tests/unit/erp-extension-contracts.test.ts`.

## Cara pakai

Test menyusun daftar modul untuk di-feed ke fungsi komposisi/enforcement base,
mis. `[...listBaseModules(), ...exampleDomainModules]` untuk komposisi
(`tests/unit/module-composition-fixture.test.ts`), atau meng-import satu modul
langsung (`exampleErpExtensionModule`, `exampleLoyaltyModule`) untuk uji kontrak
spesifik. Lihat
`docs/adr/0024-awcms-family-direct-use-templates-and-derived-pathway-removal.md`
untuk keputusan menghapus jalur aplikasi-turunan.
