---
name: awcms-mini-saas-contracts
description: Konsumsi atau evolusikan registry kontrak SaaS build-time AWCMS-Mini (feature/quota/meter/commercial-event descriptor) yang jadi SINGLE SOURCE OF TRUTH untuk service_catalog (#870), tenant_entitlement (#871), dan usage metering (#875). Gunakan saat sebuah modul domain (di src/modules/) mengontribusikan feature/meter/quota/commercial-event, saat mengubah bentuk descriptor di ModuleDescriptor.serviceCatalog / SAAS_CONTRACT_VERSION, saat menyentuh validasi fail-closed (duplicate/owner/unit/bounds/aggregation/privacy), gate saas-contracts:registry:check, atau generated inventory. Sesuai Issue #874, epic #868, ADR-0022.
---

# AWCMS-Mini — SaaS Contract Registry (Issue #874)

Registry kontrak SaaS **build-time** = **satu sumber kebenaran** untuk identifier
komersial (feature / quota / meter / commercial-event). Menutup hutang drift
#870/#871 yang dulu mereplikasi agregasi key. Baca
`docs/awcms-mini/saas-contract-registry.md` +
`src/modules/_shared/saas-contract-registry.ts` +
`src/modules/_shared/module-contract.ts` (tipe `Saas*Descriptor`) sebelum mengubah.

## Peta file (SINGLE SOURCE)

- **Tipe descriptor + `SAAS_CONTRACT_VERSION`**: `src/modules/_shared/module-contract.ts`
  (`ServiceCatalogModuleContract` = `features`/`meters`/`quotas`/`commercialEvents`;
  `Saas*Descriptor`, enum privacy/valueType/aggregation/correction/enforcement/reset).
  Tipe-only, dependency-free — sama seperti seluruh descriptor family lain.
- **Aggregator + validator + membership**: `src/modules/_shared/saas-contract-registry.ts`
  (`resolveSaasContractRegistry`, `validateSaasContractRegistry`,
  `isKnownFeatureGrant`/`isKnownMeterKey`/`isKnownQuotaKey`/`isKnownCommercialEventType`,
  `isValidSaasKeyFormat`). Pure, tanpa I/O — aman di CI.
- **Consumer**: `service-catalog/domain/key-registry.ts` dan
  `tenant-entitlement/domain/entitlement-key-registry.ts` **RE-EXPORT** dari seam
  `_shared/` di atas. TIDAK ada lagi agregasi privat (drift-guard #871 tetap hijau
  karena keduanya delegasi ke fungsi yang sama).
- **Gate + generated**: `scripts/saas-contract-registry-check.ts`
  (`bun run saas-contracts:registry:check`, masuk `bun run check` + ci.yml) +
  `scripts/saas-contract-inventory-generate.ts`
  (`bun run saas-contracts:inventory:generate` → `docs/awcms-mini/saas-contract-registry.generated.{json,md}`).

## Cara kontribusi (modul domain di `src/modules/`)

Deklarasikan di `module.ts` milik modul sendiri (`ModuleDescriptor.serviceCatalog`),
JANGAN edit registry base. Kontribusi = tambah/kembangkan modul domain LANGSUNG di
`src/modules/` template ini (ADR-0024; tidak ada lagi jalur aplikasi-turunan / repo
terpisah). Contoh minimal (lihat `service-catalog/module.ts` untuk contoh netral +
fixture `tests/fixtures/example-domain-modules/modules/example-loyalty/module.ts`
untuk kontribusi modul domain dummy):

- **feature**: `{ key, ownerModuleKey, description }`.
- **meter**: `{ key, ownerModuleKey, description, eventVersion, valueType,
aggregation, correction, classification (billable|informational),
privacyClassification (WAJIB eksplisit), bounds:{minValue,maxValue} }`.
- **quota**: `{ key, ownerModuleKey, description, meterKey, unit, resetPeriod,
enforcement (hard|soft|advisory) }`.
- **commercialEvent**: `{ eventType, ownerModuleKey, eventVersion, kind
(lifecycle|commercial), description }` — `eventType` WAJIB juga ada di
  `events.publishes` modul (→ channel AsyncAPI).

Setelah ubah descriptor: `bun run saas-contracts:inventory:generate` lalu commit
JSON+MD (kalau tidak, gate freshness merah).

## Aturan fail-CLOSED yang ditegakkan validator (WAJIB dipahami)

Unknown/konflik → **gagal BUILD** (`saas-contracts:registry:check`) DAN runtime
validation closed (`isKnown*` → false). Yang ditolak:

- `ownerModuleKey` != key modul pendeklarasi (source ownership).
- duplicate key per-namespace + feature∩meter tidak boleh beririsan (ambiguitas
  override kind di #871).
- unit tak aman (`^[a-z][a-z0-9_]*$`, <=40).
- bounds: NaN/non-integer, `maxValue > MAX_SAFE_INTEGER` (overflow),
  `minValue > maxValue`, `minValue < 0` **kecuali** `correction: "signed_delta"`
  eksplisit (anti negative-abuse).
- aggregation konflik dengan valueType (`AGGREGATION_COMPATIBILITY`: mis. gauge tak
  boleh `sum`, count tak boleh `max`).
- `privacyClassification` hilang/invalid (WAJIB eksplisit — descriptor tak punya
  field payload mentah = "no raw sensitive payload by default").
- quota → meterKey menggantung (harus resolve ke meter yang ada).
- quota `enforcement: "hard"` atas meter `informational` (konflik).
- commercialEvent tak ada di `events.publishes` (parity AsyncAPI).
- field lama `contributesFeatureKeys`/`contributesMeterKeys` (deprecated #874) →
  pesan migrasi ke rich descriptor.

## Versioning (ikut SemVer, changeset)

`SAAS_CONTRACT_VERSION` (`module-contract.ts`) = versi bentuk kontrak SaaS. MAJOR bila
field/enum dihapus-retype atau aturan validasi mengetat; MINOR bila field/enum baru
opsional; PATCH dokumentasi. Versi kontrak SaaS divalidasi build-time oleh
`bun run saas-contracts:registry:check` (bagian `bun run check` + ci.yml). Perubahan
bentuk descriptor juga bump `MODULE_CONTRACT_VERSION` (`serviceCatalog` bagian darinya).

## Jangan

- JANGAN bikin daftar key privat baru di modul manapun — resolve dari seam `_shared/`.
- JANGAN edit registry base untuk kontribusi — deklarasikan di `module.ts` modul domain
  sendiri di `src/modules/`.
- JANGAN tambah field payload mentah ke meter descriptor (numeric-only by design).
- JANGAN lupa regen inventory + POT (line-number label nav bergeser) setelah edit
  `module.ts`.
