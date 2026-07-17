---
name: awcms-mini-audit-log
description: Tulis audit log untuk aksi high-risk AWCMS-Mini dengan redaction. Gunakan pada login, access assignment, profile merge, price change, transaction posted/cancel/return, stock adjustment, warehouse transfer, Coretax export, sync conflict resolution, AI tool call, dan security readiness decision. Sesuai doc 03 & 10.
---

# AWCMS-Mini — Audit Log (High-Risk)

Ikuti `docs/awcms-mini/03_srs_detail_per_modul.md` dan `docs/awcms-mini/10_template_kode_coding_standard.md`.

## Bentuk input

```ts
type AuditEventInput = {
  tenantId: string;
  actorTenantUserId?: string;
  moduleKey: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  severity?: "info" | "warning" | "critical";
  message: string;
  attributes?: Record<string, unknown>; // WAJIB sudah diredaksi
  correlationId?: string;
};
```

## Aksi yang WAJIB diaudit

Login failed/success · access assignment · profile merge · product price change · soft delete/restore/purge · transaction posted/cancel/return · stock adjustment · warehouse transfer · Coretax export · sync conflict resolution · AI tool call · security readiness decision · workflow task decision/reassign/retire/revoke (`src/pages/api/v1/workflows/tasks/[id]/decisions.ts:197`) · document void/reclassify (`document-infrastructure/application/document-directory.ts:354,672`) · data-exchange export/import commit — bukan cuma Coretax, semua export/import job (`export-execute-job.ts:197`, `import-commit-job.ts:220`) · legal hold create/release (`data-lifecycle/application/legal-hold-service.ts:130,200`).

## Aturan

1. Audit **tenant-scoped** (`tenant_id`), tulis ke `awcms_mini_audit_events`.
2. **Redaksi dulu** attributes — jangan pernah masukkan: password, token, API key, `authorization`, NPWP/NIK penuh, phone/WhatsApp/email penuh, receipt token.
3. Audit **melengkapi**, bukan menggantikan, domain event & structured log.
4. Sertakan `correlationId` untuk trace.
5. Untuk denial high-risk, koordinasikan dengan decision log (`awcms-mini-abac-guard`).
6. Soft delete/restore/purge wajib menyertakan reason dan tidak boleh membawa PII mentah di attributes.

## Redaction keys

