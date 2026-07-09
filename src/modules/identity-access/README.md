# Identity & Access

Implementasi Issue 2.3 (`docs/awcms-mini/06_github_issues_detail.md` §Issue 2.3 — Add Identity Login and Tenant User Membership) dan Issue 2.4 (§Issue 2.4 — Add RBAC and ABAC Access Control).

## Scope — Issue 2.3 (Identity & Login)

- `awcms_mini_identities` — login identity per tenant (`login_identifier` unik per tenant), `password_hash` (Bun native `Bun.password` — argon2id), lockout (`failed_login_count`, `locked_until`).
- `awcms_mini_tenant_users` — keanggotaan identity pada tenant (status active/inactive — dicek terpisah dari status identity).
- `awcms_mini_sessions` — token sesi opaque (bukan JWT stateless): hanya `token_hash` yang disimpan, token mentah cuma dikirim sekali saat login berhasil. `expires_at`/`revoked_at` untuk logout dan kedaluwarsa.
- Endpoint `POST /api/v1/auth/login`, `POST /api/v1/auth/logout`, `GET /api/v1/auth/me`.

Skema ada di `sql/004_awcms_mini_identity_login_schema.sql`.

## Scope — Issue 2.4 (RBAC/ABAC)

- `awcms_mini_permissions` — katalog global `module_key.activity_code.action` (bukan tenant-scoped, tanpa RLS — daftar kemampuan yang bisa diberikan, sama untuk semua tenant). Diseed 17 permission untuk modul base yang sudah ada (`tenant_admin`, `identity_access`, `profile_identity`) — **bukan** matriks 26+ permission domain retail/POS doc 17 (katalog, POS, gudang, pajak, CRM, AI dikeluarkan; itu scope aplikasi turunan).
- `awcms_mini_roles` — role per tenant (dibuat runtime, tidak diseed lewat migration — role Owner/Admin/dsb. adalah tanggung jawab Setup Wizard Issue 12.1, generik, bukan 10 role retail doc 17).
- `awcms_mini_role_permissions` — matriks role → permission per tenant.
- `awcms_mini_access_assignments` — assignment role ke tenant user.
- `awcms_mini_abac_policies` — tabel policy ABAC per tenant (schema tersedia; belum ada policy row yang diseed — evaluator base memakai aturan generik bawaan, lihat di bawah).
- `awcms_mini_abac_decision_logs` — append-only, setiap panggilan `/access/evaluate` dan setiap guard endpoint (`assignments`, `decision-logs`) mencatat keputusan.
- Endpoint `GET /api/v1/access/modules`, `POST /api/v1/access/evaluate`, `POST /api/v1/access/assignments`, `GET /api/v1/access/decision-logs`.

Skema ada di `sql/005_awcms_mini_abac_access_control_schema.sql`.

## Domain logic

`domain/login-policy.ts` — `evaluateLoginAttempt` (pure, murni): mengevaluasi tenant inactive, identity terkunci (status `locked` atau `locked_until` di masa depan), tenant_user tidak aktif, dan password salah (dengan penghitungan `failed_login_count` serta kunci otomatis setelah `AUTH_LOGIN_MAX_ATTEMPTS` percobaan gagal). Endpoint melakukan I/O (baca/tulis DB, verifikasi password) lalu mendelegasikan keputusan ke fungsi ini.

Alasan penolakan login **digeneralisasi menjadi pesan generik** ("invalid credentials") untuk identity tidak ditemukan, identity inactive, tenant_user inactive, dan password salah — mencegah user enumeration. Tenant inactive dan account locked tetap punya kode/pesan berbeda karena bukan risiko enumerasi (klien sudah tahu tenant/identifier-nya).

`domain/access-control.ts` — `evaluateAccess` (pure, murni), tipe `TenantContext`/`AccessRequest`/`AccessDecision` mengikuti kontrak doc 10 §ABAC guard persis. **Default deny, deny overrides allow** (ADR-0004): cek ABAC dulu (tenant isolation — resource beda tenant selalu ditolak; self-approval — actor tidak boleh approve resource yang ia ajukan sendiri) sebelum cek RBAC (permission dari role yang di-assign). Dua aturan ABAC bawaan ini **generik** (berlaku untuk aplikasi turunan apa pun), bukan aturan spesifik domain retail seperti "cashier tax restriction"/"discount limit" di doc 17 — itu tetap scope aplikasi turunan lewat `awcms_mini_abac_policies`.

