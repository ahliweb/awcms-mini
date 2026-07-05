# Identity & Access

Implementasi Issue 2.3 (`docs/awcms-mini/06_github_issues_detail.md` §Issue 2.3 — Add Identity Login and Tenant User Membership).

## Scope

- `awcms_mini_identities` — login identity per tenant (`login_identifier` unik per tenant), `password_hash` (Bun native `Bun.password` — argon2id), lockout (`failed_login_count`, `locked_until`).
- `awcms_mini_tenant_users` — keanggotaan identity pada tenant (status active/inactive — dicek terpisah dari status identity).
- `awcms_mini_sessions` — token sesi opaque (bukan JWT stateless): hanya `token_hash` yang disimpan, token mentah cuma dikirim sekali saat login berhasil. `expires_at`/`revoked_at` untuk logout dan kedaluwarsa.
- Endpoint `POST /api/v1/auth/login`, `POST /api/v1/auth/logout`, `GET /api/v1/auth/me`.

Skema ada di `sql/004_awcms_mini_identity_login_schema.sql`.

## Domain logic

`domain/login-policy.ts` — `evaluateLoginAttempt` (pure, murni): mengevaluasi tenant inactive, identity terkunci (status `locked` atau `locked_until` di masa depan), tenant_user tidak aktif, dan password salah (dengan penghitungan `failed_login_count` serta kunci otomatis setelah `AUTH_LOGIN_MAX_ATTEMPTS` percobaan gagal). Endpoint melakukan I/O (baca/tulis DB, verifikasi password) lalu mendelegasikan keputusan ke fungsi ini.

Alasan penolakan login **digeneralisasi menjadi pesan generik** ("invalid credentials") untuk identity tidak ditemukan, identity inactive, tenant_user inactive, dan password salah — mencegah user enumeration. Tenant inactive dan account locked tetap punya kode/pesan berbeda karena bukan risiko enumerasi (klien sudah tahu tenant/identifier-nya).

## Infrastruktur baru

Issue ini adalah endpoint live pertama yang menyentuh database, sehingga menambahkan infrastruktur dasar akses data yang akan dipakai modul lain:

- `src/lib/database/client.ts` — `getDatabaseClient()`, instance `Bun.SQL` bersama dari `DATABASE_URL`.
- `src/lib/database/tenant-context.ts` — `assertUuid` + `withTenant` (transaction wrapper + `SET LOCAL app.current_tenant_id`) sesuai doc 16 §RLS context. Connection pooling/backpressure penuh (work-class, circuit breaker) tetap scope Issue 10.2.
- `src/lib/auth/password.ts` — `hashPassword`/`verifyPassword` via `Bun.password` (argon2id native Bun, tanpa dependency).
- `src/lib/auth/session-token.ts` — `generateSessionToken` (random 32 byte) + `hashSessionToken` (SHA-256, hanya hash yang disimpan).

## Catatan operasional: CSRF `checkOrigin` Astro

Astro secara default menolak (403, tanpa body) permintaan `POST`/`PUT`/`PATCH`/`DELETE` tanpa header `Content-Type` sebagai potential cross-site form submission (`security.checkOrigin`). Klien **wajib** mengirim `Content-Type: application/json` pada `POST /auth/logout` walau body-nya kosong — ditemukan saat verifikasi live (curl/fetch tanpa `Content-Type` mendapat 403 sebelum request mencapai handler).

## Belum tersedia

Assign role/permission (Issue 2.4), evaluator ABAC, dan publikasi event `identity.login.succeeded`/`identity.login.failed` (doc 05, menyusul modul Observability/Logging) belum ada pada tahap ini.
