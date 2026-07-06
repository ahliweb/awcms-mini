# Logging & Audit Trail

Implementasi Issue 10.1 (`docs/awcms-mini/06_github_issues_detail.md` §Issue 10.1 — Add Structured Logging and Audit Trail).

## Scope

- `awcms_mini_audit_events` — tabel audit trail generik lintas modul (append-only, tenant-scoped, RLS). Berbeda dari dan **melengkapi** dua tabel audit sempit yang sudah ada sebelumnya:
  - `awcms_mini_profile_audit_logs` (migration 003) — hanya lifecycle profile.
  - `awcms_mini_abac_decision_logs` (migration 005) — hanya keputusan allow/deny ABAC.

  Tabel ini adalah sink umum untuk aksi high-risk apa pun di modul mana pun (soft delete/restore/purge, login, access assignment, price change, transaksi posted/cancel/return, stock adjustment, transfer, ekspor Coretax, resolusi konflik sync, pemanggilan tool AI, keputusan security readiness) — sesuai `docs/awcms-mini/03_srs_detail_per_modul.md` dan skill `awcms-mini-audit-log`.

  Skema ada di `sql/011_awcms_mini_audit_logging_schema.sql`. Index `(tenant_id, created_at DESC)` untuk listing terbaru dan `(tenant_id, resource_type, resource_id)` untuk lookup per-resource.

- `application/audit-log.ts` — `recordAuditEvent(tx, input: AuditEventInput)`. Meredaksi `attributes` (via `src/modules/_shared/redaction.ts`) sebelum INSERT — tidak pernah menyimpan password/token/API key/NPWP/NIK/phone/WhatsApp/email mentah. `AuditEventInput` mengikuti kontrak doc 10 §Audit helper persis.