`password`, `passwordHash`, `token`, `accessToken`, `refreshToken`, `apiKey`, `secret`, `credential`, `authorization`, `npwp`, `nik`, `phone`, `whatsapp`, `email`, `cookie` (Issue #687), plus allowlist exact-match untuk key IP address (`ip`, `ipAddress`, `clientIp`, `remoteAddr`, `x-forwarded-for`, dst — sengaja BUKAN substring seperti key lain di atas, lihat `src/modules/_shared/redaction.ts` untuk kenapa: substring `"ip"` akan ikut meredaksi `description`/`shipping`/`recipient`).

## Jangan tulis IP mentah — pakai `ipHash` (Issue #821)

Attribut audit untuk aksi auth sering perlu menjawab "sumbernya siapa?"
(forensik brute-force). **IP mentah tidak bisa dipakai**: `ip`/`ipAddress`/
`clientIp`/`remoteAddr`/`x-forwarded-for` semuanya key sensitif (lihat
allowlist exact-match di atas), jadi nilainya pasti jadi `"[REDACTED]"` —
kolom permanen kosong. Mengganti nama key supaya lolos redaksi = regresi
keamanan, **bukan** perbaikan.

Pakai `hashClientIp()` + `summarizeUserAgent()` dari
`src/lib/security/client-fingerprint.ts`: HMAC-SHA256 (key = `AUTH_JWT_SECRET`,
env wajib yang sudah ada — jangan tambah secret baru) di bawah key `ipHash`,
yang tidak match aturan redaksi mana pun. Nilainya stabil (baris audit bisa
dikelompokkan per sumber) tapi alamatnya tidak bisa dipulihkan. HMAC, bukan
digest polos: ruang IPv4 cuma 2^32, `sha256(ip)` tanpa key bisa dibalik dalam
hitungan detik. `User-Agent` dipotong 256 char sebelum masuk `jsonb` — header
attacker-controlled tidak boleh jadi write amplifier di endpoint publik.

## Audit gagal harus selamat dari rollback (Issue #821)

`withTenant` = `sql.begin`, jadi audit yang ditulis di dalamnya **ikut
rollback** kalau transaksinya throw. Untuk jalur deny normal ini bukan masalah
dan **tidak** perlu transaksi terpisah: setiap deny path `return` (bukan
`throw`), jadi transaksinya selalu COMMIT — merutekan deny normal ke transaksi
kedua justru melipatgandakan biaya koneksi tiap percobaan brute-force di
endpoint publik. Yang perlu ditangani hanya kasus exception: `.catch()` di luar
`withTenant`, tulis ulang audit di transaksi baru (best-effort, kegagalan
sendiri di-swallow + `log()`), lalu **rethrow error aslinya apa adanya**. Pola
lengkap: `recordLoginFailureOutOfBand` di `src/pages/api/v1/auth/login.ts`.

## Audit auth tidak boleh jadi alat enumerasi akun

Jangan pernah menyimpan `loginIdentifier` yang dikirim penyerang — biasanya
email (PII, dan **tidak** tertangkap redaksi di bawah nama key itu). Alasan
deny sudah dikolapskan di layer domain (`login-policy.ts`: akun tidak ada,
password salah, identity/tenant-user inactive → semuanya
`"invalid_credentials"`), jadi pakai alasan itu apa adanya — jangan dipecah
lagi di route. `resourceId` boleh diisi saat identity ketemu: audit
tenant-scoped + RLS, hanya terbaca operator yang toh sudah bisa membaca
`awcms_mini_identities`, dan tanpa itu jejaknya kehilangan satu-satunya field
yang menjawab "akun mana yang diserang".

## Verifikasi

- Aksi high-risk menghasilkan satu audit event.
- Soft delete, restore, dan purge menghasilkan audit event terpisah.
- Tidak ada secret/PII mentah di kolom attributes.
- Retention audit: 1–5 tahun sesuai kebutuhan — mekanisme purge nyata (`purgeExpiredAuditEvents`, default 730 hari, `bun run logs:audit:purge`) sudah tersedia sejak Issue #447, JANGAN buat mekanisme purge baru untuk `awcms_mini_audit_events`, lihat `awcms-mini-observability`.

## console.error/console.warn dengan raw exception — DILARANG (Issue #687)

`redactSensitiveAttributes` di atas hanya bekerja pada KEY objek — pesan
exception (`.message`/`.stack`, termasuk rantai `.cause`) adalah teks bebas
tanpa key, dan bisa saja mengandung secret (connection string, token) yang
lolos dari redaksi berbasis key. **Jangan** pernah menulis
`console.error(label, error)` mentah atau
`error instanceof Error ? error.message : String(error)` lalu mencetaknya
langsung di `src/pages/admin/**`, `src/pages/api/v1/**`, atau `scripts/*.ts`
— pakai `logAdminPageError`/`logScriptFailure`
(`src/lib/logging/error-log.ts`, dibangun di atas `sanitizeErrorForLog`/
`safeErrorDetail` di `src/lib/logging/error-sanitizer.ts`, yang keduanya
memanggil `redactSecretsInText` baru). Gate `bun run logging:lint:check`
(`scripts/logging-lint-check.ts`, bagian dari `bun run check`) menolak pola
lama ini secara otomatis — lihat doc 20 §Standar tambahan Issue #687 untuk
detail lengkap dan panduan troubleshooting operator-safe.

## Correlation ID & extension point

Sejak Issue #447: `correlationId` pada `AuditEventInput` cukup diisi dari `context.locals.correlationId` (jangan generate UUID baru sendiri); dan setiap `recordAuditEvent` sukses otomatis memanggil extension point `AuditExportHook` bila terpasang (default no-op) — lihat `awcms-mini-observability` untuk aturan lengkap sebelum memasang/mengimplementasikan consumer di titik itu.
