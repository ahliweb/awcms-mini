---
name: awcms-mini-data-exchange
description: Kerjakan bagian mana pun dari modul data_exchange AWCMS-Mini (Issue #752, epic platform-evolution #738 Wave 3, ADR-0018; hardening #820/#831). Gunakan saat menambah/mengubah endpoint di src/modules/data-exchange, saat modul lain mendaftarkan ExchangeDescriptor + adapter import/export miliknya sendiri lewat capability port, saat mengubah parsing CSV/JSON berbatas, atau saat menyentuh netralisasi formula injection / masking sensitiveFields. Merangkum invariant fail-closed yang sudah diperbaiki (default-deny masking, rawValuePermission, descriptor null) supaya tidak diregresi.
---

# AWCMS-Mini — Data Exchange Module

`data_exchange` (`src/modules/data-exchange`, Issue #752, epic
`platform-evolution` #738 Wave 3, admission decision
`docs/adr/0018-data-exchange-module-admission.md`) adalah **Official
Optional Module** (`type: "domain"`, ADR-0013 §3 "Official Optional
Business Foundation") — framework import/export CSV/JSON staged yang
provider-neutral, tenant-scoped, opt-in per tenant.

Baca `src/modules/data-exchange/README.md` untuk peta lengkap tiap
tabel/endpoint. Skill ini merangkum yang **tidak jelas dari membaca satu
file**: kontrak descriptor, invariant fail-closed pada jalur preview
(tiga cacat berkomposisi yang diperbaiki Issue #820), dan batas parsing.

## Kapan pakai skill ini vs skill generik

Melengkapi (bukan menggantikan) `awcms-mini-new-endpoint`,
`awcms-mini-new-migration`, `awcms-mini-idempotency`,
`awcms-mini-abac-guard`, `awcms-mini-sensitive-data`. Pakai skill ini
untuk konteks domain `data_exchange` spesifik: cara modul lain
menyambungkan adapter import/export-nya, aturan `sensitiveFields`, dan
batas parse yang wajib dipertahankan.

## Tujuan & batas scope — apa yang TIDAK pernah dibangun modul ini

- **Tidak** mengimplementasikan skema bisnis apa pun. Setiap modul PEMILIK
  menyuplai schema/validasi/mapping/commit adapter-nya sendiri lewat
  capability port `DataExchangeAdapterPort`/`DataExchangeExportSourcePort`
  (`src/modules/_shared/ports/data-exchange-adapter-port.ts`) plus
  descriptor pure-data (`ExchangeDescriptor`, field `dataExchange` di
  `_shared/module-contract.ts`).
- **Tidak** pernah menulis ke tabel modul lain secara langsung (ADR-0013
  §6 no-shared-table-write). Semua tulis domain terjadi di dalam
  `commitRow` milik adapter modul pemilik.
- **Tidak** butuh object storage eksternal — staging memakai PostgreSQL,
  export ditulis lewat adapter lokal. Aman di deployment offline/LAN.
- **Tidak** memanggil provider eksternal saat resolve/parse.

Modul ini hanya mengapalkan SATU pasangan descriptor/adapter referensi
self-contained — `reference_items`
(`application/reference-items-exchange-adapter.ts`, tabel
`awcms_mini_data_exchange_reference_items`) — sebagai bukti mekanisme
end-to-end, mengikuti preseden "foundation issue ships zero real business
integrations" (`domain_event_runtime`, #742). **Jangan** perlakukan
`reference_items` sebagai domain bisnis nyata atau contoh skema yang layak
ditiru isinya — yang ditiru adalah BENTUK-nya.

## Pipeline (dan kenapa commit selalu asinkron)

```
POST /imports (multipart)  -> staged     (checksum, size bound, Idempotency-Key)
   worker: bun run data-exchange:worker
runImportValidatePass      -> validating -> previewed
GET  /imports/{id}/preview                (zero mutation, masked)
POST /imports/{id}/commit  -> committing  (TRIGGER saja, Idempotency-Key)
   worker
runImportCommitPass        -> committed | partially_committed
```

Commit **tidak pernah** dikerjakan di dalam request HTTP: route hanya
memindahkan status ke `committing`, worker yang mengeksekusi dalam pass
berbatas dan resumable (`commit_cursor`). Jangan "sederhanakan" ini
menjadi commit sinkron — itu mengembalikan transaksi tak berbatas dan
request panjang yang desain ini hindari.

`data-exchange-worker.ts` membuka `withTenant` **terpisah** untuk setiap
batch validate pass, setiap batch commit pass, dan setiap export job —
exception pada SATU item tidak pernah me-rollback item lain di pass yang
sama (diuji dengan throw sengaja di tengah pass).

Export cermin dari ini: `POST /exports` (queue) -> worker `runExportJob`
(baca paginated lewat `DataExchangeExportSourcePort`) -> `completed` ->
`GET /exports/{id}/download`.

## CRITICAL — jalur preview fail-closed (Issue #820)

Tiga cacat pada jalur `GET /imports/{id}/preview` yang **berkomposisi**
jadi kebocoran identifier mentah (NIK/NPWP/email). Semua sudah
diperbaiki; jangan diregresi:

1. **Masking default-deny, digerakkan descriptor.** `sensitiveFields`
   sekarang **WAJIB** — gate registry (`domain/exchange-registry.ts`)
   menolak descriptor tanpanya. Nyatakan "tidak ada yang sensitif" secara
   afirmatif dengan `{ fieldNames: [] }`, jangan dengan menghilangkan
   field-nya. Sebelum #820, `sensitiveFields` opsional dan absennya
   berarti seluruh staged row dikembalikan MENTAH tanpa cek permission
   sama sekali — lupa mendeklarasikan = membuka, kebalikan doc 17.
2. **`rawValuePermission` benar-benar di-enforce.** Field di
   `sensitiveFields.fieldNames` hanya unmask untuk caller yang memegang
   permission yang **descriptor itu sendiri** sebut di
   `sensitiveFields.rawValuePermission` — permission sempit miliknya
   sendiri (mis. `profile_identity.identifiers.reveal_raw`), **tidak
   pernah** `data_exchange.*` yang generik. Sebelum #820 field ini
   divalidasi di registry tapi punya **nol enforcement site**; route
   memakai konstanta hardcoded `data_exchange.preview_errors.read` yang
   jauh lebih luas. Ini pengulangan pola **"validator ada tapi tak
   tersambung"** (lih. #769/#740, waktu itu Critical) — kalau menambah
   field kontrak baru yang divalidasi di registry, **telusuri mundur dari
   setiap call site nyata**, jangan berhenti di test registry-nya.
3. **Descriptor yang tak ter-resolve fail CLOSED.** `resolveImportDescriptor`
   mengembalikan `null` bila modul pemiliknya di-disable/dihapus lewat
   `module_management` SETELAH batch di-stage.
   `application/descriptor-authorization.ts`'s
   `authorizeExchangeDescriptorPermission` **tidak lagi menerima `null`** —
   preview/commit/retry/download menjawab `409 INVALID_STATE`. Sebuah batch
   tidak boleh jadi LEBIH terbuka setelah modulnya dimatikan (efek absurd
   yang dulu terjadi: descriptor null → guard lolos → `fieldNames` kosong →
   semua mentah).
4. **`naturalKey` ikut di-masking** bila `sensitiveFields.naturalKeyField`
   menunjuk field yang sendiri sensitif. Kunci dedup import profil lazimnya
   justru email/NIK — mask salinan di `fields` tapi echo nilai sama sebagai
   `naturalKey` = tidak mask apa pun.

Verifikasi: `tests/unit/data-exchange-staged-row-masking.test.ts`,
`tests/unit/data-exchange-registry.test.ts`,
`tests/unit/data-exchange-descriptor-permission-ssr.test.ts`,
`tests/integration/data-exchange.integration.test.ts`.

## Mendaftarkan descriptor + adapter dari modul lain

```ts
// <modul-pemilik>/module.ts
dataExchange: [
  {
    key: "profile_identity.parties",
    ownerModuleKey: "profile_identity",
    direction: "both",
    formats: ["csv", "json"],
    schemaVersion: "1.0",
    limits: {
      maxFileBytes: 5 * 1024 * 1024,
      maxRowCount: 5000,
      maxFieldsPerRow: 10
    },
    adapterRegistryKey: "profile_parties",
    requiredPermission: "profile_identity.parties.create",
    sensitiveFields: {
      fieldNames: ["email", "nik"],
      naturalKeyField: "email",
      rawValuePermission: "profile_identity.identifiers.reveal_raw"
    },
    description: "..."
  }
];
```

Lalu daftarkan adapter-nya di
`infrastructure/exchange-adapter-registry.ts` (registry statik source-code
yang direview, bentuk sama dengan
`domain-event-runtime/infrastructure/consumer-registry.ts`) dengan kunci
yang sama persis dengan `adapterRegistryKey`. Parity descriptor↔kontrak
dijaga oleh gate response-vs-schema umum
`tests/unit/response-contract-validation.test.ts` (Issue #844) yang
memvalidasi response nyata `GET /api/v1/data-exchange/descriptors` terhadap
schema OpenAPI yang dipublikasikan.

`requiredPermission` (permission tambahan modul pemilik) dicek di SETIAP
route yang me-resolve descriptor: stage, preview, commit, retry,
export-create, **dan export-download**. Yang terakhir sempat terlewat dan
ditemukan security-auditor di PR #782 — route yang menyajikan KONTEN FILE
mentah lebih sensitif daripada metadata job yang sudah dicover
`exports.read`. Setiap call site sekarang dibuktikan test, bukan diklaim
di prosa.

## Batas parsing — bukan dokumentasi, tapi enforcement

- **Body cap 5 MiB** (`readFormBody("large")`) diberlakukan SEBELUM parsing
  apa pun.
- **CSV** (`domain/csv-codec.ts`) adalah state machine tulisan tangan yang
  ABORT DI TENGAH PARSE begitu `maxRowCount`/`maxFieldsPerRow` terlampaui.
  Jangan ganti dengan regex/split — bandingkan pelajaran tokenizer di
  `awcms-mini-new-migration`'s scanner: alternation regex tidak bisa
  mengekspresikan state.
- **JSON** dibatasi byte cap yang sama sebelum `JSON.parse`, dicek segera
  sesudahnya (tidak bisa abort mid-parse seperti CSV — lihat header
  `domain/json-codec.ts`).
- **Media type** diverifikasi di intake terhadap allow-list per format
  (`domain/media-type-allowlist.ts`), `415` bila tidak diizinkan.
  Catatan penting di header file itu: `File.type` yang di-resolve
  `request.formData()` Bun terbukti **diturunkan dari ekstensi nama file**,
  bukan pass-through header `Content-Type` per part.
- **Preview pagination berbatas di kedua ujung** (Issue #831): `limit`
  dibatasi `PREVIEW_PAGE_SIZE_MAX`, `offset` dibatasi `PREVIEW_OFFSET_MAX`
  (= `MAX_EXCHANGE_ROW_COUNT`, sehingga tidak bisa menyembunyikan baris
  yang masih terjangkau). Satu CSV besar mengisi `staged_rows` sampai
  volume deep-offset dalam sekali jalan.

## Formula injection (CSV injection)

String yang diawali `=`/`+`/`-`/`@`/TAB/CR dinetralkan (prefix `'`) di
**DUA** titik independen: intake (`domain/formula-injection-guard.ts`,
sebelum baris pernah dipersist) DAN serialisasi export
(`export-execute-job.ts`'s `neutralizeRowForExport`, defense in depth,
tidak bergantung riwayat import). Termasuk field array/objek bersarang —
yang dicek adalah bentuk `String()`-nya (mis. `String(["=1+1"])` ===
`"=1+1"`), bukan hanya scalar. Jangan hapus salah satu titik dengan alasan
redundan: export bisa memuat baris yang masuk sebelum guard intake ada.

## Idempotency & audit

`Idempotency-Key` wajib di **setiap** endpoint mutasi: stage-upload,
commit, cancel, retry, pause, resume (imports); create, cancel (exports).
Commit per-baris idempotent: `runImportCommitPass` hanya pernah memilih
staged row `commit_status = 'pending'`, jadi restart worker di tengah
commit tidak bisa menerapkan ulang baris yang sudah `'committed'`; adapter
referensi juga idempotent per `naturalKey` sebagai defense-in-depth.

`data_exchange.export_downloads.read` adalah permission **terpisah dan
lebih sensitif** dari `data_exchange.exports.read`, dan setiap download
menulis `recordAuditEvent`-nya sendiri (berbeda dari entri audit "job
selesai") — SIAPA yang mengunduh artefak mentah harus terlacak.

## Domain event (AsyncAPI)

`awcms-mini.data-exchange.import.{staged,previewed,committed,failed}`,
`.export.completed`, `.reconciliation.mismatch`.

## Pitfall umum

1. Jangan daftarkan descriptor tanpa `sensitiveFields` — gate registry
   menolaknya; nyatakan `{ fieldNames: [] }` bila memang tidak ada.
2. Jangan gate raw value dengan permission `data_exchange.*` generik —
   pakai `descriptor.sensitiveFields.rawValuePermission`.
3. Jangan biarkan descriptor `null` lolos guard — `409 INVALID_STATE`.
4. Jangan menulis tabel modul lain dari modul ini — selalu lewat adapter.
5. Jangan jadikan commit sinkron di request HTTP.
6. Jangan hapus netralisasi formula di salah satu dari dua titiknya.

## Known limitation (scope v1)

Kegagalan commit per-baris yang `retryable` menghentikan pass worker saat
ini **tanpa** menandai baris `'failed'` — baris tetap `'pending'` dan
dicoba lagi pada tick berikutnya. Tidak ada eskalasi otomatis
retryable→failed setelah N attempt; baris yang terjebak loop transient
butuh intervensi operator (pause + investigasi). Lihat header
`application/import-commit-job.ts`.

## Verifikasi

`tests/unit/data-exchange-*.test.ts` (14 file: codec, guard, state,
masking, registry, parity, neutralization) dan
`tests/integration/data-exchange.integration.test.ts`. Jalankan `bun test`
dengan `DATABASE_URL` — `bun run check` tanpa `DATABASE_URL` melewatkan
seluruh test integration secara diam-diam.