- Endpoint `GET /api/v1/logs/audit` — bearer-session, guard `logging.audit_trail.read`. Filter opsional `?resourceType=`, `?action=`, `?severity=`; `LIMIT 100 ORDER BY created_at DESC, id DESC` per halaman, dengan keyset pagination opsional `?cursor=` (Issue #435, `src/modules/_shared/keyset-pagination.ts`) — `nextCursor` pada response, `null` bila halaman terakhir; cursor rusak → `400 VALIDATION_ERROR`. Attributes pada response sudah aman karena diredaksi saat penulisan, bukan saat pembacaan.

- `application/audit-purge.ts` — `purgeExpiredAuditEvents(sql, tenantId, options)` (Issue #447). Retensi default **730 hari** (2 tahun), dikonfigurasi via `AUDIT_LOG_RETENTION_DAYS` (doc 18) dan dijalankan oleh `bun run logs:audit:purge` (`scripts/audit-log-purge.ts`) — job internal terjadwal (pola sama seperti `scripts/object-sync-dispatch.ts` Issue #436), **bukan** endpoint publik. Menghapus dalam batch (`DELETE ... LIMIT 5000` per pass, per tenant) sampai tak ada lagi baris kedaluwarsa. Physical delete murni berbasis umur, tidak memutus FK (tabel ini tidak punya FK anak). Aksi purge itu sendiri direkam sebagai audit event baru (`action='purge'`, `resourceType='audit_event'`, reuse `recordAuditEvent` — bukan mekanisme audit baru) — tidak pernah purge diam-diam. Detail kebijakan retensi ada di `docs/awcms-mini/04_erd_data_dictionary.md` §Retention awal.

- **Extension point observability** (Issue #447) — dua hook opsional, default `null` (no-op), tanpa dependency baru, bukan integrasi SIEM nyata (tetap di luar cakupan per doc 20 §Matrix kepatuhan A.8.16):
  - `setLogSink(sink)` di `src/lib/logging/logger.ts` — dipanggil dengan `LogEntry` yang sama persis dengan yang ditulis ke stdout (sudah diredaksi), tepat setelah `console.log`, untuk setiap baris yang lolos gerbang `LOG_LEVEL`. Error dari sink ditelan (`console.error`, tidak pernah dilempar ulang) — sink yang rusak tidak pernah menjatuhkan aplikasi.
  - `setAuditExportHook(hook)` di `application/audit-log.ts` — dipanggil dengan event yang baru saja di-INSERT (sudah diredaksi) tepat setelah `recordAuditEvent` menulis baris. **Penting**: hook berjalan di dalam transaction yang sama dengan INSERT-nya — jangan lakukan I/O eksternal langsung di dalamnya (ADR-0006); bila perlu mengirim ke luar, gunakan pola outbox yang sudah ada (`object-dispatch.ts`) di lapisan aplikasi turunan, bukan panggilan langsung dari hook. Error/rejection dari hook ditelan (dicatat via `log("warning", ...)`, tidak pernah menggagalkan penulisan audit atau transaction pemanggil).
  - Contoh konsumen minimal ada di `tests/logger.test.ts` §"setLogSink extension point" dan `tests/audit-log.test.ts` §"AuditExportHook extension point".

## Bukan bagian modul ini

- **Structured JSON logger** (`src/lib/logging/logger.ts`, fungsi `log()`) sengaja diletakkan di `src/lib/`, bukan modul ini — ia independen dari database (tidak menyentuh tabel apa pun), dipakai lintas seluruh codebase (termasuk modul lain dan middleware), jadi masuk kategori infrastruktur bersama seperti `src/lib/database/` dan `src/lib/auth/`, bukan domain modul `logging`.
- **Correlation ID propagation** (`src/middleware.ts`) juga bukan bagian modul ini — middleware adalah infrastruktur request-level yang berjalan untuk _semua_ request, bukan hanya request ke modul ini.

## Redaksi bersama (`src/modules/_shared/redaction.ts`)

`redactSensitiveAttributes` dipakai oleh **baik** `recordAuditEvent` **maupun** `log()` — satu implementasi, bukan dua. Key yang diredaksi (case-insensitive substring match terhadap nama key, rekursif ke object/array bersarang): `password`, `passwordHash`, `token`, `accessToken`, `refreshToken`, `apiKey`, `secret`, `authorization`, `npwp`, `nik`, `phone`, `whatsapp`, `email` (doc 10 §Logger redaction). Redaksi berbasis **nama key**, bukan pemindaian isi nilai — nilai pada key non-sensitif (mis. `reason`) tetap tampil apa adanya walau kontennya kebetulan menyebut nomor telepon.

## Demonstrasi end-to-end: profile lifecycle

Untuk membuktikan pipeline audit bekerja nyata (bukan hanya diklaim), Issue ini menambahkan **tiga endpoint lifecycle tipis** pada `awcms_mini_profiles` (lihat `src/modules/profile-identity/README.md` §Lifecycle endpoints untuk detail) — bukan profile CRUD penuh, yang tetap backlog.

## Belum tersedia

- `GET /logs/audit` gained keyset pagination in Issue #435 (see above). `GET /sync/conflicts` still returns a single flat `LIMIT 50` page with no cursor — not in that issue's named scope (decision-logs/object-queue/audit log), left as-is per its "don't over-engineer" guidance.
- Tidak ada endpoint HTTP untuk memicu purge — sengaja hanya CLI/job terjadwal (Issue #447), sama seperti dispatcher sync object.
- Extension point observability (`setLogSink`/`setAuditExportHook`) hanya menyediakan **titik pemasangan**, bukan implementasi konsumen nyata (SIEM/alerting) — itu tetap tanggung jawab aplikasi turunan/lapisan deployment (doc 20 §Matrix kepatuhan A.8.16), sesuai batas yang sudah ditetapkan Issue #437.

## Sudah tersedia sejak Issue #447 (sebelumnya "Belum tersedia")

- Correlation ID: `ApiMeta.correlationId` kini konsisten pada **seluruh** respons JSON `/api/*` (bukan hanya `GET /logs/audit`), diisi oleh satu titik di `src/middleware.ts` (`src/lib/logging/correlation-response.ts`) — bukan dengan mengedit setiap handler satu per satu. Header respons `X-Correlation-ID` (Issue 10.1) tidak berubah.
- Retensi/purge `awcms_mini_audit_events`: lihat §Scope di atas.
- Extension point observability: lihat §Scope di atas.