### Vocabulary `AccessAction` diperluas (Issue 10.1)

Doc 10 §ABAC guard: "Tambahkan action `restore` dan `purge` pada kontrak modul yang membutuhkan pemulihan atau purge retention". Union `AccessAction` kini mencakup `restore` dan `purge` di samping `read`/`create`/`update`/`delete`/`post`/`cancel`/`approve`/`export`/`send`/`configure`/`analyze`/`assign`, dan keduanya ditambahkan ke `HIGH_RISK_ACTIONS` (`isHighRiskAction("restore")`/`isHighRiskAction("purge")` → `true`) — soft-delete-adjacent actions bersifat high-risk per definisi, sejalan dengan acceptance criteria Issue 10.1 ("Soft delete, restore, dan purge high-risk tercatat di audit"). `evaluateAccess` sendiri tidak berubah logikanya — perluasan ini murni tipe/set, default deny tetap berlaku sampai permission eksplisit (`*.delete`/`*.restore`/`*.purge`) di-assign ke role. Konsumen pertama: `profile_identity.profile_management.restore`/`.purge` (lihat `src/modules/profile-identity/README.md` §Lifecycle endpoints).

Pola yang sama diulang untuk `retry` (PR: Sync admin ops dashboard) — migrasi 009 sudah menyeed permission `sync_storage.object_queue.retry` sejak Issue 6.3, tapi tidak ada konsumen sampai action itu ditambahkan ke union `AccessAction`. Berbeda dari `restore`/`purge`, `retry` **tidak** ditambahkan ke `HIGH_RISK_ACTIONS` — ia hanya nudge terhadap jadwal backoff otomatis (`isHighRiskAction("retry") === false`), bukan aksi destruktif/irreversibel. Endpoint yang memakainya tetap memanggil `recordAuditEvent` secara eksplisit terlepas dari klasifikasi risiko (`isHighRiskAction` bersifat metadata dokumentatif, bukan gerbang yang menentukan apakah suatu endpoint boleh skip audit — lihat `src/pages/api/v1/sync/object-queue/[id]/retry.ts`).

