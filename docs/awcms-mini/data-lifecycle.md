# Data Lifecycle — panduan operasional dan kepatuhan

Issue #745, epic #738 (`platform-evolution`), Wave 1. Modul
`data_lifecycle` (`type: "system"`, ADR-0013 §1) — registry tabel
bervolume tinggi kontribusi-modul dan mesin lifecycle aman (retensi,
partisi, arsip, legal hold, purge). Lihat
`src/modules/data-lifecycle/README.md` untuk detail teknis lengkap
(kontrak descriptor, arsitektur engine, playbook registrasi tabel baru)
— dokumen ini fokus pada panduan operasional dan pemetaan kepatuhan.

## Ringkasan modul

AWCMS-Mini sudah punya beberapa job retensi/purge spesifik-resource
(`logs:audit:purge`, `analytics:purge`, `form-drafts:purge`) yang
masing-masing mengimplementasikan retensi/batching/audit sendiri-sendiri.
`data_lifecycle` menambah **registry kontribusi-modul** (kontrak statis
kode yang dideklarasikan tiap modul pemilik tentang tabel bervolume
tingginya sendiri) plus **mesin lifecycle aman** (dry-run planning,
bounded archive/purge, legal hold) yang beroperasi lewat kontrak itu —
tidak pernah langsung ke skema modul lain (ADR-0013 §6, "no shared-table
write").

## Registry descriptor (ringkasan)

Setiap modul pemilik mendeklarasikan `HighVolumeTableDescriptor` di
`module.ts`-nya sendiri (`dataLifecycle` array,
`src/modules/_shared/module-contract.ts`) — nama tabel, kolom
tenant/cursor, kelas retensi + batas aman, kelayakan partisi, kebijakan
arsip, perilaku deletion, keberlakuan legal hold, index wajib, batas
batch, dan mode eksekusi (`"delegated"` — adopter mekanisme yang sudah
ada; atau `"generic"` — dieksekusi langsung oleh mesin ini). Divalidasi
`bun run data-lifecycle:registry:check` (bagian `bun run check`) dan
`security:readiness`'s `checkDataLifecycleRegistryValid`.

Empat descriptor terdaftar di PR ini:

| Descriptor key                       | Tabel                            | Owner               | Mode        | Kelas retensi         |
| ------------------------------------ | -------------------------------- | ------------------- | ----------- | --------------------- |
| `logging.audit_events`               | `awcms_mini_audit_events`        | `logging`           | `delegated` | `audit_security`      |
| `visitor_analytics.visit_events`     | `awcms_mini_visit_events`        | `visitor_analytics` | `delegated` | `analytics_telemetry` |
| `form_drafts.form_drafts`            | `awcms_mini_form_drafts`         | `form_drafts`       | `delegated` | `operational_queue`   |
| `data_lifecycle.data_lifecycle_runs` | `awcms_mini_data_lifecycle_runs` | `data_lifecycle`    | `generic`   | `operational_queue`   |

## Retensi data (per descriptor)

Prinsip: **tidak ada satu periode retensi legal universal** — setiap
descriptor mendeklarasikan kelas retensi dan batas amannya sendiri,
dipetakan ke kebutuhan bisnis/kepatuhan tabel itu spesifik, bukan angka
generik yang dipaksakan ke semua data.

| Descriptor                           | Default  | Batas aman (min–max) | Rasional                                                                                                                           |
| ------------------------------------ | -------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `logging.audit_events`               | 730 hari | 365–1825 hari        | Doc 04 "Security/audit log: 1–5 tahun sesuai kebutuhan" — titik tengah rentang                                                     |
| `visitor_analytics.visit_events`     | 90 hari  | 7–730 hari           | Selaras `VISITOR_ANALYTICS_EVENT_RETENTION_DAYS` (doc 18/`visitor-analytics.md`) — telemetry, retensi jauh lebih pendek dari audit |
| `form_drafts.form_drafts`            | 30 hari  | 1–365 hari           | Selaras `FORM_DRAFT_RETENTION_DAYS` — scratch state, bukan rekaman bisnis                                                          |
| `data_lifecycle.data_lifecycle_runs` | 180 hari | 30–1825 hari         | Riwayat eksekusi lifecycle ITU SENDIRI adalah bukti kepatuhan (ISO 27001/22301) — retensi menengah, diarsipkan sebelum purge fisik |

`retentionDaysOverride` (dry-run on-demand, `POST
/api/v1/data-lifecycle/dry-run`) selalu di-clamp ke `[retentionMinDays,
retentionMaxDays]` descriptor — operator tidak bisa memaksa retensi di
luar batas aman yang dideklarasikan pemilik tabel, dan **legal hold
tetap menang** di atas override apa pun (lihat §Legal hold).

## Legal hold

`awcms_mini_data_lifecycle_legal_holds` (RLS FORCE, tenant-scoped).
Field: `descriptorKey` (nullable = tenant-wide), `scopeDescription`,
`reason` (wajib, minimum 10 karakter), `authorityReference` (wajib —
nomor surat pengadilan/regulator), `authorityMetadata` (jsonb, non-
secret), `status` (`active`/`released`), `startsAt`/`endsAt`
(informational — `endsAt` TIDAK otomatis melepas hold, lihat di bawah),
`requestedBy`/`approvedBy`, `releasedBy`/`releasedAt`/`releaseReason`.

**Precedence tidak bisa dilewati**: hold aktif (tenant-wide atau
menyasar descriptor spesifik) membuat SEMUA baris eligible pada
descriptor itu dilaporkan `held`, bukan `purgeable` — dicek di
`planLifecycleDryRun` SEBELUM cabang archive/purge apa pun, dan
`retentionDaysOverride` agresif sekalipun tidak bisa membuka jalan
purge. Field `legalHold.applicable` pada descriptor adalah metadata
dokumentasi murni (apakah kelas data ini masuk akal untuk di-hold) —
**bukan** gerbang teknis; hold record nyata selalu berlaku terlepas dari
nilai field itu (mencegah modul pemilik mendeklarasikan tabelnya sendiri
"tidak berlaku hold" untuk menghindar).

**Default-deny release**: `data_lifecycle.legal_hold.create` dan
`data_lifecycle.legal_hold.release` adalah permission TERPISAH — role
yang bisa membuat hold tidak otomatis bisa melepasnya. Release wajib
`releaseReason` (≥10 karakter), permission eksplisit, `Idempotency-Key`,
dan audit `critical`. Hold yang `endsAt`-nya sudah lewat TETAP `active`
sampai ada aksi release eksplisit — mencegah hold "kedaluwarsa diam-diam"
saat data yang dilindungi masih relevan secara hukum.

## Dry-run lifecycle planning

`GET /api/v1/data-lifecycle/registry` (daftar descriptor) →
`POST /api/v1/data-lifecycle/dry-run` (`{ descriptorKey,
retentionDaysOverride? }`) — murni `SELECT count(*)`, tanpa mutasi sama
sekali, tanpa `Idempotency-Key` (tidak ada efek samping untuk
diamankan), tanpa persist row (berbeda dari dry-run job terjadwal di
bawah, yang MEMANG mencatat snapshot run history untuk visibilitas
backlog dari waktu ke waktu). Melaporkan `eligibleCount`/`heldCount`/
`archivedCount`/`purgeableCount`/`blockedCount`.

## Job terjadwal (`bun run data-lifecycle:archive-purge`)

`scripts/data-lifecycle-archive-purge.ts` — dibangun di atas shared
worker runner (PR #713/Issue #697): advisory lock, timeout,
SIGTERM/SIGINT-aware cancellation, JSON telemetry. Iterasi tenant-first;
legal hold di-fetch ulang tiap tenant tiap invocation (hold baru berlaku
mulai pass berikutnya, bukan menunggu invocation berikutnya).

- Descriptor `"generic"` (`data_lifecycle.data_lifecycle_runs`): archive
  batch (bila `archive.archivable`) lalu purge batch, keduanya bounded
  (`batchLimit` per pass, `maxPasses` safety bound sama seperti
  `iterateTenantsInBatches`/`runBoundedBatches` — doc `deployment-
profiles.md` §Shared worker runner). Hanya `deletion.mode ===
"hard_delete"` yang dieksekusi.
- Descriptor `"delegated"` (audit/analytics/form-drafts): snapshot
  dry-run saja, TIDAK PERNAH mutasi — purge asli tetap lewat job masing-
  masing yang sudah ada.
- `--dry-run`: tanpa mutasi untuk kedua mode, snapshot tetap dicatat.

`bun run data-lifecycle:archive-purge --dry-run --json-output=<path>`
aman dijalankan produksi untuk pratinjau sebelum dijadwalkan nyata.

### Ketepatan batas cursor (microsecond vs millisecond)

`timestamptz` PostgreSQL presisi mikrodetik; `Date` JavaScript hanya
milidetik. Setiap perbandingan batas cursor (`archivedThrough` untuk
purge, `resumeAfter` untuk resume archive) di-pad
`CURSOR_BOUNDARY_SAFETY_MARGIN_MS` (1ms) — tanpa ini, baris batas
sendiri gagal memenuhi perbandingan `<=`/`>` terhadap nilai dirinya
sendiri yang sudah terpotong presisi (dibuktikan empiris lewat test
volume besar sebelum fix ini ada — lihat
`src/modules/data-lifecycle/README.md` §Timestamp precision untuk detail
lengkap). Dampak sebelum fix: purge kehilangan tepat satu baris tiap
siklus (baris batas tidak pernah terhapus), dan archive resume
mengarsipkan ulang baris terakhir tanpa henti sampai batas
`DEFAULT_MAX_PASSES`.

## Archive port dan restore procedure (local/offline archive)

Provider-neutral (`domain/archive-port.ts`); default DAN satu-satunya
adapter terimplementasi di PR ini: `local_offline`
(`infrastructure/local-archive-adapter.ts`) — menulis artefak JSONL/CSV
ke `DATA_LIFECYCLE_ARCHIVE_ROOT_PATH` (doc 18), checksum SHA-256,
manifest tercatat di `awcms_mini_data_lifecycle_archive_manifests`
(lokasi, jumlah baris, rentang cursor, checksum, versi skema, referensi
prosedur restore). `external_object_storage` adalah nilai valid untuk
`archive.port` (typing forward-compatible) tapi belum ada adapter nyata.

**Prosedur restore (local/offline archive):**

1. Cari manifest lewat `GET /api/v1/data-lifecycle/runs` (korelasi
   `jobRunId`/`correlationId`) atau langsung query
   `awcms_mini_data_lifecycle_archive_manifests` (akses admin/operator).
2. Verifikasi integritas SEBELUM memakai artefak apa pun:
   `ArchivePort.verify(artifactLocation, checksumHex)` — recompute
   SHA-256 dan bandingkan; harus `true` sebelum lanjut.
3. Baca isi artefak: `ArchivePort.read(artifactLocation)` — mengembalikan
   baris sebagai `Record<string, unknown>[]`. **Nilai balik JSON/CSV-
   native** (string/number/boolean/null/object), BUKAN otomatis
   ter-cast ke tipe kolom Postgres aslinya (mis. kolom `timestamptz`
   kembali sebagai string ISO, bukan objek `Date`) — operator restore
   HARUS meng-cast ulang per kolom sesuai skema tujuan, tidak diasumsikan
   sudah tepat.
4. Restore-KE-tabel-sumber adalah **prosedur manual operator terpisah**
   yang terdokumentasi — port ini sengaja TIDAK menulis balik ke tabel
   sumber secara otomatis (batasan "no shared-table write" yang sama
   berlaku: hanya kode modul PEMILIK tabel yang boleh menulis ke
   tabelnya). Untuk `data_lifecycle.data_lifecycle_runs` (satu-satunya
   descriptor `"generic"` di PR ini), restore berarti operator (dengan
   akses admin DB langsung, di luar API) menjalankan `INSERT` manual dari
   baris yang sudah dibaca ke `awcms_mini_data_lifecycle_runs`, memvalidasi
   `tenant_id`/constraint sebelum insert.
5. Rekonsiliasi: bandingkan `rowCount` manifest dengan jumlah baris hasil
   `read()` — harus sama persis; ketidakcocokan berarti artefak korup
   atau salah lokasi, HENTIKAN restore dan investigasi sebelum lanjut.

Diuji end-to-end (checksum + read + rekonsiliasi jumlah baris) di
`tests/integration/data-lifecycle-archive-purge-job.integration.test.ts`
("archive manifest has a verifiable checksum...").

## Kebijakan partisi dan panduan runbook

`partition.eligible`/`partition.granularity` pada descriptor adalah
**panduan**, bukan otomasi — issue #745 eksplisit: "hanya otomasi operasi
partisi bila keamanan PostgreSQL bisa dibuktikan", dan "migrasi
destruktif seluruh tabel yang sudah ada dalam satu PR" ada di luar
cakupan. Tiga descriptor menandai `eligible: true` sebagai kandidat masa
depan (`logging.audit_events` — bulanan; `visitor_analytics.
visit_events` — harian, volume tertinggi); `form_drafts.form_drafts` dan
`data_lifecycle.data_lifecycle_runs` menandai `eligible: false` (volume
belum menjustifikasi kompleksitas partisi).

**Runbook (bila suatu saat diimplementasikan — checklist evaluasi, bukan
langkah eksekusi yang sudah teruji di PR ini):**

1. Buktikan volume nyata menjustifikasi partisi (metrik row count/growth
   rate, bukan asumsi) — lihat §Metrics di bawah.
2. Migrasi partisi PostgreSQL WAJIB non-destruktif: buat tabel baru
   ter-partisi, salin data via batch (bukan `ALTER TABLE` langsung pada
   tabel besar aktif), swap nama via transaksi pendek, verifikasi jumlah
   baris cocok persis sebelum drop tabel lama.
3. RLS policy dan index harus dibuat ulang PERSIS sama pada setiap child
   partition — tidak cukup pada tabel induk saja (PostgreSQL declarative
   partitioning mewarisi RLS dari induk hanya untuk beberapa operasi;
   uji eksplisit sebelum mengklaim aman).
4. `awcms_mini_worker`/`awcms_mini_app` grant harus diverifikasi ulang
   berlaku pada partition baru (grant pada tabel induk partitioned tidak
   selalu otomatis mewarisi ke semua child yang dibuat belakangan,
   tergantung strategi `ALTER DEFAULT PRIVILEGES`).
5. Uji beban nyata (query plan `EXPLAIN ANALYZE` pada query
   representatif) SEBELUM dan SESUDAH partisi — partisi yang salah
   granularitas bisa memperlambat, bukan mempercepat.
6. Rencana rollback eksplisit sebelum cutover produksi.

## Config dan readiness checks

Satu var baru: `DATA_LIFECYCLE_ARCHIVE_ROOT_PATH` (doc 18, default
`./var/data-lifecycle-archive`). `security:readiness` menambah dua check
(`checkDataLifecycleRegistryValid` — critical, memvalidasi ulang seluruh
registry; `checkDataLifecycleLegalHoldReleaseSeparate` — critical,
memverifikasi `legal_hold.create`/`.release` tetap permission terpisah
dan `release` tetap terklasifikasi high-risk).

## Metrics

Mengikuti pola `src/lib/observability/metrics-port.ts` (Issue #698) —
label berkardinalitas rendah, tidak pernah tenant id/row content:
`job_run_total`/`job_run_duration_ms`/`job_run_item_count` (sudah
generik dari shared worker runner, otomatis berlaku untuk
`data-lifecycle:archive-purge` tanpa instrumentasi tambahan — lihat
`src/lib/jobs/job-runner.ts`'s `emitJobRunMetrics`). Volume/backlog/
held-data per descriptor tersedia lewat `GET /api/v1/data-lifecycle/runs`
(riwayat run, count teragregasi) dan `GET /api/v1/data-lifecycle/registry`
(deskriptor terdaftar) — bukan metrik Prometheus khusus tambahan di PR
ini (agregat run history sudah menjawab "backlog seberapa besar" tanpa
menduplikasi mekanisme metrics-port untuk data yang sama).

## Pemetaan kepatuhan

Prinsip yang berlaku pada SETIAP baris tabel di bawah: **retensi adalah
keputusan per data class yang dideklarasikan pemilik tabel** (lihat
§Retensi data), bukan satu angka legal universal yang diklaim benar
untuk semua yurisdiksi/jenis data. Modul ini menyediakan MEKANISME
(registry, dry-run, legal hold, archive, purge aman) — organisasi
pengguna tetap wajib menetapkan periode retensi aktual sesuai regulasi
dan kebijakan internalnya sendiri.

### UU PDP (Undang-Undang Pelindungan Data Pribadi, UU No. 27/2022)

| Prinsip UU PDP                                                     | Implementasi                                                                                                                                                                                                                         |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pembatasan penyimpanan (data disimpan tidak lebih lama dari perlu) | Setiap descriptor mendeklarasikan `retentionMinDays`/`retentionMaxDays`/`defaultRetentionDays` eksplisit; dry-run mengekspos backlog "eligible" sebelum purge nyata dijalankan                                                       |
| Hak penghapusan/permintaan subjek data                             | Purge bounded + audit ada sebagai MEKANISME; keputusan KAPAN menghapus atas permintaan subjek tetap keputusan operasional operator, bukan otomatis dari modul ini                                                                    |
| Akuntabilitas pemrosesan                                           | Setiap purge (mode `"generic"`) diaudit `critical` dengan `descriptorKey`/`purgedCount`/`cutoffIso`; run history menyimpan bukti eksekusi teragregasi                                                                                |
| Legal hold vs hak hapus                                            | Legal hold OVERRIDE hak penghapusan rutin — kepatuhan terhadap kewajiban hukum lain (mis. bukti litigasi) yang sah secara hukum mengalahkan permintaan hapus rutin, konsisten dengan pengecualian lazim UU PDP untuk kewajiban hukum |

### PP PSTE (Penyelenggaraan Sistem dan Transaksi Elektronik, PP No. 71/2019)

| Aspek                                                             | Implementasi                                                                                                                                                                                    |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kewajiban retensi data elektronik untuk keperluan penegakan hukum | Legal hold mechanism eksplisit memungkinkan operator mem-preserve data melebihi retensi rutin saat diminta otoritas berwenang, dengan `authorityReference` sebagai bukti dasar hukum permintaan |
| Keandalan sistem elektronik                                       | Bounded batch (tidak pernah unbounded DELETE), advisory lock (tidak pernah purge ganda konkuren), checksum arsip (integritas terverifikasi)                                                     |

### ISO/IEC 27001:2022 Annex A (kontrol relevan-kode)

| Kontrol                              | Implementasi                                                                                                                                       |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| A.5.33 Protection of records         | Archive manifest + checksum + restore procedure sebelum purge fisik (untuk descriptor archivable)                                                  |
| A.5.34 Privacy and protection of PII | Dry-run/run history mengagregasi count, tidak pernah row content/PII individual                                                                    |
| A.8.10 Information deletion          | Bounded, audited, permission-gated purge; `deletion.mode` eksplisit per tabel                                                                      |
| A.5.15 Access control                | ABAC default-deny + RLS pada semua endpoint; permission terpisah create/release legal hold                                                         |
| A.8.15 Logging                       | Setiap purge (`"generic"`) dan aksi legal hold diaudit `critical`/`warning` via `recordAuditEvent` yang sudah ada (tidak ada mekanisme audit baru) |

### ISO/IEC 27002:2022 (panduan implementasi kontrol di atas)

Panduan retensi berbasis-kelas (bukan satu angka global) selaras 27002
§5.33 ("retention periods should take into account... legal, statutory,
regulatory and contractual requirements" — plural, per jenis data).
Panduan penghapusan aman (27002 §8.10) tercermin di `deletion.mode`
eksplisit per descriptor (`hard_delete`/`anonymize`/
`status_transition_then_purge`) alih-alih satu strategi seragam.

### ISO/IEC 27005:2023 (manajemen risiko)

| Risiko                                    | Mitigasi                                                                                                                                                               |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Purge tak terbatas mengunci tabel lama    | `batchLimit` wajib per descriptor (divalidasi registry gate, maksimum absolut 50.000), statement bounded, tidak pernah `DELETE` tanpa `LIMIT`                          |
| Legal hold dilewati diam-diam             | Precedence dicek unconditional sebelum cabang purge mana pun; `legalHold.applicable` bukan gerbang teknis (lihat §Legal hold)                                          |
| Purge lintas-tenant tak sengaja           | RLS FORCE + filter `tenant_id` eksplisit di setiap query; job iterasi tenant SATU PER SATU via transaksi tenant-scoped terpisah, tidak pernah satu query lintas-tenant |
| Artefak arsip korup/tidak bisa dipulihkan | Checksum SHA-256 wajib per manifest, `verify()` sebelum pemakaian, diuji end-to-end                                                                                    |
| Kredensial bocor lewat log/arsip          | `artifactLocation` selalu path/URI, tidak pernah kredensial (issue #745 requirement eksplisit); tidak ada mekanisme baru yang menulis raw secret ke log                |

### ISO/IEC 27701:2025 (ekstensi privasi untuk ISO 27001, PIMS)

Dry-run dan run history history mengagregasi (count per descriptor per
tenant), tidak pernah mengekspos identifier/nilai baris individual —
selaras prinsip minimisasi data PIMS. Legal hold `authorityMetadata`
(jsonb) didokumentasikan sebagai non-secret tapi tetap tenant-scoped RLS
— tidak pernah lintas tenant meski berisi metadata otoritas eksternal.

### ISO/IEC 22301 (kontinuitas bisnis)

Archive-sebelum-purge (untuk descriptor archivable) adalah bukti retensi
yang bisa dipulihkan pasca insiden — manifest + checksum + restore
procedure yang terdokumentasi dan teruji (bukan hanya diklaim) adalah
bagian dari kesiapan pemulihan data historis. Lihat juga
`docs/awcms-mini/resilience-dr-verification.md` §Backup lokal untuk
cakupan backup/restore penuh basis data (independen dari mekanisme
arsip modul ini — archive manifest melengkapi, bukan menggantikan,
backup database rutin).

## Batasan yang dicatat, bukan diabaikan

- **Hanya empat descriptor terdaftar** — representative, bukan
  exhaustive. Tabel bervolume tinggi lain (event outbox/delivery, webhook
  inbox, sync queue, provider attempt) BELUM didaftarkan di PR ini;
  mengadopsi registry ini untuk mereka adalah kerja issue lanjutan
  (lihat playbook di `src/modules/data-lifecycle/README.md`).
- **`scope: "global"` descriptor belum dieksekusi end-to-end** — diterima
  registry validator (forward-compatible), dilewati (bukan salah
  eksekusi) oleh dry-run planner dan archive/purge engine.
- **Tidak ada admin UI screen khusus** — API tersedia penuh; layar
  `/admin/data-lifecycle` adalah follow-up yang masuk akal, bukan
  persyaratan acceptance criteria issue ini.
- **Adapter object-storage eksternal belum ada** — `local_offline` saja.
- **Cursor tie edge case** — lihat §Ketepatan batas cursor di atas; batas
  1ms yang tersisa setelah fix, tidak dieliminasi sepenuhnya secara
  teoretis (meski tidak dipicu oleh pola tulis nyata descriptor manapun
  hari ini).
