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

## Bukan bagian modul ini

- **Structured JSON logger** (`src/lib/logging/logger.ts`, fungsi `log()`) sengaja diletakkan di `src/lib/`, bukan modul ini — ia independen dari database (tidak menyentuh tabel apa pun), dipakai lintas seluruh codebase (termasuk modul lain dan middleware), jadi masuk kategori infrastruktur bersama seperti `src/lib/database/` dan `src/lib/auth/`, bukan domain modul `logging`.
- **Correlation ID propagation** (`src/middleware.ts`) juga bukan bagian modul ini — middleware adalah infrastruktur request-level yang berjalan untuk _semua_ request, bukan hanya request ke modul ini.

## Redaksi bersama (`src/modules/_shared/redaction.ts`)

`redactSensitiveAttributes` dipakai oleh **baik** `recordAuditEvent` **maupun** `log()` — satu implementasi, bukan dua. Key yang diredaksi (case-insensitive substring match terhadap nama key, rekursif ke object/array bersarang): `password`, `passwordHash`, `token`, `accessToken`, `refreshToken`, `apiKey`, `secret`, `authorization`, `npwp`, `nik`, `phone`, `whatsapp`, `email` (doc 10 §Logger redaction). Redaksi berbasis **nama key**, bukan pemindaian isi nilai — nilai pada key non-sensitif (mis. `reason`) tetap tampil apa adanya walau kontennya kebetulan menyebut nomor telepon.

## Demonstrasi end-to-end: profile lifecycle

Untuk membuktikan pipeline audit bekerja nyata (bukan hanya diklaim), Issue ini menambahkan **tiga endpoint lifecycle tipis** pada `awcms_mini_profiles` (lihat `src/modules/profile-identity/README.md` §Lifecycle endpoints untuk detail) — bukan profile CRUD penuh, yang tetap backlog.

## Belum tersedia

- Correlation ID hanya diwiring end-to-end ke `ApiMeta.correlationId` pada `GET /logs/audit` sebagai demonstrasi representatif — endpoint lain (login, access, reports, sync) tidak diubah pada issue ini untuk menghindari scope creep besar yang tidak terkait; header respons `X-Correlation-ID` sendiri tetap diset untuk _semua_ request oleh middleware. Backlog: wiring `ApiMeta.correlationId` ke seluruh endpoint adalah kandidat issue terpisah bila diperlukan.
- Dispatcher/worker yang mengonsumsi `awcms_mini_audit_events` untuk alerting/export retensi belum ada — endpoint ini murni read API.
- `GET /logs/audit` gained keyset pagination in Issue #435 (see above). `GET /sync/conflicts` still returns a single flat `LIMIT 50` page with no cursor — not in that issue's named scope (decision-logs/object-queue/audit log), left as-is per its "don't over-engineer" guidance.