Pola yang sama sekali lagi untuk `sync` (Issue #514, epic #510) — migrasi 025 sudah menyeed `module_management.modules.sync` sejak Issue #512, konsumen pertamanya baru `POST /api/v1/modules/sync` di issue ini. `sync` juga **tidak** ditambahkan ke `HIGH_RISK_ACTIONS` — descriptor sync bersifat idempoten/non-destruktif (upsert + tandai orphan, tidak pernah delete), bukan kelas risiko yang sama dengan `delete`/`approve`/`export`. Tetap diaudit eksplisit (`action: "modules_synced"`) terlepas dari klasifikasi itu.

Dan sekali lagi untuk `enable`/`disable` (Issue #515, epic #510) — migrasi 025 sudah menyeed `module_management.tenant_modules.{enable,disable}`, konsumen pertamanya `POST /api/v1/tenant/modules/{moduleKey}/{enable,disable}` di issue ini. Keduanya **tidak** ditambahkan ke `HIGH_RISK_ACTIONS` — toggle ketersediaan modul per-tenant bersifat reversibel dan tidak menghapus data tenant (`disable` hanya menulis baris `awcms_mini_tenant_modules`, tidak pernah menyentuh data modul lain), berbeda dari `delete`/`purge` yang ireversibel. Tetap diaudit eksplisit (`action: "tenant_module_enabled"`/`"tenant_module_disabled"`) terlepas dari klasifikasi itu.

Dan sekali lagi untuk `check` (Issue #520, epic #510) — migrasi 025 sudah menyeed `module_management.health.check`, konsumen pertamanya `POST /api/v1/modules/{moduleKey}/health/check` di issue ini. **Tidak** ditambahkan ke `HIGH_RISK_ACTIONS` — memicu health check yang bounded/read-mostly (satu-satunya sisi efek adalah panggilan jaringan eksplisit ke provider email yang sudah timeout-bounded, Issue #495) bukan aksi destruktif. Tetap diaudit eksplisit (`action: "health_checked"`) terlepas dari klasifikasi itu.

Dan sekali lagi untuk `publish`/`schedule`/`archive` (Issue #538, epic #536) — migrasi 027 sudah menyeed `blog_content.posts.{publish,schedule,archive}`, konsumen pertamanya `POST /api/v1/blog/posts/{id}/{publish,schedule,archive}` di issue ini. **Tidak** ditambahkan ke `HIGH_RISK_ACTIONS` — mengubah status/visibilitas sebuah post masih reversibel lewat transisi status lain (lihat `blog-content/domain/post-status.ts`'s `isValidStatusTransition`), berbeda dari `delete`/`restore`/`purge` yang sudah ada di set itu. Ketiganya tetap mewajibkan `Idempotency-Key` dan menulis audit event eksplisit (`blog.post.published`/`.scheduled`/`.archived`) terlepas dari klasifikasi risiko itu — lihat `blog-content/README.md` §Admin API — Blog Posts untuk ABAC ownership override yang dipakai endpoint `update`-nya (bukan perluasan `evaluateAccess` generik ini, murni logic tambahan di modul `blog_content` sendiri).

Dan sekali lagi untuk `verify`/`set_primary` (Issue #562, epic #555) — migrasi 032 sudah menyeed `tenant_domain.domains.{verify,set_primary}` sejak Issue #557, konsumen pertamanya `POST /api/v1/tenant/domains/{id}/{verify,set-primary}` di issue ini. Keduanya **tidak** ditambahkan ke `HIGH_RISK_ACTIONS` — `verify` hanya membalik `status` berdasarkan field yang sudah ada di baris itu sendiri (tidak ada panggilan DNS/HTTP keluar, manual-first per §Security notes issue #562), dan `set_primary` hanya memindahkan flag `is_primary` (selalu bisa dipindah lagi, tidak destruktif seperti `delete`/`purge`) — sama alasan seperti `retry`. Keduanya tetap **mewajibkan** `Idempotency-Key` (`awcms-mini-idempotency`) dan menulis audit event eksplisit (`tenant_domain.domain.verified`/`.set_primary`) terlepas dari klasifikasi risiko itu — lihat `tenant-domain/README.md` §Tenant domain management API untuk detail lengkap (termasuk kenapa `set_primary` tetap atomic dalam satu transaction `withTenant` walau tidak diklasifikasikan high-risk).

### Enforcement modul disabled di `authorizeInTransaction` (Issue #515)

Epic #510's security notes menegaskan "disabled module endpoints must still enforce server-side access/status checks" — status disabled bukan cuma sinyal UI. `authorizeInTransaction` (`access-guard.ts`) karena itu mengecek `resolveModuleEnabled(tx, tenantId, guard.moduleKey)` (`auth-context.ts`) **sebelum** evaluasi ABAC/RBAC: kalau modul nonaktif untuk tenant tsb, request ditolak `403 MODULE_DISABLED` — apa pun permission yang dimiliki actor — dan tetap dicatat ke decision log (`matchedPolicy: "module_disabled"`). Karena guard ini dipakai oleh setiap endpoint terproteksi (bukan cuma endpoint lifecycle-nya sendiri), satu perubahan ini otomatis menutup semua endpoint milik modul yang dinonaktifkan tanpa perlu menyentuh tiap route satu-satu — lihat pengujian di `tests/integration/module-tenant-lifecycle.integration.test.ts` ("disabling a module actually blocks its own endpoints"). `module_management` sendiri `isCore` (tidak bisa dinonaktifkan), jadi tidak ada risiko endpoint lifecycle-nya sendiri terkunci oleh cek ini.

## Infrastruktur baru

Issue ini adalah endpoint live pertama yang menyentuh database, sehingga menambahkan infrastruktur dasar akses data yang akan dipakai modul lain:

- `src/lib/database/client.ts` — `getDatabaseClient()`, instance `Bun.SQL` bersama dari `DATABASE_URL`.
- `src/lib/database/tenant-context.ts` — `assertUuid` + `withTenant` (transaction wrapper + `SET LOCAL app.current_tenant_id`) sesuai doc 16 §RLS context. Connection pooling/backpressure penuh (work-class, circuit breaker) tetap scope Issue 10.2.
- `src/lib/auth/password.ts` — `hashPassword`/`verifyPassword` via `Bun.password` (argon2id native Bun, tanpa dependency).
- `src/lib/auth/session-token.ts` — `generateSessionToken` (random 32 byte) + `hashSessionToken` (SHA-256, hanya hash yang disimpan).

## SSR session cookies (Issue 8.1 — Admin Layout Shell)

`POST /auth/login` dan `POST /auth/logout` mendapat perilaku **additive** untuk mendukung SSR admin shell (`src/layouts/AdminLayout.astro`):

- `login.ts` sekarang juga men-set dua cookie httpOnly + `SameSite=Lax` + `Path=/`: `awcms_mini_session` (raw session token) dan `awcms_mini_tenant_id`, dengan `maxAge` sama dengan `AUTH_SESSION_TTL_MIN` (menit → detik). Body JSON response (`{ token, expiresAt }`) **tidak berubah** — klien bearer-token lama tetap kompatibel.
- `logout.ts` menerima tenant/token dari header (`X-AWCMS-Mini-Tenant-ID` + `Authorization: Bearer`, perilaku lama tidak berubah) **atau**, bila header tidak ada, dari kedua cookie tersebut — fallback ini dibutuhkan karena skrip klien tidak bisa membaca cookie httpOnly untuk menyusun header `Authorization` secara manual. Setelah revoke sukses, kedua cookie dihapus (`cookies.delete`).
- Helper baru `src/lib/auth/ssr-session.ts` (`resolveSsrContext`) membaca kedua cookie dan mendelegasikan ke `resolveTenantContext` + `fetchGrantedPermissionKeys` di atas — pola I/O yang persis sama dengan `POST /access/evaluate`, hanya sumber tenant/token-nya cookie, bukan header. Mengembalikan `null` (tanpa melempar error) bila cookie tidak ada atau sesi tidak valid; layout SSR meng-redirect ke `/login`.
- `secure` cookie diambil dari `AUTH_COOKIE_SECURE` (env yang sudah ada di `.env.example` sejak Issue 0.1, baru dipakai kode mulai issue ini).

### Tenant switcher stub

`src/components/TenantSwitcher.astro` menampilkan nama tenant aktif dalam kontrol berbentuk dropdown yang **disabled** (satu entri saja). Ini bukan bug — skema `awcms_mini_identities.tenant_id` adalah 1:1 per tenant (tidak ada cross-tenant identity linking), sehingga "switch tenant" sungguhan tidak punya target untuk saat ini. Backlog: bila cross-tenant identity linking pernah ditambahkan, komponen ini yang perlu diperbarui menjadi interaktif.

### Sync indicator stub

`src/components/SyncIndicator.astro` hanya presentational (prop `active: boolean` statis dari pemanggil, tanpa fetch data). `GET /sync/status` (Issue 6.1) memakai autentikasi HMAC node-to-node, bukan bearer/cookie sesi manusia, jadi tidak bisa langsung dipanggil dari browser admin. Mewiring indikator ini ke data sync yang sebenarnya adalah scope Issue 9.1 (Management Reporting) — pola catatan backlog yang sama seperti dispatcher R2 di Issue 6.3.

## Access & Users management (admin screen)

Full CRUD di atas fondasi Issue 2.3/2.4 — dulu hanya assignment yang punya endpoint live; sekarang tenant user dan role generik (bukan hanya via Setup Wizard) bisa dikelola lewat API maupun UI admin `/admin/access-users`.

- `GET/POST /api/v1/users`, `PATCH /api/v1/users/{id}` — daftar/buat tenant user (identity + profile + assignment role awal opsional) dan ubah nama/status aktif-nonaktif. Menonaktifkan (`status: "inactive"`) langsung memblokir login berikutnya (`evaluateLoginAttempt` mensyaratkan `tenantUserStatus === "active"`).
- `GET/POST /api/v1/roles`, `PATCH/DELETE /api/v1/roles/{id}` — daftar/buat/ubah/soft-delete role beserta permission set-nya. **Safety rail**: role sistem (`is_system=true`, mis. role `owner` yang di-seed Setup Wizard) menolak perubahan `permissionIds` maupun delete dengan `409` — mencegah admin tidak sengaja mengunci semua orang keluar. Delete juga ditolak `409` bila role masih di-assign ke tenant user manapun (unassign dulu).
- `GET /api/v1/permissions` — katalog permission global read-only (dipakai UI untuk render checkbox per role).
- `POST/DELETE /api/v1/access/assignments` — `POST` (sudah ada sejak Issue 2.4) tidak berubah; `DELETE` (baru) melepas assignment role dari tenant user.
- Guard tiap endpoint memetakan persis ke permission granular yang sudah diseed: `user_management.{read,create,update}` dan `access_control.{read,configure,assign}` — tidak ada permission baru yang perlu di-seed.
- Query read-side (`fetchTenantUsersWithRoles`, `fetchRolesWithPermissions`, `fetchPermissionCatalog` di `application/user-directory.ts`) dipakai bersama oleh endpoint JSON **dan** SSR halaman admin — pola yang sama seperti `modules/reporting/application/*-report.ts` dipakai bersama endpoint reporting dan `admin/index.astro`, supaya SSR tidak round-trip ke API-nya sendiri.
- Endpoint cookie-atau-header (`resolveAuthInputs` di `application/access-guard.ts`): menerima `Authorization: Bearer` + header tenant (klien API) **atau** cookie httpOnly SSR (UI admin, yang tidak bisa membaca token httpOnly-nya sendiri untuk menyusun header) — pola yang sama seperti `POST /auth/logout` sejak Issue 8.1, dipusatkan di sini supaya konsisten di lima endpoint baru sekaligus.
- `src/pages/admin/access-users.astro` — layar admin penuh (tabel user + tabel role, form tambah, form edit permission per role, chip assign/unassign, toggle aktif/nonaktif). Tidak ada framework client-side di proyek ini (Astro + vanilla JS saja, sama seperti tombol logout `AdminLayout.astro`) — satu `<script>` di bawah halaman menangani semua fetch mutasi lalu `location.reload()` sederhana untuk refresh state (bukan patch DOM granular — cukup untuk skala base repo ini).

## Password reset (Issue #496, epic #492)

Flow forgot/reset password lewat email — konsumen nyata pertama modul
`email` (Issue #493-#495/#498): `POST /api/v1/auth/password/forgot`
meng-enqueue baris `awcms_mini_email_messages` (kategori
`auth.password_reset`, sudah punya allowlist variabel dan default
template EN/ID sejak Issue #498), bukan memanggil Mailketing langsung
(ADR-0006 — provider dipanggil dispatcher terpisah, `bun run
email:dispatch`).

- **Skema** — `awcms_mini_password_reset_tokens` (`sql/022`), mirip
  `awcms_mini_sessions` tapi dengan `used_at` untuk single-use (sesi tidak
  butuh ini — sesi valid sampai kedaluwarsa/revoke eksplisit, token reset
  harus tidak bisa dipakai dua kali walau belum kedaluwarsa). Token
  mentah **tidak pernah** disimpan — hanya `token_hash`
  (`lib/auth/password-reset-token.ts`, pola identik
  `session-token.ts`: 32 byte acak, sha256).
- **Enumeration-safe** — `POST .../forgot` selalu mengembalikan respons
  200 generik yang identik terlepas apakah `loginIdentifier` cocok
  identity aktif (`evaluateLoginAttempt`'s "generalisasi pesan generik"
  precedent di atas, diterapkan ke respons sukses alih-alih 401).
  `POST .../reset` juga tidak pernah membedakan pesan untuk token yang
  tidak ditemukan/kedaluwarsa/sudah dipakai — `domain/
password-reset-policy.ts`'s `evaluatePasswordResetToken` (pure,
  murni, pola sama `login-policy.ts`) mengevaluasi ketiganya, tapi
  endpoint memetakan semuanya ke satu pesan generik yang sama. Audit
  log (bukan respons) **tetap** mencatat alasan spesifik — audit log
  adalah permukaan akses terbatas, bukan user-facing, jadi mencatat
  detail di sana tidak melemahkan proteksi enumerasi publik.
- **Supersede token lama** — setiap request baru menandai semua token
  outstanding identity itu sebagai `used_at = now()` sebelum membuat
  yang baru; hanya link reset terbaru yang pernah valid.
- **Invalidasi sesi setelah reset** — `application/session-revocation.ts`'s
  `revokeAllSessionsForIdentity` (fungsi baru; sebelumnya hanya ada logout
  satu-sesi) dipanggil setelah `password_hash` diperbarui, sehingga sesi
  yang sudah dicuri tidak bisa bertahan melewati pergantian kredensial.
- **Rate limit** — `AUTH_PASSWORD_RESET_RATE_LIMIT_MAX`/`_WINDOW_SEC`
  (default 5/900 detik, lebih ketat dari login's 20/60 karena endpoint ini
  memicu DB write + email enqueue dan endpoint reset membuka permukaan
  tebak-token), reuse `checkRateLimit` (`lib/security/rate-limit.ts`,
  Issue #437) dengan key `${clientIp}:${tenantId}:password-forgot`/
  `:password-reset` — namespace terpisah dari login supaya tidak berbagi
  budget dengan endpoint lain.
- **Audit** — `password_reset_requested` (selalu, `attributes.identityFound`
  menyimpan hasil sungguhan tanpa memengaruhi respons publik),
  `password_reset_failed` (alasan spesifik di `attributes.reason`),
  `password_reset_completed`.
- **UI halaman reset-password** sengaja **tidak** dibuat pada issue ini
  (ditandai eksplisit "optional... if consistent" di issue) — hanya API
  layer; `resetUrl` yang dikirim mengarah ke `${APP_URL}/reset-password`,
  path yang belum punya halaman Astro sungguhan.

## Catatan operasional: CSRF `checkOrigin` Astro

Astro secara default menolak (403, tanpa body) permintaan `POST`/`PUT`/`PATCH`/`DELETE` tanpa header `Content-Type` sebagai potential cross-site form submission (`security.checkOrigin`). Klien **wajib** mengirim `Content-Type: application/json` pada `POST /auth/logout` walau body-nya kosong — ditemukan saat verifikasi live (curl/fetch tanpa `Content-Type` mendapat 403 sebelum request mencapai handler).

## Belum tersedia

CRUD ABAC policy row (`awcms_mini_abac_policies` — schema tersedia, evaluator masih pakai aturan generik bawaan, belum ada endpoint kelola policy), dan publikasi event `identity.login.succeeded`/`identity.login.failed` (doc 05, menyusul modul Observability/Logging) belum ada pada tahap ini. `/access/decision-logs` tetap `LIMIT 50` per halaman tapi kini punya keyset pagination opsional (Issue #435, `?cursor=`/`nextCursor` — lihat `src/modules/_shared/keyset-pagination.ts`).

Google OIDC login, generic tenant OIDC SSO, dan admin policy UI (Issue
#590-#592) masih backlog untuk epic full-online auth security hardening
(#587-#593). #587 (gate bersama, lihat §Full-online-only auth security
feature gate di bawah), #588 (Cloudflare Turnstile,
`src/lib/security/turnstile.ts` — bukan bagian modul ini, tapi dipanggil
dari `POST /auth/login` di modul ini via `enforceTurnstileIfRequired`),
dan #589 (MFA/TOTP, lihat §MFA/TOTP login challenge di bawah) sudah
selesai. Lihat skill `awcms-mini-auth-online-hardening` untuk detail
lintas-issue.

## MFA/TOTP login challenge (Issue #589)

`src/modules/identity-access/application/mfa.ts` +
`src/modules/identity-access/domain/mfa-policy.ts` (challenge, bukan
factor/token, yang punya logic domain murni di sini — enroll/disable/
regenerate cukup query+mutate langsung tanpa evaluasi kondisional
berlapis) + `src/lib/auth/totp.ts`/`mfa-secret-crypto.ts`/
`mfa-recovery-code.ts`/`mfa-challenge-token.ts`/`mfa-config.ts` (RFC
6238 TOTP, enkripsi secret AES-256-GCM, recovery code, challenge token,
gate env — semuanya modul-agnostic, tinggal di `src/lib/auth/` seperti
`session-token.ts`/`password.ts`).

- Gate gabungan `isMfaRequired(env)` = `isFullOnlineSecurityActive(env)`
  (#587) ∧ `AUTH_MFA_ENABLED=true` — mengikuti pola persis
  `isTurnstileRequired()` (#588). MFA **opt-in per identity**: identity
  yang belum pernah enroll tetap login normal bahkan saat gate ini aktif
  tenant-wide.
- Login (`login.ts`): password-valid TAPI identity punya factor TOTP
  `active` → TIDAK membuat session, malah menerbitkan
  `awcms_mini_mfa_challenges` row dan balas `401 MFA_REQUIRED` berisi
  `mfaChallengeToken`. `POST /auth/mfa/totp/verify` (satu-satunya
  endpoint MFA yang TIDAK butuh session — diautentikasi lewat possession
  token challenge, sama seperti `password/reset`) menyelesaikan login:
  kode/recovery code valid → session dibuat persis seperti
  `login.ts`, cookie sama.
- Enroll: `POST /auth/mfa/totp/enroll/start` (butuh session; generate
  secret baru, simpan `pending`, plaintext secret HANYA di respons ini)
  → `POST /auth/mfa/totp/enroll/verify` (kode valid → `active` +
  10 recovery code sekali tampil). Re-enroll saat sudah `active` ditolak
  `409 MFA_ALREADY_ACTIVE` — harus `disable` dulu.
- `POST /auth/mfa/totp/disable`/`POST /auth/mfa/recovery-codes/regenerate`:
  high-risk, diaudit (`mfa_disabled`/`mfa_recovery_codes_regenerated`).
  Reset password (`completePasswordReset`) **tidak** menyentuh MFA sama
  sekali — diverifikasi test integrasi eksplisit (bukan MFA bypass).
- TOTP secret dienkripsi AES-256-GCM (`AUTH_MFA_SECRET_ENCRYPTION_KEY`)
  — satu-satunya secret di aplikasi ini yang reversibel (dienkripsi,
  bukan di-hash) karena harus dihitung ulang saat verifikasi; recovery
  code & challenge token tetap hash-only (sha256) seperti
  session/reset token. Replay kode TOTP dicegah via kolom
  `last_used_step` per factor (kode/step yang sama tidak bisa dipakai
  dua kali walau masih dalam window toleransi clock drift).
- Detail lengkap + rasional lintas-issue: skill
  `awcms-mini-auth-online-hardening` §MFA/TOTP.

## Full-online-only auth security feature gate (Issue #587)

`src/lib/auth/online-security-config.ts` — gate bersama yang WAJIB dicek
setiap fitur hardening online-only di epic ini (#588-#592) sebelum
melakukan apa pun yang online/provider-terkait. Dua env var, keduanya
opsional/backward-compatible (`AUTH_ONLINE_SECURITY_ENABLED=false` dan
`AUTH_ONLINE_SECURITY_PROFILE=disabled` — default setiap deployment
offline/LAN, tidak mengubah perilaku login apa pun):

- `isOnlineSecurityEnabled(env)` — `true` hanya kalau
  `AUTH_ONLINE_SECURITY_ENABLED === "true"` persis.
- `resolveOnlineSecurityProfile(env)` — `"full_online"` kalau di-set
  persis begitu, selalu jatuh ke `"disabled"` untuk nilai lain/tidak
  di-set (tidak pernah throw).
- `isFullOnlineSecurityActive(env)` — **satu-satunya fungsi yang wajib
  dipanggil** fitur #588-#592: `true` hanya kalau KEDUA di atas setuju.
  Jangan re-derive aturan "keduanya harus setuju" di modul lain.

Divalidasi `scripts/validate-env.ts`'s `checkOnlineAuthSecurityConfig`
(`AUTH_ONLINE_SECURITY_ENABLED=true` mewajibkan
`AUTH_ONLINE_SECURITY_PROFILE=full_online`, nilai lain gagal
`config:validate`) dan dilaporkan `scripts/security-readiness.ts`'s
`checkOnlineAuthSecurityReady` (severity `critical`, tapi `status: pass`
untuk kondisi disabled — bukan kegagalan, murni informational, sesuai
acceptance criteria issue ini). Detail env var lengkap:
`docs/awcms-mini/18_configuration_env_reference.md` §Full-online auth
security hardening, `docs/awcms-mini/deployment-profiles.md` §Full-online
auth security hardening.
