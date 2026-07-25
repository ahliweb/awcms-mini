---
name: awcms-mini-observability
description: Kelola sistem log/audit/metrics AWCMS-Mini yang sudah aktif — correlation ID lintas hop, retensi/purge audit log, extension point untuk consumer eksternal (alerting/export/SIEM), dan metrics port (counter/histogram/gauge berkardinalitas rendah untuk request/pool/job/provider). Gunakan saat menambah endpoint baru (correlation ID otomatis), menjadwalkan purge audit log, memasang consumer log/audit di aplikasi turunan, atau menambah/mengonsumsi metrik operasional. Berbeda dari awcms-mini-audit-log (APA yang wajib diaudit) — skill ini tentang BAGAIMANA sistem log/audit/metrics itu sendiri dikelola, sesuai Issue #447 dan Issue #698.
---

# AWCMS-Mini — Observability (Correlation ID, Retensi, Extension Point, Metrics)

Sumber kebenaran: `src/lib/logging/logger.ts`, `src/lib/logging/correlation-response.ts`, `src/modules/logging/application/{audit-log,audit-purge}.ts`, `src/lib/observability/metrics-port.ts`, `docs/awcms-mini/observability-metrics.md`, `docs/awcms-mini/20_threat_model_security_architecture.md` §Matrix kepatuhan A.8.15/A.8.16 + §Standar tambahan Issue #698. Implementasi referensi: Issue 10.1 (fondasi log/audit) + Issue #447 (aktivasi) + Issue #698 (metrics/SLO/job health/provider telemetry).

## Correlation ID — sudah otomatis, jangan wiring manual

`X-Correlation-ID` di-set middleware untuk **setiap** response header sejak Issue 10.1. Sejak Issue #447, `meta.correlationId` di **body** JSON juga otomatis terisi untuk **setiap** endpoint `/api/*` yang merespons lewat `ok()`/`fail()` (`src/modules/_shared/api-response.ts`) — satu choke point di `src/middleware.ts` (`applyCorrelationIdToApiBody`) mengisi `meta.correlationId` bila handler belum mengisinya sendiri.

- **Endpoint baru**: tidak perlu wiring apa pun — cukup pakai `ok()`/`fail()` seperti biasa (`awcms-mini-new-endpoint`), `meta.correlationId` otomatis terisi.
- **Butuh correlation ID eksplisit** (mis. diteruskan ke `recordAuditEvent`/panggilan lintas modul dalam satu request) → baca `context.locals.correlationId`, **jangan** generate UUID baru sendiri di handler.
- Kalau handler sudah set `meta.correlationId` sendiri (pola lama `GET /logs/audit`), middleware **tidak** menimpanya — hanya mengisi yang kosong.

## Retensi/purge `awcms_mini_audit_events`

Tabel append-only ini **punya** mekanisme purge sejak Issue #447 — jangan bikin ulang:

- `purgeExpiredAuditEvents(sql, tenantId, options)` (`src/modules/logging/application/audit-purge.ts`) — default retensi **730 hari** (`AUDIT_EVENT_DEFAULT_RETENTION_DAYS`, override via env `AUDIT_LOG_RETENTION_DAYS`), batch `DELETE ... LIMIT 5000` per panggilan (`AUDIT_EVENT_PURGE_BATCH_LIMIT`) — tidak pernah satu statement tak terbatas yang mengunci tabel lama.
- CLI terjadwal `bun run logs:audit:purge` (`scripts/audit-log-purge.ts`) — pola sama seperti dispatcher Issue #436 (`object-sync-dispatch.ts`): iterasi tenant `active`, loop per tenant sampai satu pass tidak menghapus apa pun, laporan hasil di akhir. **Bukan** endpoint HTTP — hanya dipanggil cron/systemd timer/k8s CronJob, konsisten pola "worker internal terpercaya" dispatcher. Sejak Issue #697 (epic #679), script ini dibangun di atas shared worker runner `src/lib/jobs/job-runner.ts` (advisory lock per nama job, `--dry-run`, JSON telemetry) — lihat `docs/awcms-mini/deployment-profiles.md` §Shared worker runner; perilaku purge/retensi/audit-nya sendiri TIDAK berubah.
- Aksi purge **wajib** terekam sebagai audit event baru (`action: "purge"`, severity `warning`) di transaksi yang sama — jangan pernah purge diam-diam (doc 04 "Purge... harus diaudit").
- Tenant dengan legal hold aktif: **jangan** jadwalkan job untuk tenant itu (atau panggil dengan `retentionDays` besar) — pola opt-out yang sama seperti resource lain di doc 04.
- Menambah tabel append-only baru yang butuh retensi? Reuse pola ini (batch bounded + self-audit), jangan bikin mekanisme purge terpisah per tabel.

