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

Dan sekali lagi untuk `preview` (Issue #641, epic `news_portal`) — migrasi 052 sudah menyeed `blog_content.internal_links.preview`, konsumen pertamanya `GET /api/v1/blog/posts/{id}/internal-links/preview` di issue ini — permission sengaja dipisah dari `internal_links.read`/`posts.read` karena seorang editor bisa saja diizinkan preview auto-link tanpa juga mendapat akses konfigurasi internal-link yang lebih luas. **Tidak** ditambahkan ke `HIGH_RISK_ACTIONS` — read-only murni, tidak mengubah state apa pun. Lihat `blog-content/README.md` §Permission seed untuk detail.

Dan sekali lagi untuk `connect`/`disconnect` (Issue #643, epic `social_publishing` #643-#647) — migrasi 053 sudah menyeed `social_publishing.accounts.{connect,disconnect}`, konsumen pertamanya `POST /api/v1/social-publishing/accounts` (connect) dan `POST /api/v1/social-publishing/accounts/{id}/disconnect` di issue ini. Berbeda dari kebanyakan entri di atas, keduanya **ditambahkan** ke `HIGH_RISK_ACTIONS` — connect/disconnect mengubah state yang membawa credential (`token_reference`, pointer ke secret storage eksternal, bukan token mentah), diklasifikasikan sama seperti `configure` alih-alih non-destruktif seperti `verify`. Tetap mewajibkan `Idempotency-Key` dan menulis audit event eksplisit (`awcms-mini.social-publishing.account.connected`/`.disconnected`) terlepas dari klasifikasi itu. Lihat `social-publishing/README.md` untuk detail lengkap.

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

### Tenant badge (sebelumnya "tenant switcher stub")

`src/components/TenantBadge.astro` (Issue #693, epic #679 platform-hardening — menggantikan `TenantSwitcher.astro`) menampilkan nama tenant aktif sebagai badge **non-interaktif** (`<div role="status">`), bukan lagi kontrol dropdown ber-atribut `disabled`. Perubahan ini bukan kosmetik: Issue #693's acceptance criterion melarang "authorization decision relies on hidden/disabled UI alone" — sebuah `<select disabled>` yang tampil seperti kontrol asli menyiratkan kapabilitas switching yang sebenarnya tidak ada, dan atribut `disabled` murni presentational sisi klien (bisa dilepas via devtools) yang tidak boleh menjadi batas keamanan.

Alasan struktural tidak berubah: skema `awcms_mini_identities.tenant_id` adalah 1:1 per tenant (tidak ada cross-tenant identity linking), sehingga "switch tenant" sungguhan tidak punya target untuk saat ini — bukan untuk peran/permission manapun. `TenantBadge`'s `availableTenants` prop adalah seam ekstensibilitas yang sengaja disediakan: bila cross-tenant identity linking pernah ditambahkan, kapabilitas itu HARUS dihitung server-side (daftar tenant yang identity ini benar-benar boleh switch ke situ, bukan flag klien) sebelum komponen ini merender kontrol interaktif sungguhan — lihat docblock komponen itu sendiri untuk detail lengkap.

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

Epic full-online auth security hardening (#587-#593) **sekarang 100%
selesai**: #587 (gate bersama, lihat §Full-online-only auth security
feature gate di bawah), #588 (Cloudflare Turnstile,
`src/lib/security/turnstile.ts` — bukan bagian modul ini, tapi dipanggil
dari `POST /auth/login` di modul ini via `enforceTurnstileIfRequired`),
#589 (MFA/TOTP, lihat §MFA/TOTP login challenge di bawah), #590 (Google
OIDC login, lihat §Google OIDC login di bawah), #591 (generic tenant OIDC
SSO provider, lihat §Generic tenant OIDC SSO provider di bawah), #592
(admin policy UI `/admin/security`, lihat §Admin policy UI di bawah), DAN
#593 (dokumentasi/kontrak/readiness penutup epic — menambah
`checkSsoBreakGlassReady` di `scripts/security-readiness.ts`, lihat skill
di bawah). Lihat skill `awcms-mini-auth-online-hardening` untuk detail
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

