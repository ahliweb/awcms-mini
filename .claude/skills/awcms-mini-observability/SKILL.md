---
name: awcms-mini-observability
description: Kelola sistem log/audit AWCMS-Mini yang sudah aktif — correlation ID lintas hop, retensi/purge audit log, dan extension point untuk consumer eksternal (alerting/export/SIEM). Gunakan saat menambah endpoint baru (correlation ID otomatis), menjadwalkan purge audit log, atau memasang consumer log/audit di aplikasi turunan. Berbeda dari awcms-mini-audit-log (APA yang wajib diaudit) — skill ini tentang BAGAIMANA sistem log/audit itu sendiri dikelola, sesuai Issue #447.
---

# AWCMS-Mini — Observability (Correlation ID, Retensi, Extension Point)

Sumber kebenaran: `src/lib/logging/logger.ts`, `src/lib/logging/correlation-response.ts`, `src/modules/logging/application/{audit-log,audit-purge}.ts`, `docs/awcms-mini/20_threat_model_security_architecture.md` §Matrix kepatuhan A.8.15/A.8.16. Implementasi referensi: Issue 10.1 (fondasi) + Issue #447 (aktivasi).

## Correlation ID — sudah otomatis, jangan wiring manual

`X-Correlation-ID` di-set middleware untuk **setiap** response header sejak Issue 10.1. Sejak Issue #447, `meta.correlationId` di **body** JSON juga otomatis terisi untuk **setiap** endpoint `/api/*` yang merespons lewat `ok()`/`fail()` (`src/modules/_shared/api-response.ts`) — satu choke point di `src/middleware.ts` (`applyCorrelationIdToApiBody`) mengisi `meta.correlationId` bila handler belum mengisinya sendiri.

- **Endpoint baru**: tidak perlu wiring apa pun — cukup pakai `ok()`/`fail()` seperti biasa (`awcms-mini-new-endpoint`), `meta.correlationId` otomatis terisi.
- **Butuh correlation ID eksplisit** (mis. diteruskan ke `recordAuditEvent`/panggilan lintas modul dalam satu request) → baca `context.locals.correlationId`, **jangan** generate UUID baru sendiri di handler.
- Kalau handler sudah set `meta.correlationId` sendiri (pola lama `GET /logs/audit`), middleware **tidak** menimpanya — hanya mengisi yang kosong.

## Retensi/purge `awcms_mini_audit_events`

Tabel append-only ini **punya** mekanisme purge sejak Issue #447 — jangan bikin ulang:

- `purgeExpiredAuditEvents(sql, tenantId, options)` (`src/modules/logging/application/audit-purge.ts`) — default retensi **730 hari** (`AUDIT_EVENT_DEFAULT_RETENTION_DAYS`, override via env `AUDIT_LOG_RETENTION_DAYS`), batch `DELETE ... LIMIT 5000` per panggilan (`AUDIT_EVENT_PURGE_BATCH_LIMIT`) — tidak pernah satu statement tak terbatas yang mengunci tabel lama.
- CLI terjadwal `bun run logs:audit:purge` (`scripts/audit-log-purge.ts`) — pola sama seperti dispatcher Issue #436 (`object-sync-dispatch.ts`): iterasi tenant `active`, loop per tenant sampai satu pass tidak menghapus apa pun, laporan hasil di akhir. **Bukan** endpoint HTTP — hanya dipanggil cron/systemd timer/k8s CronJob, konsisten pola "worker internal terpercaya" dispatcher.
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

## Skill terkait

`awcms-mini-audit-log` (APA yang wajib diaudit + redaksi), `awcms-mini-integration` (pola dispatcher/outbox untuk I/O eksternal, ADR-0006), `awcms-mini-security-hardening` (batas scope A.8.16 SIEM/monitoring terpusat).