## Extension point — titik pemasangan, BUKAN implementasi SIEM

Base ini generik dan **sengaja tidak** membangun SIEM/alerting/export nyata (doc 20 §Matrix kepatuhan A.8.16 — di luar cakupan base generik ini, tanggung jawab aplikasi turunan/deployment). Yang disediakan adalah titik pemasangan:

- `setLogSink(sink: LogSink | null)` / `getLogSink()` (`src/lib/logging/logger.ts`) — dipanggil setiap `log()` menulis satu baris JSON, **setelah** redaksi. Default `null` (no-op, zero behavior change).
- `setAuditExportHook(hook: AuditExportHook | null)` / `getAuditExportHook()` (`src/modules/logging/application/audit-log.ts`) — dipanggil setiap `recordAuditEvent` sukses INSERT, dengan row yang sudah diredaksi.

**Aturan wajib saat memasang atau mengimplementasikan consumer di sini**:

1. **Jangan lakukan I/O eksternal blocking langsung di dalam hook** — `AuditExportHook` dipanggil **di dalam transaksi DB yang sama** dengan INSERT (ADR-0006: provider tidak boleh dipanggil di dalam transaction). Kalau consumer butuh mengirim ke luar (HTTP call ke SIEM, dsb.), **enqueue** lewat pola outbox/dispatcher yang sudah ada (`awcms-mini-integration`, `object-dispatch.ts`), jangan panggil langsung dari hook.
2. **Hook tidak boleh pernah menjatuhkan aplikasi** — implementasi `notifyAuditExportHook`/`setLogSink` sudah menangkap throw sinkron dan promise rejection secara terpisah; kalau menulis consumer baru yang MEMANGGIL hook (bukan sekadar mendaftarkannya), pola tangkap-error yang sama wajib direplikasi.
3. Default tetap `null` — jangan pasang sink/hook nyata di base generik ini; hanya sediakan/pakai extension point-nya. Implementasi consumer nyata adalah scope aplikasi turunan (mis. AWPOS).

## Verifikasi

- Endpoint baru mana pun (bukan hanya `GET /logs/audit`) mengembalikan `meta.correlationId` yang sama dengan header `X-Correlation-ID` — tanpa wiring manual.
- `bun run logs:audit:purge` terhadap Postgres nyata: baris lebih tua dari cutoff terhapus, baris baru bertahan, dan satu audit event baru (`action=purge`) muncul di `GET /logs/audit`.
- Sink/hook yang sengaja dibuat melempar error tidak pernah menjatuhkan request/transaksi pemanggil.
- `LOG_LEVEL` (env) tetap dihormati — `debug` hanya muncul saat `LOG_LEVEL=debug`.

## Caught exception -> log/console — pakai helper, jangan console.error mentah (Issue #687)

`log()` di atas sudah meredaksi `context` object berbasis key (`redactSensitiveAttributes`), tapi TIDAK otomatis membersihkan `.message`/`.stack` sebuah `Error` yang dioper begitu saja sebagai salah satu attribute `context` — teks bebas itu bisa mengandung secret yang lolos dari redaksi berbasis key. Untuk SSR admin page dan CLI worker, jangan panggil `console.error(label, error)` mentah atau meng-ekstrak `error.message` dengan tangan — pakai `logAdminPageError`/`logScriptFailure` (`src/lib/logging/error-log.ts`), yang menjalankan `sanitizeErrorForLog`/`safeErrorDetail` (`src/lib/logging/error-sanitizer.ts`) lebih dulu. `bun run logging:lint:check` (bagian dari `bun run check`) menolak regresi pola lama di `src/pages/admin`, `src/pages/api/v1`, dan `scripts/` — lihat doc 20 §Standar tambahan Issue #687.

## Metrics port — beda konsep dari logging, jangan bikin mekanisme baru (Issue #698)