## Google OIDC login (Issue #590)

`src/modules/identity-access/application/google-oidc.ts` +
`src/modules/identity-access/domain/google-oidc-policy.ts` (evaluasi
OAuth request/claims, pure) + `src/lib/auth/jwt-verify.ts` (RS256 via
WebCrypto `crypto.subtle`, tanpa library JWT eksternal) +
`google-oauth-client.ts` (token exchange + JWKS fetch, timeout +
circuit breaker) + `oauth-state-token.ts`/`google-oidc-config.ts`
(state/nonce, gate env — modul-agnostic, sama seperti pola
`turnstile.ts`/`mfa-config.ts`).

- Gate gabungan `isGoogleLoginRequired(env)` =
  `isFullOnlineSecurityActive(env)` (#587) ∧
  `AUTH_GOOGLE_LOGIN_ENABLED=true` — pola persis
  `isTurnstileRequired()`/`isMfaRequired()`.
- **Tenant id lewat `state`, bukan header**: `GET .../callback` adalah
  redirect target Google — navigasi browser murni yang tidak bisa
  membawa header `X-AWCMS-Mini-Tenant-ID`. `state` yang dikirim ke
  Google berbentuk `${tenantId}.${rawToken}` (`oauth-state-token.ts`'s
  `buildOAuthStateParam`/`parseOAuthStateParam`) — tenant id bukan
  secret, dan bagian token (pertahanan CSRF/replay sesungguhnya, ≥32
  byte random) tetap di-hash at rest seperti biasa.
- **Login vs link, dua flow berbeda**: `GET .../start` (dari tombol
  "Continue with Google" di `/login`, tanpa session) selalu
  `purpose='login'`. `POST .../link` (butuh session — identity diambil
  server-side dari session, TIDAK PERNAH dipercaya dari request
  callback) mengembalikan `authorizationUrl` sebagai JSON, bukan
  redirect, karena dipanggil lewat `fetch()` dari konteks yang sudah
  login. `GET .../callback` menangani KEDUA purpose berdasarkan row
  `awcms_mini_oidc_auth_requests` yang tersimpan saat start/link.
- **Verifikasi ID token kriptografis penuh** (bukan sekadar baca JSON):
  signature RS256 (WebCrypto, terhadap JWKS Google yang di-cache 1 jam),
  issuer, audience, expiry, DAN nonce — kalau salah satu gagal, hasilnya
  generic `GOOGLE_ID_TOKEN_INVALID` (anti-enumeration, pola sama
  `MFA_CHALLENGE_INVALID`).
- **Provider account ditautkan via `sub`, TIDAK PERNAH via email** —
  `awcms_mini_identity_provider_accounts` (unique per tenant+provider+subject
  DAN per tenant+identity+provider). Auto-link by email HANYA saat
  `email_verified=true` DAN domainnya ada di `AUTH_GOOGLE_ALLOWED_DOMAINS`
  (kosong = auto-link selalu ditolak, fail-closed) — kalau tidak ada
  provider account yang cocok dan auto-link tidak berlaku, login ditolak
  `401 GOOGLE_ACCOUNT_NOT_LINKED`, TIDAK provisioning identity baru.
- **Google login TIDAK PERNAH bypass MFA**: kalau Issue #589 aktif dan
  identity yang berhasil verifikasi Google punya factor TOTP `active`,
  `callback.ts` menjalankan gate MFA yang SAMA persis dengan `login.ts`
  (challenge dibuat, `401 MFA_REQUIRED`, session baru dibuat setelah
  `POST /auth/mfa/totp/verify`) — bukan jalur terpisah yang bisa
  kelewatan.
- **Token exchange/JWKS fetch**: circuit breaker HANYA trip pada
  kegagalan transport genuine (5xx/network/timeout) — respons `400
invalid_grant` Google terhadap `code` yang salah/bekas/kedaluwarsa
  adalah sinyal sehat (Google benar menolak input buruk), BUKAN outage,
  dan tidak pernah menaikkan failure count breaker (pelajaran langsung
  dari bug circuit breaker Turnstile, PR #596 — lihat
  `google-oauth-client.ts`).
- `POST .../unlink`/enroll MFA: high-risk, diaudit
  (`google_account_linked`/`google_account_unlinked`/
  `google_login_succeeded`).
- Detail lengkap + rasional lintas-issue: skill
  `awcms-mini-auth-online-hardening` §Google OIDC login.

## Generic tenant OIDC SSO provider (Issue #591)

`src/modules/identity-access/application/tenant-sso.ts` +
`auth-provider-directory.ts` + `tenant-auth-policy.ts` +
`src/modules/identity-access/domain/tenant-sso-policy.ts` (break-glass
evaluation, auto-link domain resolution, admin input validation, pure)

- `src/lib/auth/sso-config.ts`/`sso-credential-crypto.ts`/
  `generic-oidc-client.ts` (gate env, AES-256-GCM client-secret
  encryption, discovery/JWKS/token-exchange with per-provider circuit
  breaker — module-agnostic, same shape as `google-oidc-config.ts`/
  `mfa-secret-crypto.ts`/`google-oauth-client.ts`).

* Gate gabungan `isSsoRequired(env)` = `isFullOnlineSecurityActive(env)`
  (#587) ∧ `AUTH_SSO_ENABLED=true` — pola persis
  `isTurnstileRequired()`/`isMfaRequired()`/`isGoogleLoginRequired()`.
* **Menggeneralisasi Google OIDC (#590) tanpa mengubahnya**: jalur ini
  adalah PARALEL terhadap `google-oidc.ts`, bukan pengganti — Google
  login tetap berjalan lewat kode/tabelnya sendiri persis seperti
  sebelumnya. SSO generik memakai ulang `awcms_mini_oidc_auth_requests`/
  `awcms_mini_identity_provider_accounts` (migration 035, sudah generik
  `provider text` sejak awal — lihat komentar migration itu) dengan
  `provider = <providerKey>` alih-alih `'google'`.
* **Skema baru (migration 036)**: `awcms_mini_auth_providers` (tenant
  master data — `provider_key`, `provider_type='oidc'`, `issuer_url`,
  `client_id`, client secret terenkripsi AES-256-GCM ATAU nama env var
  referensi — persis salah satu lewat CHECK constraint, TIDAK PERNAH
  dikembalikan plaintext oleh endpoint manapun, `scopes`,
  `allowed_email_domains` jsonb, `enabled`, soft delete) dan
  `awcms_mini_tenant_auth_policies` (satu baris per tenant —
  `password_login_enabled`, `sso_enabled`, `sso_required`,
  `auto_link_verified_email`, `allowed_email_domains` jsonb,
  `break_glass_identity_ids` jsonb, `mfa_required` reserved untuk
  kompatibilitas #589 di masa depan, belum ditegakkan). Keduanya RLS
  `ENABLE`+`FORCE`.
* **Endpoint login/link generik** — pola identik Google: `GET
/auth/sso/{providerKey}/start` (unauthenticated, tenant dari
  header/cookie/`?tenantId=`, tenant di-`SELECT` sebelum INSERT apa pun
  — pola yang sama PR #598 paksakan ke Google `start.ts` untuk
  menghindari trip circuit breaker database aplikasi-lebar),
  `GET .../callback` (redirect target provider, validasi
  `state`/nonce/ID token kriptografis penuh, MFA gate #589 SAMA persis
  dengan `login.ts`/Google), `POST .../link` (butuh session, kembalikan
  `authorizationUrl` sebagai JSON), `POST .../unlink` (high-risk,
  diaudit `sso_account_unlinked`).
* **Admin CRUD API** (bukan admin UI — itu Issue #592) dilindungi ABAC
  (migration 037): `identity_access.sso_providers.{read,create,update,delete}`
  di `/api/v1/identity/sso/providers`(`/{id}`), dan
  `identity_access.sso_policy.{read,update}` di
  `/api/v1/identity/sso/policy`. Semua mutation high-risk: diaudit
  (`sso_provider_created`/`_updated`/`_deleted`, `sso_policy_updated`).
* **OIDC discovery per-provider** (beda dari Google yang endpoint-nya
  hardcoded konstan): `.well-known/openid-configuration` + JWKS
  di-fetch dari `issuer_url` masing-masing provider, di-cache 1 jam,
  timeout `AUTH_SSO_DISCOVERY_TIMEOUT_MS` (default 5000ms), circuit
  breaker PER PROVIDER KEY (`sso-oidc-discovery:<key>`/
  `sso-oidc-jwks:<key>`/`sso-oidc-token:<key>`) — provider satu tenant
  yang tidak sehat tidak pernah memengaruhi tenant/provider lain. Hanya
  kegagalan transport genuine (5xx/network/timeout) yang trip breaker;
  respons 4xx valid dari provider (`invalid_grant`, dst.) TIDAK —
  pelajaran yang sama dari PR #596/#598 diterapkan sejak awal di sini.
* **Break-glass enforcement, di titik SAVE bukan hanya login**:
  `PATCH /api/v1/identity/sso/policy` menolak (`409
BREAK_GLASS_REQUIRED`) permintaan yang membuat `sso_required=true`
  atau `password_login_enabled=false` TANPA minimal satu
  `break_glass_identity_ids` yang saat ini `active` DENGAN tenant_user
  membership `active` — dicek ulang dari DB (`saveTenantAuthPolicy`,
  bukan dipercaya dari body request), bukan sekadar validasi bentuk
  array. `login.ts` menegakkan `password_login_enabled=false` HANYA
  ketika `isSsoRequired(env)` aktif — deployment offline/LAN yang tidak
  pernah menyalakan gate #587/#591 tidak pernah menjalankan query
  tambahan ini maupun mengalami perubahan perilaku login.
* **Auto-link by email**, dua lapis fail-closed: `provider.allowed_email_domains`
  (mirip `AUTH_GOOGLE_ALLOWED_DOMAINS`, per provider) DAN
  `policy.auto_link_verified_email` sebagai master switch — kalau
  `false` (default), tidak pernah auto-link, identity harus
  `POST .../link` eksplisit dari sesi yang sudah login. Provider account
  selalu ditautkan via `sub` (subject OIDC), TIDAK PERNAH via email
  semata.
* Detail lengkap + rasional lintas-issue: skill
  `awcms-mini-auth-online-hardening` §Generic tenant OIDC SSO provider.

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

## Admin policy UI (Issue #592)

`src/pages/admin/security.astro` (bukan bagian `src/modules/`, tapi
satu-satunya UI yang mengonsumsi admin CRUD API modul ini dari #591) +
`src/lib/auth/auth-security-status.ts` (aggregator status env-only,
tanpa I/O — bukan bagian modul ini juga, tapi dipakai halaman ini).

- **Tidak ada endpoint API baru** — halaman ini murni UI di atas API
  #591 yang sudah ada (`GET/PATCH /api/v1/identity/sso/policy`,
  `GET/POST/PATCH/DELETE /api/v1/identity/sso/providers[/{id}]`). SSR
  membaca `getTenantAuthPolicy`/`listAuthProviders` langsung di dalam
  `withTenant` milik halaman (pola sama `admin/settings.astro`), mutation
  lewat endpoint sungguhan via `submitJson` (`admin-form-client.ts`) —
  ABAC + break-glass + audit tetap sepenuhnya ditegakkan server-side oleh
  endpoint #591, halaman ini tidak pernah menulis DB langsung.
- **Dua gate independen**: gate deployment (`isFullOnlineSecurityActive(env)`,
  #587 — nonaktif berarti HANYA notice informational yang dirender,
  dicek server-side di frontmatter SEBELUM markup lain dibuat) dan ABAC
  (`identity_access.sso_policy.*`/`sso_providers.*`, migration 037 —
  gate aktif tapi tanpa permission berarti notice access-denied).
- `StateNotice.astro` (`src/components/ui`) dapat varian ketiga
  `kind="info"` (`role="status"`) untuk state "fitur nonaktif untuk
  profil deployment ini" — beda semantik dari `"denied"`/`"error"`.
- `identityAccessModule`'s `navigation` (Issue #518's registry) kini
  mendaftarkan `/admin/security` (`requiredPermission:
"identity_access.sso_policy.read"`) — muncul di sidebar admin otomatis,
  tidak menyentuh `AdminLayout.astro`.
- Break-glass picker checkbox butuh `identity_access.user_management.read`
  (dipakai ulang dari guard `admin/access-users.astro`) untuk daftar
  tenant user; tanpa izin itu, form jatuh ke textarea UUID manual supaya
  tetap bisa dipakai di bawah least privilege, bukan hilang total.
- Detail lengkap + rasional lintas-issue (termasuk kuirk
  Playwright+Bun `page.request` yang ditemukan saat menulis E2E spec-nya):
  skill `awcms-mini-auth-online-hardening` §Admin policy UI.

## Business-scope assignments & segregation-of-duties (SoD) hooks (Issue #746)

Epic #738 `platform-evolution` Wave 2 — reusable, tenant-contained
business-scope authorization refinement (legal entity/branch/department/
cost center/warehouse/project/operational location, ADR-0013 §2/§4) and a
module-contributed SoD conflict-rule hook, built inside this Core module
rather than a new one (identity_access already owns RBAC/ABAC; a scope
assignment is a narrower grant on top of an existing role, not a new
authorization primitive).

### Schema (`sql/061`, `sql/062`)

Four tenant-scoped tables (`ENABLE`+`FORCE ROW LEVEL SECURITY`,
`tenant_id`-first composite indexes):

- `awcms_mini_business_scope_assignments` — one row = one tenant_user
  granted a role restricted to one `(scope_type, scope_id)` reference,
  with effective dates, temporary expiry, revocation, grantor/approver.
  **Generic reference, not a foreign key**: `scope_type`/`scope_id`
  (text + uuid) never point at any specific optional module's table —
  validity is resolved through `BusinessScopeHierarchyPort` at the
  application layer (see below), never trusted from request input alone
  (issue #746 security requirement) and never a DB-level FK (impossible
  anyway across an unknown future table).
- `awcms_mini_business_scope_assignment_events` — append-only lifecycle
  history (granted/revoked/expired/renewed).
- `awcms_mini_sod_conflict_exceptions` — temporary exception/override
  flow: bounded-lifetime (no indefinite override) approval to proceed
  despite a detected SoD conflict, with justification, requester/approver
  (different tenant users, re-checked from DB), and expiry.
- `awcms_mini_sod_conflict_evaluations` — append-only SoD conflict
  decision log, recorded regardless of outcome (mirrors
  `awcms_mini_abac_decision_logs`'s "append-always" convention).

`sql/062` seeds nine new `identity_access` permissions:
`business_scope_assignments.{read,create,revoke}`,
`business_scope_conflicts.read`,
`business_scope_exceptions.{read,create,approve,reject,revoke}`.

### `BusinessScopeHierarchyPort` (`_shared/ports/business-scope-hierarchy-port.ts`)

Capability port so an optional organization module (`organization_structure`,
Issue #749, ADR-0016) can resolve a scope's validity/ancestors/descendants
**without identity-access ever importing its tables** — the acceptance
criterion "Identity-access has no direct import/table write to an optional
organization module". `resolveScope(tx, tenantId, scopeType, scopeId)`
returns `{ resolved, ancestorScopes, descendantScopes }`, where each entry is
a `{ scopeType, scopeId }` reference rather than a bare id — an ancestor/
descendant chain can legitimately cross scope types (e.g. an organization
unit's ancestor chain terminating at a legal entity), so entries are never
assumed to share the queried scope's own `scopeType` (breaking change from
the original #746 shape, `{ ancestorScopeIds, descendantScopeIds }: string[]`
— see the port's own header for the full rationale). `resolved: false`
(unknown scope type, missing row, or cross-tenant row) is a distinct outcome
from "resolved but flat" and callers must default-deny high-risk actions
on it.

TWO adapters implement this port today. Identity-access itself supplies a
FLAT default: `application/business-scope-hierarchy-port-adapter.ts`'s
`defaultBusinessScopeHierarchyPortAdapter` — validates exactly
`scopeType: "office"` against `awcms_mini_offices` (a direct, precedented
read of a `tenant_admin`-owned table — see that adapter's own header for
why this specific read does not need a new port, unlike hierarchy
resolution for a module identity-access has no lifecycle dependency on
at all) and returns `resolved: false` for every other scope type. Since
Issue #749, `organization_structure`'s own adapter
(`organization-structure/application/organization-structure-hierarchy-port-
adapter.ts`) supersedes this one for `scopeType: "legal_entity"`/
`"organization_unit"`, walking the real effective-dated hierarchy it owns.
Neither adapter supersedes the other outright.

**Wired end-to-end since Issue #786** (a follow-up to #749's own
"zero production callers" disclosure). The sole real composition root today,
`POST /api/v1/identity/business-scope/assignments`'s `buildHierarchyPort`
(`src/pages/api/v1/identity/business-scope/assignments/index.ts`), resolves
`organization_structure`'s per-tenant enablement (`resolveModuleEnabled`,
the same Issue #515 signal every guarded endpoint already enforces) and, when
enabled, tries `organizationStructureHierarchyPortAdapter` FIRST — falling
back to `defaultBusinessScopeHierarchyPortAdapter` when that adapter doesn't
resolve the scope (every other scope type, or ANY scope type at all when
`organization_structure` is disabled for that tenant). This wiring lives in
the route file, never inside `identity_access`'s own `application`/`domain`
tree — importing `organization_structure` there would be a real Core-
depends-on-Optional violation (ADR-0013 §1) that
`tests/unit/module-boundary-cycles.test.ts` structurally forbids. The
capability relationship is also declared in `module.ts`'s
`capabilities.consumes` (`organization_hierarchy_resolution`,
`providedBy: "organization_structure"`, `optional: true`) for the
module-composition validator (Issue #740), the same shape `blog_content`
already declares for its own optional `news_media`/`social_publishing`
consumption — this is a documentation/build-time-validation entry, not the
runtime wiring itself. **Scope note**: this wiring makes scope EXISTENCE/
VALIDITY resolution real for `legal_entity`/`organization_unit`.
**Hierarchy-aware SoD matching (Issue #794, fixing a gap #786 deliberately
left open and #790 made practically reachable)**: `createBusinessScopeAssignment`
(`application/business-scope-assignment-service.ts`) now passes the
requested scope's already-resolved `ancestorScopes`/`descendantScopes` (no
extra hierarchy-port call — it reuses the resolution already fetched to
validate scope existence) as `RequestedScope.relatedScopes` into
`detectSoDConflicts`; a `"same_scope_only"` rule now also matches a held
fact whose scope is a genuine ancestor/descendant of the requested scope,
not only an EXACT `(scopeType, scopeId)` equal one — e.g. a subject holding
`business_scope_assignments.create` at a parent `organization_unit` can no
longer be granted `.revoke` at a hierarchically-related child unit without
tripping `business_scope_assignment_scope_maker_checker`. **Remaining, documented
gap**: `checkHighRiskSoDConflicts` (`application/high-risk-sod-guard.ts`),
the OTHER `same_scope_only` call site wired at the generic
`authorizeInTransaction` chokepoint (used by ~124 route files for many
modules, most with no hierarchy concept at all), has no hierarchy port
plumbed in at all — it still compares `sodScopeType`/`sodScopeId` by exact
equality only. Threading hierarchy resolution through that fully generic
chokepoint (which would require every one of its many callers to supply a
hierarchy port, or resolve one per-request, for scope types the vast
majority of them don't even have) is a materially larger, non-atomic
change deliberately left out of issue #794's scope — tracked in
`docs/awcms-mini/20_threat_model_security_architecture.md`'s SoD threat
table as a distinct residual limitation, not silently absorbed into this
fix's claim.

### ABAC extension (`domain/access-control.ts`)

Purely additive to the existing default-deny chain (ADR-0004): a new
optional `businessScopeFacts` parameter on `evaluateAccess`, and a new
`resourceAttributes.requiredScopeType`/`.requiredScopeId` convention on
`AccessRequest` — a request that does not set these two fields behaves
identically to before. When set, the caller must already hold a resolved
business-scope fact covering exactly that scope, or the request is
denied (`matchedPolicy: "business_scope_unresolved"`) — every
pre-existing call site is unaffected. Two new `AccessAction` values,
`"revoke"` and `"override"`, both added to `HIGH_RISK_ACTIONS`.

### SoD rule registry (`domain/sod-rule-registry.ts`, `_shared/module-contract.ts`)

Mirrors `data_lifecycle/domain/lifecycle-registry.ts`'s
"module declares, central function aggregates+validates" shape exactly:
`ModuleDescriptor.sodRules?: SoDRuleDescriptor[]` (new optional field,
`MODULE_CONTRACT_VERSION` bumped 1.0.0 → 1.1.0, a MINOR/additive change
per that constant's own bump policy). Each rule declares
`conflictingPermissionKeys` (>= 2 `module.activity.action` keys),
`scopeApplicability` (`"global_within_tenant"` | `"same_scope_only"` |
reserved `"any"`), `severity`, and `exceptionPolicy`
(`allowed`/`requiresApprovalPermission`/`maxDurationDays`).
`bun run identity-access:sod-registry:check` (wired into `bun run check`
**and** `.github/workflows/ci.yml`'s `quality` job as an explicit named
step — not relying on `bun run check` alone) validates the whole
registry.

Three real module-contributed rule fixtures (issue #746 acceptance
criterion — deliberately real permission pairs, not contrived examples):

1. `identity_access.business_scope_exception_maker_checker`
   (`global_within_tenant`, `exceptionPolicy.allowed: false` — the
   control that gates SoD overrides is itself never override-able,
   preventing a recursive bypass) — a subject who can request an
   exception must not also approve one.
2. `identity_access.business_scope_assignment_scope_maker_checker`
   (`same_scope_only`) — creating vs. revoking a business-scope
   assignment at the identical scope.
3. `data_lifecycle.legal_hold_maker_checker`
   (`global_within_tenant`, contributed by `data_lifecycle/module.ts`,
   additive-only edit) — `legal_hold.create` vs. `legal_hold.release`
   (Issue #745's own pre-existing, deliberately-separate permission
   pair) is a genuine maker/checker candidate, not invented for this
   issue.

### Conflict enforcement — wired at the real `authorizeInTransaction` chokepoint

`application/high-risk-sod-guard.ts`'s `checkHighRiskSoDConflicts` is
called from `access-guard.ts`'s `authorizeInTransaction` for every
`isHighRiskAction` decision, immediately after an ordinary ABAC decision
has already allowed it (deny-overrides-allow: this can only additionally
deny, never upgrade a deny to an allow). It reasons about permissions the
subject holds via **both** an active business-scope assignment **and**
an ordinary RBAC role grant (`business-scope-facts.ts`'s
`resolveSoDAssignmentFacts` merges both sources — see that file's header;
an earlier version only checked the former, a security-auditor finding on
PR #776 fixed before merge, since it made the check permanently blind to
the realistic case of both conflicting permissions being held through an
ordinary role like the setup wizard's "owner"). A cheap code-defined
`Set` membership short-circuit (`SOD_RELEVANT_PERMISSION_KEYS`) means
extending this chokepoint costs nothing measurable for the hundreds of
endpoints this feature does not touch.

**Scope of "chokepoint" — accurate claim, not "every endpoint in this
codebase".** `authorizeInTransaction` is used by 124 route files, but 13
pre-existing route files call `evaluateAccess()`/`isHighRiskAction()`
directly instead (not introduced by this issue) — including 3 high-risk
ones this issue does not touch (`profiles/[id]` delete/restore/purge) and
`workflows/tasks/[id]/decisions.ts` (approve, its own hand-rolled
self-approval guard outside `access-guard.ts`). No current
`SoDRuleDescriptor` fixture references those endpoints' permission keys,
so there is no active gap today, but a future SoD rule targeting one of
them would silently not be enforced — see `high-risk-sod-guard.ts`'s own
header for the same disclosure; migrating those 13 callers is a plausible
follow-up, not attempted here.

`tests/integration/business-scope-sod-chokepoint.integration.test.ts`
proves conflict enforcement against a real, unrelated guarded endpoint
(`POST /api/v1/data-lifecycle/legal-holds/{id}/release`) this issue did
not modify — not just a unit test of the pure conflict-detection
function — and `tests/integration/business-scope-assignments.integration.
test.ts`'s "ordinary RBAC alone" test proves the same conflict is caught
with no business-scope assignment involved at all.

SoD conflict evaluation also runs at assignment **creation** time
(`application/business-scope-assignment-service.ts`'s
`createBusinessScopeAssignment`) against the subject's other active
assignments, recording to `awcms_mini_sod_conflict_evaluations`
regardless of outcome.

### Exception flow

`application/sod-exception-service.ts` — request (pending) → approve/
reject/revoke. Approval requires a **different** tenant user than the
requester, re-checked from the fetched row itself (never trusted from
the request body — same "re-check from DB, don't trust body" idiom
`tenant-sso.ts`'s break-glass evaluation documents). An exception's
`status: "approved"` is a cache; `effectiveTo` compared against `now()`
is the real gate (`isSoDConflictExceptionCurrentlyValid`) — an approved
exception past its `effectiveTo` no longer authorizes anything even
before the expiry job has run.

### Scheduled expiry job

`application/business-scope-expiry-job.ts` + `scripts/identity-access-
business-scope-expiry.ts` (`bun run identity-access:business-scope:expiry`,
hourly recommended) — built on the shared worker runner (`runJob`) and
`iterateTenantsInBatches`, same shape as `data-lifecycle:archive-purge`:
transitions assignments/exceptions past `effective_to` to `expired`,
records lifecycle events + audit entries, refreshes
`business_scope_assignments_active`/`_temporary` gauges. Registered in
`work-class-registry.ts` (`workClass: "maintenance"`, same profile as
`audit-log-purge`/`data-lifecycle-archive-purge`) and granted
least-privilege `awcms_mini_worker` access in `sql/061` (`SELECT`/`UPDATE`
on assignments and exceptions, `SELECT`/`INSERT` on the assignment-events
history — no access to `awcms_mini_sod_conflict_evaluations`, which the
worker never writes).

### API + admin UI

`GET/POST /api/v1/identity/business-scope/assignments`,
`POST .../assignments/{id}/revoke`,
`GET/POST /api/v1/identity/business-scope/exceptions`,
`POST .../exceptions/{id}/{approve,reject,revoke}`,
`GET /api/v1/identity/business-scope/conflicts` (keyset-paginated, safe
projection — rule key/subject id/trigger/outcome/reason/timestamp only,
no request/resource payload). All mutations require `Idempotency-Key`
and write an audit event; `create`/`revoke` on assignments and
`approve`/`revoke` on exceptions are classified high-risk.

`src/pages/admin/business-scope.astro` (nav entry
`requiredPermission: "identity_access.business_scope_assignments.read"`,
order 56, right after `/admin/security`) — three permission-gated
sections (assignments, exceptions, conflict history), each independently
checked against its own endpoint's guard, following
`admin/access-users.astro`'s established pattern (SSR read via
`withTenant`, mutation via `submitJson` against the real endpoints, no
privileged shortcut).

### Metrics

`business_scope_assignments_active`/`_temporary` (gauges, by
`scopeType`), `business_scope_expirations_total` (counter, by
`itemType`), `business_scope_cross_tenant_denied_total` (counter,
scope-resolution failures — a proxy for unknown-type/missing-row/
cross-tenant, not a precise cross-tenant-only signal),
`sod_conflicts_detected_total` (counter, by `ruleKey`/`resolvedVia`),
`sod_exceptions_granted_total` (counter, by `ruleKey`).

### Out of scope (unchanged from issue #746's own text)

Legal-entity/organization-unit tables, replacing tenant RLS with
business-scope filters, and domain-specific finance/procurement/payroll/
approval rules all remain out of scope for the base — this issue is
purely the reusable mechanism + hook, matching ADR-0013 §4's own
"business-role...defined here purely as a boundary concept" framing.
