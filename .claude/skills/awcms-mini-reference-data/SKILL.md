---
name: awcms-mini-reference-data
description: Kerjakan bagian mana pun dari modul reference_data AWCMS-Mini (Issue #750, epic platform-evolution #738 Wave 3, ADR-0021; fix #822). Gunakan saat menambah/mengubah endpoint di src/modules/reference-data, saat modul lain mengontribusikan value set lewat referenceData.contributesValueSets di module.ts-nya, saat menyentuh import dry-run/commit/rollback, atau saat mengubah resolusi baseline+tenant override. Merangkum batas global-vs-tenant-scoped dan semantik PATCH parsial yang wajib dipertahankan.
---

# AWCMS-Mini — Reference Data Module

`reference_data` (`src/modules/reference-data`, Issue #750, epic
`platform-evolution` #738 Wave 3, admission decision
`docs/adr/0021-reference-data-module-admission.md` — dinomori ulang dari
ADR-0018 untuk menyelesaikan tabrakan penomoran lintas-PR, lihat index
`docs/adr/README.md`) adalah **Official Optional Business Foundation**
(ADR-0013 §1) — fondasi reference data provider-neutral, opt-in per tenant,
generik untuk setiap aplikasi turunan.

Baca `src/modules/reference-data/README.md` untuk peta tabel/endpoint.
Skill ini merangkum yang **tidak jelas dari membaca satu file**: batas
global-vs-tenant-scoped (satu-satunya modul opsional di repo ini yang punya
tabel GLOBAL tanpa RLS), alur import 3-fase, dan semantik PATCH parsial.

## Kapan pakai skill ini vs skill generik

Melengkapi (bukan menggantikan) `awcms-mini-new-endpoint`,
`awcms-mini-new-migration`, `awcms-mini-idempotency`,
`awcms-mini-abac-guard`. Pakai skill ini untuk konteks
`reference_data` spesifik: kapan sebuah katalog jadi module-contributed vs
platform-curated, aturan override tenant, dan invariant import.

## Yang dimiliki modul ini

- **Value sets** (`awcms_mini_reference_value_sets`) — katalog bernama
  stabil (mis. `"currency"`, `"unit_of_measure"`, `"fiscal_calendar"`).
  `scope` membedakan `module_contributed` (dideklarasikan statis di
  `module.ts` modul lain, disinkronkan `application/contribution-sync.ts`)
  dari `platform_curated` (dibuat lewat API modul ini sendiri).
  `overridePolicy` mengatur apa yang boleh dilakukan tenant.
- **Codes** (`awcms_mini_reference_codes` + `_code_translations`) — satu
  baris per kode dalam value set, effective-dated, terlokalisasi, dengan
  provenance + deprecation/supersession. **Tidak pernah hard-delete** sekali
  direferensikan override/extension tenant.
- **Import batches** (`awcms_mini_reference_imports`) — satu baris per batch
  dry-run/commit.
- **Tenant overrides/extensions** (`awcms_mini_reference_tenant_codes` +
  `_tenant_code_translations`) — TENANT-SCOPED. Override (`baseCodeId` diisi)
  menyatakan ulang atribut kode baseline untuk satu tenant saja; extension
  (`baseCodeId` null) adalah kode baru definisi tenant. **Tidak pernah**
  menulis ke tabel baseline global.

## CRITICAL — global vs tenant-scoped

Empat tabel pertama di atas **GLOBAL**: tidak ada kolom `tenant_id`, tidak
ada RLS — identik untuk setiap tenant secara desain, pola reviewed-exempt
yang sama dengan `awcms_mini_permissions`/`awcms_mini_modules`/
`awcms_mini_idn_admin_regions` (terdaftar di
`scripts/security-readiness.ts`'s `RLS_FREE_TABLES` dan
`ALLOWED_GLOBAL_TABLE_GRANTS`).

Konsekuensi operasional yang HARUS dipahami sebelum menyentuh modul ini:
**codebase ini tidak punya konsep "platform superadmin" terpisah**. Memutasi
tabel global tetap lewat request tenant-authenticated biasa dengan permission
`reference_data.*` yang tepat. Jadi `reference_data.value_sets.*`/`.codes.*`/
`.imports.*` **harus** diberikan sangat sempit — aksi-aksi itu mempengaruhi
baseline yang dipakai SETIAP tenant, bukan cuma tenant si caller. Jangan
tambahkan endpoint baru yang memutasi tabel global tanpa menyadari ini.

Dua tabel tenant-scoped memakai `ENABLE`+`FORCE ROW LEVEL SECURITY` dengan
predikat yang selalu dan hanya `tenant_id`.

## CRITICAL — semantik PATCH parsial (Issue #822)

`PATCH /tenant-codes/{id}` dan `PATCH /value-sets/{key}/codes/{code}` dulu
**berperilaku sebagai PUT**: field yang dihilangkan dari body direset diam-diam
ke default (`sortOrder` → `0`, `metadata` → `{}`, `validFrom` → `now()`,
`validTo` → `null`), menjawab `200` tanpa peringatan. Klien yang mengirim PATCH
parsial — semantik normatif PATCH — kehilangan data. Ini reference data yang
bisa jadi acuan dokumen/transaksi turunan, sehingga `validFrom`/`validTo`
bersifat load-bearing.

Sekarang ditangani `domain/code-patch.ts` — pakai ini, jangan parse body
manual di route:

- `parseReferenceCodePatchInput(body)` — per field: **absen** = pertahankan
  nilai tersimpan, **`null` eksplisit** = kosongkan ke nilai kosong field itu
  (`sortOrder` → `0`, `metadata` → `{}`, `validTo` → `null`), nilai lain =
  ganti. `validFrom` (`NOT NULL` di schema) dan `labels` (selalu butuh minimal
  satu entri) **menolak** `null` eksplisit, bukan diam-diam di-default.
- `mergeReferenceCodePatchInput(existing, patch)` — field absen dibawa
  verbatim dari record tersimpan.
- **Unknown key ditolak** (`KNOWN_PATCH_FIELDS`). Kedua schema PATCH
  `additionalProperties: false`, tapi parser yang membaca key yang dikenal dan
  mengabaikan sisanya mengubah typo klien (`validUntil` untuk `validTo`) jadi
  patch kosong — digabung cabang no-op empty-patch, typo itu menjawab `200`
  dan tidak mengubah apa pun: request TERLIHAT diterima sambil tidak
  melakukan apa-apa (temuan review PR #839).
- `KNOWN_PATCH_FIELDS` sengaja diletakkan di sebelah blok per-field: menambah
  field tanpa mendaftarkannya di situ membuat test field itu langsung gagal
  (ditolak sebagai unknown), bukan diabaikan diam-diam.

Saat merapikan route ini, **jangan** ubah
`computeRequestHash({ ...body, id, action: "update" })` — pengikatan `id` ke
hash idempotency itu sudah benar dan wajib (lihat `awcms-mini-idempotency`
§CRITICAL).

Pola "default-in-parse" yang sama layak di-grep di endpoint PATCH lain:
`: new Date()` dan `?? {}` di parse body.

## Module-contributed catalogs — tanpa import tabel langsung

Modul lain mendeklarasikan katalognya sendiri secara statis di `module.ts`-nya:

```ts
export const myModule = defineModule({
  // ...
  referenceData: {
    contributesValueSets: [
      {
        key: "my_value_set",
        name: "My Value Set",
        description: "...",
        overridePolicy: "tenant_extend",
        codes: [{ code: "A", labels: [{ locale: "en", label: "A" }] }]
      }
    ]
  }
});
```

Divalidasi `domain/contribution-registry.ts`
(`bun run reference-data:contributions:check`, tersambung ke `bun run check`
dan CI) dan disinkronkan ke tabel modul ini oleh
`application/contribution-sync.ts` (`bun run reference-data:contributions:sync`)
— **langkah operasional eksplisit, tidak pernah dipanggil otomatis oleh kode
modul lain**. Modul ini mengapalkan kontribusi contohnya sendiri
(currency/unit-of-measure/fiscal-calendar, `application/seed-contributions.ts`)
lewat mekanisme yang sama persis, sebagai demonstrasi netral — baca header file
itu untuk caveat "tidak komprehensif, bukan otoritas regulasi". Jangan
perlakukan seed itu sebagai daftar authoritative.

## Import tervalidasi — 3 fase (`application/import-service.ts`)

1. **Dry-run** (`POST /value-sets/{key}/imports`) — menghitung diff terhadap
   baseline code `provenance = "import"` yang ada. **Tidak pernah** memutasi
   `awcms_mini_reference_codes`. Mempersist baris
   `awcms_mini_reference_imports` (`status: "validated"`/`"rejected"`) dengan
   ringkasan diff + checksum.
2. **Commit** (`POST /imports/{id}/commit`) — memverifikasi ulang checksum
   **dan menjalankan ulang perhitungan diff penuh DI DALAM transaksi yang sama
   dengan write**. Jangan "optimasi" ini jadi percaya hasil dry-run saja —
   data bisa berubah sejak dry-run. **Menolak** (seluruh transaksi, tanpa
   partial write) setiap entri payload yang meminta `replace: true` terhadap
   kode yang sudah direferensikan override/extension tenant.
3. **Rollback** (`POST /imports/{id}/rollback`) — membalik efek kumulatif batch
   yang sudah di-commit: menghapus kode yang dibuatnya (hanya bila masih tidak
   direferensikan — menolak bila tidak, ini limitation yang terdokumentasi di
   recovery notes, **bukan** bypass diam-diam), memulihkan snapshot atribut
   sebelumnya untuk kode yang diupdate, dan meng-undeprecate kode yang
   dideprecate.

Bandingkan `domain/import-diff.ts` + `tests/unit/reference-data-import-diff.test.ts`.

## Mutation surface — Idempotency-Key + audit di SETIAP endpoint

Setiap endpoint create/update/deprecate/restore/import-dry-run/import-commit/
import-rollback mewajibkan `Idempotency-Key` dan diaudit — aturan **blanket
yang disengaja** (bukan subset bernama) setelah PR-PR sebelumnya di epic ini
menemukan celah dari coverage parsial. `commit`/`rollback` diklasifikasikan
`HIGH_RISK_ACTIONS` di `identity-access/domain/access-control.ts`, bersama
`delete`/`restore` yang sudah ada. Endpoint mutasi BARU di modul ini wajib
mengikuti aturan blanket ini — jangan berargumen "yang ini rendah risiko".

## Capability port

`_shared/ports/reference-data-port.ts` (`ReferenceDataPort`) — me-resolve satu
kode atau snapshot value set untuk sebuah tenant, menggabungkan baseline +
override tenant dengan presedens deterministik (`domain/resolution.ts`).
Diimplementasikan `application/reference-data-port-adapter.ts`. **Belum ada
modul di repo ini yang mengonsumsinya** (extension seam, preseden "provides
sebelum consumer nyata ada" yang sama dengan `BusinessScopeHierarchyPort`
milik `organization_structure`).

## Hubungan dengan `idn_admin_regions`

`idn_admin_regions` **tidak** diduplikasi/dimigrasikan ke modul ini (ADR-0021
§4) — skema hierarkis 4-level-nya tidak memetakan bersih ke model flat
value-set/code di sini. Ia BOLEH, di issue tersendiri kelak, ikut mendaftarkan
diri sebagai module-contributed value set lewat mekanisme di atas — seam
opsional murni, bukan keharusan.

## Endpoint, event, admin UI

- API: `/api/v1/reference-data/value-sets`, `.../{key}[/restore]`,
  `.../{key}/codes[/{code}][/restore]`, `.../{key}/imports[/{importId}]
[/commit|/rollback]`, `/api/v1/reference-data/tenant-codes[/{id}][/restore]`
  — tag `Reference Data` di `openapi/awcms-mini-public-api.openapi.yaml`.
- Event: `awcms-mini.reference-data.value-set.{created,updated,deprecated}`,
  `.code.{created,updated,deprecated}`, `.import.{committed,rolled-back}`,
  `.tenant-code.{created,deprecated}`.
- Admin UI: `/admin/reference-data/value-sets`, `/admin/reference-data/codes`
  (+ panel import tervalidasi, `?valueSet=<key>`),
  `/admin/reference-data/tenant-codes`.

## Pitfall umum

1. Jangan parse body PATCH manual di route — pakai `domain/code-patch.ts`.
2. Jangan hard-delete kode baseline yang sudah direferensikan tenant.
3. Jangan biarkan commit percaya diff dry-run — hitung ulang di transaksi write.
4. Jangan menulis tabel baseline global dari jalur tenant-override.
5. Jangan tambah endpoint mutasi tanpa `Idempotency-Key` + audit.
6. Jangan asumsikan ada superadmin platform — tidak ada.

## Out of scope

Katalog produk/item, chart of accounts, aturan pajak/payroll, atau master data
domain lain; menggantikan `idn_admin_regions`; panggilan provider eksternal
real-time saat resolusi (import adalah payload tervalidasi yang disubmit
operator, bukan fetch eksternal live).

## Verifikasi

`tests/unit/reference-data-{code-patch,contribution-registry,domain,import-diff,resolution}.test.ts`
dan `tests/integration/reference-data.integration.test.ts`. Jalankan `bun test`
dengan `DATABASE_URL` — tanpa itu seluruh test integration dilewati diam-diam.
Plus gate CLI: `bun run reference-data:contributions:check`.