`src/lib/observability/metrics-port.ts` menambah agregat numerik berkardinalitas rendah (counter/histogram/gauge) — **komplemen**, bukan pengganti, `log()`/audit trail di atas: log/audit adalah event per-kejadian dengan detail tinggi; metrics adalah agregat "berapa banyak/berapa cepat/seberapa jenuh" untuk di-scrape ke time-series backend. Detail lengkap (arsitektur, tabel kardinalitas/privasi per metrik, SLI/SLO awal + burn-rate, dashboard/runbook, contoh adapter Prometheus/OpenTelemetry): `docs/awcms-mini/observability-metrics.md`.

- **Default SELALU no-op** (`createNoopMetricsPort`) — jangan pernah memasang adapter nyata di base generik ini, sama seperti `setLogSink`/`setAuditExportHook` di atas. Implementasi consumer nyata adalah scope aplikasi turunan.
- **Menambah metrik baru**: WAJIB tambah entry di `METRIC_DEFINITIONS` (nama, tipe, `allowedLabelKeys`, `approxCardinality`, `privacyNote`) SEBELUM memanggilnya — `MetricName` adalah union literal dari key registry itu, jadi memanggil nama yang belum terdaftar adalah error kompilasi, bukan konvensi yang bisa dilanggar diam-diam.
- **Guardrail kardinalitas/privasi label — beda dari redaksi nilai di atas**: redaksi (`redactSensitiveAttributes`/`redactSecretsInText`) untuk teks bebas di LOG; di metrics masalahnya CARDINALITY EXPLOSION (satu series per tenant/id selamanya) plus privasi label itu sendiri. Setiap label HARUS dari enum/nilai kode-tetap (nama modul, nama job, kode status HTTP, nama work-class, family provider) — **tidak pernah** tenant ID, path dengan ID request nyata, email/IP, object key, token, atau isi bebas. `recordCounter`/`recordHistogram`/`recordGauge` sudah membuang (bukan menolak dengan error) key label yang tidak dideklarasikan di `allowedLabelKeys` metrik itu — pertahanan berlapis, tapi jangan andalkan itu sebagai alasan untuk asal lempar label di call site.
- **Provider dengan registry key ter-scope tenant** (mis. `getProviderCircuitBreaker` untuk SSO, Issue #610: `sso-oidc-discovery:<tenantId>:<providerKey>`) — JANGAN PERNAH pakai key mentah itu sebagai label. Pakai `deriveProviderFamilyLabel` (`src/lib/database/circuit-breaker.ts`) yang memotong ke prefix literal sebelum `:` pertama. Setiap call site provider baru yang mengikuti konvensi "prefix-kategori-literal, opsional suffix `:`-dinamis" otomatis aman lewat fungsi ini — tidak perlu menambah daftar provider secara manual.
- **Hook ke mekanisme yang SUDAH ADA, jangan duplikasi logic**: job run status/backlog di-hook lewat `src/lib/jobs/job-runner.ts`'s `buildResult` (satu choke point setiap outcome `runJob`); provider outcome/latency/circuit state di-hook lewat `decorateWithMetrics` di `src/lib/database/circuit-breaker.ts` (wrapper di antara `getDatabaseCircuitBreaker`/`getProviderCircuitBreaker` dan `createCircuitBreaker` murni — `createCircuitBreaker` sendiri TETAP pure/tanpa timer, tidak diubah); saturasi pool DB di-hook lewat `emitWorkClassGauges` di `src/lib/database/work-class.ts` (dipanggil di setiap titik `active`/`queue.length` berubah). Modul/endpoint domain baru yang butuh metrik serupa harus mencari choke point yang sudah ada seperti ini, bukan menambah instrumentasi bespoke di banyak call site.
- **Metrics BUKAN sumber otorisasi** — jangan pernah membaca nilai metrik untuk membuat keputusan ABAC/RLS/autentikasi di kode apa pun.
- **Endpoint authorized** `GET /api/v1/logs/observability/dependency-health` (permission `logging.observability.read`) membedakan "local dependency" (database) dari "optional external provider" — pola untuk endpoint serupa di aplikasi turunan yang butuh membedakan dependency lokal vs provider opsional dalam satu respons.

## SLO / alert registry (#930)

Modul mendeklarasikan `serviceLevelObjectives` di `module.ts`-nya sendiri;
`logging/domain/slo-registry.ts` mengagregasi + memvalidasi. Gate
`bun run slo:registry:check` (bagian `bun run check`).

- **`metricName` WAJIB terdaftar di `METRIC_DEFINITIONS`.** Objective yang
  diukur terhadap metrik yang tidak pernah di-emit = **diam permanen**:
  terlihat sebagai coverage, tidak pernah memanggil siapa pun.
- **`dimension` WAJIB salah satu `allowedLabelKeys` metrik itu.** Ini yang
  membuat "dimensi berkardinalitas rendah" benar SECARA KONSTRUKSI —
  objective tak bisa memperkenalkan label, jadi tak bisa menyelundupkan
  tenant/resource id ke alert. Jangan longgarkan aturan ini.
- **Metrik control-plane wajib unlabeled atau berlabel enum kode-tetap.**
  Prefix `control_plane_*`. Operator menemukan tenant lewat API baca yang
  ter-reauthorize, TIDAK PERNAH lewat label metrik.
- **`runbookPath` diverifikasi ADA di disk** oleh lapisan script gate
  (`existsSync`), bukan hanya dicek bentuknya. Tautan runbook mati jam 3
  pagi lebih buruk daripada tidak ada tautan.
- **Ambang severity divalidasi urutannya**: `critical` harus lebih jauh dari
  objective daripada `warning`, dan setiap threshold harus searah dengan
  `objectiveComparison` — threshold yang berlawanan arah justru
  mendeskripsikan keadaan SEHAT dan akan menyala permanen. `below` di atas
  metrik `counter` ditolak (counter tak pernah turun → alert latch selamanya).
- **Permukaan operator menahan konfigurasi**: `GET /api/v1/logs/observability/slo`
  dibangun `domain/slo-safe-view.ts` dari allow-list field EKSPLISIT. Jangan
  pernah menyebar descriptor ke respons — angka ambang/dwell/nama metrik
  adalah data kalibrasi untuk bertahan tepat di bawah alarm.

## Fleet sweep control-plane (#930)

`bun run control-plane:fleet-sweep`. Cross-tenant read model ADR-0022 §6b:
enumerasi tenant dari direktori GLOBAL → baca tiap tenant DI DALAM konteks
RLS-nya → agregasi di memori. JANGAN pernah menggantinya dengan satu query
lintas tenant, `BYPASSRLS`, atau platform-claim di predikat policy.

- **Kolektor tinggal di modul PEMILIK** (`<modul>/application/control-plane-signals.ts`),
  membaca hanya tabelnya sendiri. Hanya `scripts/` (composition root) yang
  boleh meng-import beberapa kolektor. File agregasi menerima DATA, tidak
  meng-import modul apa pun → tetap unit-testable tanpa DB.
- **Emit gauge WALAU NOL.** Gauge yang berhenti dilaporkan = tak terbedakan
  dari kolektor mati; "no data" tampil sebagai celah, bukan alarm.
- **Sweep dibatalkan di tengah → JANGAN publikasikan.** Total dari sebagian
  tenant terbaca sebagai penurunan fleet-wide (bentuk pemulihan) dan akan
  memadamkan alert yang masih seharusnya menyala.
- **Umur = MAX fleet, bukan SUM.** Menjumlahkan umur menghasilkan angka yang
  tumbuh mengikuti jumlah tenant dan tidak bermakna.
- **Status `failed` dihitung di backlog tapi TIDAK menua.** Ia tidak menunggu
  apa pun; memasukkannya membuat umur naik selamanya setelah satu kegagalan
  dan mengunci alert.
- **Job jalan sebagai `awcms_mini_worker`** (grant SELECT migration `103`).
  **`DATABASE_URL` developer biasanya superuser, dan superuser melewati grant
  DAN RLS** — sweep bisa tampak sempurna lokal padahal grant kurang (gagal di
  tenant pertama saat deploy) sekaligus membaca semua tenant sekaligus.
  Integration test kolektor WAJIB jalan sebagai role worker sungguhan.
- **Join invoice→dunning pakai LATERAL ambil attempt TERAKHIR.** Join biasa
  menggandakan satu invoice sebanyak retry-nya → metrik naik justru saat
  dunning bekerja lebih keras.

## Skill terkait

`awcms-mini-audit-log` (APA yang wajib diaudit + redaksi), `awcms-mini-integration` (pola dispatcher/outbox untuk I/O eksternal, ADR-0006), `awcms-mini-security-hardening` (batas scope A.8.16 SIEM/monitoring terpusat), `awcms-mini-performance` (pool/backpressure tuning yang metrik `db_pool_work_class_*` sekarang membuatnya observable).
