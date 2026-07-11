# Bagian 18 — Configuration dan Environment Reference

> **Standar base + contoh domain.** Dokumen ini adalah **standar/pola reusable** base AWCMS-Mini. Contoh yang dipakai memakai domain retail/POS bergaya AWPOS sebagai ilustrasi — ganti detail domainnya dengan kebutuhan aplikasi turunan Anda. Lihat [README paket dokumen](README.md) §Reusable vs domain turunan.

## Tujuan

Dokumen ini melengkapi referensi konfigurasi lengkap AWCMS-Mini: seluruh environment variable, feature flag opsional, presedensi konfigurasi, profil per-environment, penanganan secret, dan topologi deployment offline/LAN-first. Melengkapi `.env.example` minimal di doc 11.

Terkait: `11_implementation_blueprint.md` (skeleton), `15/16` (FE/BE), `07_sprint_testing_production_readiness.md` (deployment).

## Prinsip konfigurasi

1. Semua secret hanya dari **environment**, tidak pernah di kode/commit.
2. `.env` di-ignore; `.env.example` hanya placeholder.
3. Provider eksternal **opsional** via feature flag; default off.
4. POS tidak boleh gagal karena provider off.
5. Konfigurasi tervalidasi saat boot; nilai wajib yang hilang menghentikan start dengan pesan jelas.
6. Soft delete adalah perilaku platform wajib, bukan feature flag; retention/purge dikontrol policy dan workflow.
7. Runtime, build, dan seluruh tooling wajib **Bun** (Bun-only); tidak ada binary `node` di jalur dev/build/deploy (lihat doc 10 §Standar platform backend & AGENTS.md aturan 14).

## Runtime & tooling (Bun-only)

- **Runtime & package manager**: Bun (`packageManager: bun@x.y.z` mengunci versi). Semua script `package.json` dipanggil via `bun`/`bun run`; tidak ada `node`/`npm`/`npx`/`pnpm`/`yarn`.
- **Build/dev**: bin dengan shebang node (astro/vite) dijalankan `bun --bun …` agar tidak jatuh ke binary `node`. Jangan sediakan varian script `build:node`.
- **Server**: `Bun.serve` native; jika memakai `@astrojs/node` (standalone) untuk SSR, entry dijalankan `bun ./dist/server/entry.mjs` (runtime tetap Bun) — pengecualian tercatat di `AUDIT_STANDAR_PENGEMBANGAN_2026-07-04.md`.
- **Database**: `Bun.sql` atau `postgres` (postgres.js).
- **Deployment**: `deploy/systemd` `ExecStart` memakai path `bun`; image container memakai basis `oven/bun` (bukan `node`). CI memakai Bun-only (setup-bun, `bun install --frozen-lockfile`, `bun test`, `bun --bun astro build`).
- **Diizinkan** (bukan pelanggaran): import `node:*` (API bawaan Bun) dan `@types/*` di devDependencies — keduanya tidak menarik runtime Node.js.

## Presedensi

```mermaid
flowchart LR
  Def[Default kode] --> Env[Environment variable] --> Set[awcms_mini_tenant_settings - per tenant] --> Eff[Konfigurasi efektif]
```

- Runtime/secret (DB, JWT, HMAC, provider key): dari **environment**.
- Preferensi tenant (locale — default **en**, theme): dari **`awcms_mini_tenants`**; flag fitur tampilan: dari **`awcms_mini_tenant_settings`**. Keduanya dikelola lewat `GET/PATCH /api/v1/settings` dan layar `/admin/settings` (Settings PR). String UI statis via katalog `.po` gettext (di-bundle, bukan DB); konten data multi-bahasa di DB per locale aktif (doc 14 §i18n, doc 04 §Konten multi-bahasa).
- Retention soft delete/purge dapat menjadi tenant policy, tetapi tidak boleh menonaktifkan audit, RLS, atau default filter `deleted_at IS NULL`.

## Referensi environment variable

Legenda: Wajib = perlu untuk boot; Sensitif = jangan bocor ke log/response.

### Config registry (Issue #689, epic #679 platform-hardening)

`src/lib/config/registry.ts` adalah **satu sumber kebenaran terstruktur**
(TypeScript, bukan JSON — full type-checking) untuk setiap environment
variable yang dibaca aplikasi/tooling deployment repo ini: satu entry per
variabel dengan field `type` (string/boolean/integer/url/enum/path/csv/
uuid), `required` (`required`/`optional`/`conditional` — mencerminkan
penegakan `scripts/validate-env.ts` HARI INI), `ownerModule`, `sensitivity`
(`secret`/`non-secret` — untuk redaction), `profiles` (development/staging/
production/offline-lan mana yang relevan), `default`, dan opsional
`deprecated` (`since`/`removalVersion`/`guidance`). Tabel-tabel di bawah
tetap tabel prosa yang sama seperti sebelumnya (readable Markdown untuk
manusia) — registry adalah lapisan metadata terstruktur yang
**dibandingkan** dengannya, bukan pengganti prosa ini.

`bun run config:docs:check` (`scripts/config-docs-check.ts`, bagian dari
`bun run check`) menegakkan parity tiga arah antara registry ini,
`.env.example`, dan tabel-tabel dokumen ini — gagal (exit 1) bila ada
variabel di salah satu tempat yang tidak ada di tempat lain, kecuali
terdaftar eksplisit di `CONFIG_EXEMPTIONS` (registry.ts, untuk var yang
sengaja BUKAN bagian registry — mis. `NODE_ENV`/`PORT` platform-level, atau
`STARSENDER_*`/`MAILKETING_ENABLED`/`AI_*` yang ilustratif untuk aplikasi
turunan) atau `DOC18_NON_VARIABLE_TOKENS` (config-docs-check.ts, untuk
token huruf besar di dokumen ini yang bukan nama variabel sama sekali —
keyword SQL, nama konstanta kode, atau nama variabel yang disebut justru
untuk menyatakan "TIDAK ada").

**Kebijakan deprecation**: menandai sebuah entry `deprecated` di registry
TIDAK PERNAH otomatis mengubah perilaku lulus/gagal `bun run
config:validate` — lihat field `guidance` masing-masing entry untuk apa
yang sebenarnya berubah (biasanya: belum ada, versi major berikutnya baru
benar-benar menghapus variabelnya, sesuai `removalVersion`). Enam variabel
ditandai `deprecated` sejak issue ini (diverifikasi mati/menyesatkan lewat
grep menyeluruh, bukan asumsi dari deskripsi issue saja — lihat entry
masing-masing di `src/lib/config/registry.ts` untuk bukti lengkap):

| Var                  | Kenapa                                                                                                     | Ganti dengan                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `AUTH_JWT_SECRET`    | Tidak pernah dibaca — sesi memakai token opaque (`awcms_mini_sessions.token_hash`), bukan JWT              | Tidak ada — token sesi acak kriptografis, tidak diturunkan dari secret bersama       |
| `APP_TIMEZONE`       | Tidak pernah dibaca — `src/lib/i18n/format.ts` hardcode `Asia/Jakarta`; timezone per tenant dari DB        | Ubah timezone tenant lewat `/admin/settings` (`awcms_mini_tenant_settings.timezone`) |
| `APP_DEFAULT_LOCALE` | Tidak pernah dibaca — `src/lib/i18n/locale.ts` hardcode `DEFAULT_LOCALE = "en"`; locale per tenant dari DB | Ubah `default_locale` tenant lewat Setup Wizard / data tenant, bukan env var         |
| `AWCMS_MINI_NODE_ID` | Tidak pernah dibaca — identitas node berasal dari `awcms_mini_sync_nodes` (DB), bukan env var              | Tidak ada — node teregistrasi otomatis lewat header/HMAC saat request sync pertama   |
| `STORAGE_DRIVER`     | Tidak pernah dibaca — switch lokal/R2 sesungguhnya adalah `R2_ENABLED`                                     | `R2_ENABLED=true`/`false`                                                            |
| `LOCAL_STORAGE_PATH` | Tidak pernah dibaca — tidak ada kode yang menulis ke path ini                                              | Tidak ada                                                                            |

`AUTH_JWT_SECRET`/`APP_TIMEZONE` **tetap** wajib non-kosong di
`config:validate` untuk rilis ini (tidak ada perubahan perilaku boot pass/
fail dibanding sebelum Issue #689 — setiap `.env` yang sudah lulus tetap
lulus); `removalVersion: "1.0.0"` di registry menandai kapan penegakan
wajib ini (dan variabelnya sendiri) direncanakan benar-benar dihapus.
Ketiga variabel lain sudah opsional hari ini dan tidak berubah.

### Inti aplikasi

| Var                         | Wajib | Default                 | Sensitif | Fungsi                                                                                                                                                                        |
| --------------------------- | ----- | ----------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_ENV`                   | Ya    | `development`           | –        | development/staging/production                                                                                                                                                |
| `APP_URL`                   | Ya    | `http://localhost:4321` | –        | Base URL aplikasi                                                                                                                                                             |
| `APP_TIMEZONE`              | Ya    | `Asia/Jakarta`          | –        | **DEPRECATED** (Issue #689, target hapus `1.0.0`) — tidak pernah dibaca; lihat §Config registry di atas                                                                       |
| `APP_DEFAULT_LOCALE`        | –     | `id`                    | –        | **DEPRECATED** (Issue #689, target hapus `1.0.0`) — tidak pernah dibaca; lihat §Config registry di atas                                                                       |
| `LOG_LEVEL`                 | –     | `info`                  | –        | debug/info/warn/error                                                                                                                                                         |
| `AUDIT_LOG_RETENTION_DAYS`  | –     | `730`                   | –        | Retensi `awcms_mini_audit_events` (hari) dipakai `bun run logs:audit:purge` (Issue #447; doc 04 §Retention awal)                                                              |
| `FORM_DRAFT_RETENTION_DAYS` | –     | `30`                    | –        | Retensi `awcms_mini_form_drafts` `expired`/`abandoned` (hari) dipakai `bun run form-drafts:purge` (Issue #484; `--retention-days=<n>` CLI flag override lebih diprioritaskan) |

### Database & pool

| Var                             | Wajib | Default                    | Sensitif | Fungsi                                                                                                                                                                                                                           |
| ------------------------------- | ----- | -------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                  | Ya    | –                          | Ya       | Koneksi PostgreSQL (role `awcms_mini_app`)                                                                                                                                                                                       |
| `AWCMS_MINI_APP_DB_PASSWORD`    | –     | `awcms_mini_app_password`  | Ya       | Password role `awcms_mini_app` dipakai `deploy/postgres/10-create-app-role.sh`/`docker-compose.yml` saat init container; harus sama dengan password di `DATABASE_URL`. Tidak dibaca kode TypeScript apa pun (shell/compose saja) |
| `DATABASE_POOL_MAX`             | –     | `20`                       | –        | Maks koneksi pool                                                                                                                                                                                                                |
| `DATABASE_STATEMENT_TIMEOUT_MS` | –     | `15000`                    | –        | Timeout statement                                                                                                                                                                                                                |
| `DATABASE_PGBOUNCER`            | –     | `false`                    | –        | Mode PgBouncer (transaction)                                                                                                                                                                                                     |
| `WORKER_DATABASE_URL`           | –     | fallback ke `DATABASE_URL` | Ya       | Koneksi role `awcms_mini_worker` (7 background script)                                                                                                                                                                           |
| `SETUP_DATABASE_URL`            | –     | fallback ke `DATABASE_URL` | Ya       | Koneksi role `awcms_mini_setup` (`POST /api/v1/setup/initialize`)                                                                                                                                                                |

#### Model role database (Issue #683, epic #679, platform-hardening)

Sejak migration `sql/045_awcms_mini_db_role_separation.sql`, ada **empat**
role Postgres, bukan dua:

1. **Migration owner** (superuser/owner) — dipakai `bun run db:migrate`
   saja, lewat `DATABASE_URL` yang di-override di command line (lihat
   contoh di §Database & pool atas). Satu-satunya role yang bisa
   `ALTER`/`DROP`/`CREATE`/`GRANT`.
2. **`awcms_mini_app`** ("web runtime", `DATABASE_URL`) — melayani setiap
   HTTP request biasa. DML penuh di tabel tenant-scoped (RLS FORCE'd —
   itu batas keamanan sesungguhnya, ADR-0003). Di 9 tabel global
   (non-RLS: `awcms_mini_permissions`, `awcms_mini_schema_migrations`,
   `awcms_mini_setup_state`, `awcms_mini_tenants`, `awcms_mini_modules` +
   4 tabel turunannya) hanya diberi hak yang benar-benar dipakai jalur
   request — lihat header `sql/045...sql` untuk matriks lengkap per
   tabel.
3. **`awcms_mini_worker`** ("background worker", `WORKER_DATABASE_URL`,
   BARU) — 7 script cron/systemd-timer tanpa endpoint HTTP
   (`analytics:rollup`, `analytics:purge`, `logs:audit:purge`,
   `sync:objects:dispatch`, `email:dispatch`, `blog:publish:scheduled`,
   `form-drafts:purge`). Nol akses ke 9 tabel global kecuali `SELECT` di
   `awcms_mini_tenants` (untuk iterasi tenant aktif).
4. **`awcms_mini_setup`** ("bootstrap/setup", `SETUP_DATABASE_URL`, BARU)
   — hanya `POST /api/v1/setup/initialize` (wizard setup sekali-jalan).
   Defense-in-depth di atas kunci singleton `awcms_mini_setup_state` yang
   sudah ada — bukan pengganti kunci itu.

`WORKER_DATABASE_URL`/`SETUP_DATABASE_URL` **opsional**:
`src/lib/database/client.ts`'s `getWorkerDatabaseClient()`/
`getSetupDatabaseClient()` fallback ke `DATABASE_URL` (role
`awcms_mini_app`) bila keduanya tidak di-set — deployment kecil/offline
yang tidak ingin mengelola 4 connection string tetap jalan lewat satu
role `awcms_mini_app` yang sudah dipersempit di migration 045 (tetap
lebih aman dari sebelumnya, hanya kehilangan lapisan defense-in-depth
tambahan). `AWCMS_MINI_WORKER_DB_PASSWORD`/`AWCMS_MINI_SETUP_DB_PASSWORD`
(dipakai `deploy/postgres/11-create-worker-setup-roles.sh` untuk
mengaktifkan LOGIN role tersebut di docker-compose) juga opsional dengan
alasan yang sama. `bun run security:readiness`'s
`checkRuntimeRoleGlobalTableGrants` adalah regression guard-nya —
menolak (critical) migration masa depan yang tanpa sengaja memberi grant
tambahan di salah satu dari 9 tabel global tersebut.

### Auth & keamanan

| Var                                         | Wajib          | Default                                  | Sensitif | Fungsi                                                                                                                                |
| ------------------------------------------- | -------------- | ---------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_JWT_SECRET`                           | Ya             | –                                        | Ya       | **DEPRECATED** (Issue #689, target hapus `1.0.0`) — tidak pernah dibaca; sesi memakai token opaque, bukan JWT; lihat §Config registry |
| `AUTH_SESSION_TTL_MIN`                      | –              | `120`                                    | –        | Umur sesi                                                                                                                             |
| `AUTH_COOKIE_SECURE`                        | –              | `true`                                   | –        | Cookie hanya HTTPS di prod                                                                                                            |
| `AUTH_LOGIN_MAX_ATTEMPTS`                   | –              | `5`                                      | –        | Lockout login (per identitas)                                                                                                         |
| `AUTH_LOGIN_RATE_LIMIT_MAX`                 | –              | `20`                                     | –        | Rate limit login per sumber+tenant (Issue #437)                                                                                       |
| `AUTH_LOGIN_RATE_LIMIT_WINDOW_SEC`          | –              | `60`                                     | –        | Jendela waktu rate limit login (detik)                                                                                                |
| `AUTH_PASSWORD_RESET_TOKEN_TTL_MIN`         | –              | `30`                                     | –        | Umur token reset password (Issue #496)                                                                                                |
| `AUTH_PASSWORD_RESET_RATE_LIMIT_MAX`        | –              | `5`                                      | –        | Rate limit forgot/reset per sumber+tenant                                                                                             |
| `AUTH_PASSWORD_RESET_RATE_LIMIT_WINDOW_SEC` | –              | `900`                                    | –        | Jendela waktu rate limit reset password (detik)                                                                                       |
| `AUTH_ONLINE_SECURITY_ENABLED`              | –              | `false`                                  | –        | Gate full-online-only auth hardening (Issue #587) — lihat §Full-online auth security hardening di bawah                               |
| `AUTH_ONLINE_SECURITY_PROFILE`              | –              | `disabled`                               | –        | `disabled` (default) atau `full_online`; wajib `full_online` bila `AUTH_ONLINE_SECURITY_ENABLED=true`                                 |
| `TURNSTILE_ENABLED`                         | –              | `false`                                  | –        | Cloudflare Turnstile bot protection (Issue #588) — lihat §Full-online auth security hardening di bawah                                |
| `TURNSTILE_SITE_KEY`                        | bila Turnstile | –                                        | –        | Site key publik (bukan secret) — dirender di widget `/login`                                                                          |
| `TURNSTILE_SECRET_KEY`                      | bila Turnstile | –                                        | Ya       | Secret key — hanya untuk verifikasi server-side, tidak pernah ke klien                                                                |
| `TURNSTILE_VERIFY_TIMEOUT_MS`               | –              | `5000`                                   | –        | Timeout panggilan siteverify Cloudflare (ms)                                                                                          |
| `AUTH_MFA_ENABLED`                          | –              | `false`                                  | –        | MFA/TOTP login challenge (Issue #589) — lihat §Full-online auth security hardening di bawah                                           |
| `AUTH_MFA_SECRET_ENCRYPTION_KEY`            | bila MFA       | –                                        | Ya       | Key AES-256-GCM (base64, 32 byte) untuk enkripsi-at-rest TOTP secret                                                                  |
| `AUTH_MFA_TOTP_ISSUER`                      | –              | `AWCMS-Mini`                             | –        | Nama issuer yang tampil di aplikasi authenticator                                                                                     |
| `AUTH_MFA_TOTP_PERIOD_SEC`                  | –              | `30`                                     | –        | Panjang time-step TOTP (detik)                                                                                                        |
| `AUTH_MFA_TOTP_DIGITS`                      | –              | `6`                                      | –        | Jumlah digit kode TOTP (`6` atau `8`)                                                                                                 |
| `AUTH_MFA_CHALLENGE_TTL_SEC`                | –              | `300`                                    | –        | Umur challenge MFA login (detik)                                                                                                      |
| `AUTH_MFA_RATE_LIMIT_MAX`                   | –              | `5`                                      | –        | Rate limit `POST /auth/mfa/totp/verify` per sumber+tenant                                                                             |
| `AUTH_MFA_RATE_LIMIT_WINDOW_SEC`            | –              | `300`                                    | –        | Jendela waktu rate limit verifikasi MFA (detik)                                                                                       |
| `AUTH_GOOGLE_LOGIN_ENABLED`                 | –              | `false`                                  | –        | Google OIDC login (Issue #590) — lihat §Full-online auth security hardening di bawah                                                  |
| `AUTH_GOOGLE_CLIENT_ID`                     | bila Google    | –                                        | –        | OAuth client ID dari Google Cloud Console                                                                                             |
| `AUTH_GOOGLE_CLIENT_SECRET`                 | bila Google    | –                                        | Ya       | OAuth client secret — hanya untuk token exchange server-side                                                                          |
| `AUTH_GOOGLE_ALLOWED_DOMAINS`               | –              | –                                        | –        | Daftar domain email (dipisah koma) yang boleh auto-link; kosong = auto-link selalu ditolak                                            |
| `AUTH_GOOGLE_REDIRECT_PATH`                 | –              | `/api/v1/auth/providers/google/callback` | –        | Path callback OAuth di bawah `APP_URL`                                                                                                |
| `AUTH_SSO_ENABLED`                          | –              | `false`                                  | –        | Generic tenant OIDC SSO (Issue #591) — lihat §Full-online auth security hardening di bawah                                            |
| `AUTH_SSO_CREDENTIAL_ENCRYPTION_KEY`        | bila SSO       | –                                        | Ya       | Key AES-256-GCM (base64, 32 byte) untuk enkripsi-at-rest client secret provider — beda dari key MFA                                   |
| `AUTH_SSO_DISCOVERY_TIMEOUT_MS`             | –              | `5000`                                   | –        | Timeout discovery/JWKS/token-exchange OIDC provider tenant (ms)                                                                       |
| `AUTH_SSO_MAX_PROVIDERS_PER_TENANT`         | –              | `20`                                     | –        | Batas jumlah baris provider aktif per tenant (Issue #612) — membatasi total budget probing tenant                                     |

### Full-online auth security hardening (opsional, Issue #587-#593)

Gate bersama untuk enam fitur online-only dalam epic ini: Cloudflare
Turnstile (#588), MFA/TOTP (#589), Google OIDC login (#590), generic tenant
OIDC SSO (#591), admin policy UI (#592), dan dokumentasi/kontrak penutup
(#593). **Bukan** pengganti model deployment `APP_ENV=production` — deployment
offline/LAN bisa production-grade secara operasional tanpa pernah butuh fitur
online-only ini (lihat `deployment-profiles.md`).

- `AUTH_ONLINE_SECURITY_ENABLED` tidak di-set (atau bukan `"true"`) → seluruh
  fitur hardening online-only dianggap nonaktif; tidak ada credential
  provider apa pun yang dibutuhkan. Ini default setiap deployment
  offline/LAN.
- `AUTH_ONLINE_SECURITY_ENABLED=true` mewajibkan `AUTH_ONLINE_SECURITY_PROFILE=full_online`
  — nilai lain (termasuk `"disabled"` yang eksplisit kontradiktif) gagal
  `bun run config:validate`.
- Helper terpusat: `isFullOnlineSecurityActive(env)`
  (`src/lib/auth/online-security-config.ts`) — satu-satunya fungsi yang wajib
  dipanggil setiap fitur #588-#592 sebelum melakukan apa pun yang
  online/provider-terkait; jangan re-derive aturan "keduanya harus setuju" di
  tempat lain.
- **Cloudflare Turnstile (Issue #588, selesai)** — `TURNSTILE_ENABLED`
  divalidasi independen dari gate di atas (`checkTurnstileConfig`,
  operator boleh isi credential Turnstile lebih dulu sebelum
  mengaktifkan gate), tapi aktivasi runtime-nya butuh KEDUANYA
  (`isTurnstileRequired(env)` = gate ∧ `TURNSTILE_ENABLED=true`). Berlaku
  di `POST /auth/login`, `/auth/password/forgot`, `/auth/password/reset`,
  `/setup/initialize` — token diverifikasi server-side ke Cloudflare
  siteverify SEBELUM proses password/DB yang mahal
  (`src/lib/security/turnstile.ts`). **Catatan operasional**: verifikasi
  fail-closed by design (token hilang/invalid/misconfigured semuanya
  ditolak) — hanya kegagalan transport genuine ke Cloudflare (HTTP 5xx,
  network error, timeout) yang membuka circuit breaker-nya; respons
  `success:false` yang normal (token client memang salah) TIDAK memicu
  breaker (lihat PR #596 security review — versi awal keliru menyamakan
  keduanya, memungkinkan siapa pun mengunci login/reset/setup semua
  tenant dengan mengirim token sampah berulang). Saat breaker benar-benar
  terbuka (outage Cloudflare sungguhan), seluruh permintaan login/
  password-reset/setup untuk SEMUA tenant akan ditolak selama jendela
  breaker (default 30 detik) — operator yang mengaktifkan fitur ini
  sebaiknya memantau log `turnstile.circuit_breaker_open`/
  `turnstile.provider_call_failed` (severity `warning`) sebagai sinyal
  operasional. Detail lengkap: skill `awcms-mini-auth-online-hardening`.
- **MFA/TOTP (Issue #589, selesai)** — `AUTH_MFA_ENABLED` divalidasi
  independen dari gate di atas (`checkMfaConfig`), tapi aktivasi
  runtime-nya butuh KEDUANYA (`isMfaRequired(env)` = gate ∧
  `AUTH_MFA_ENABLED=true`). MFA **opt-in per identity**, bukan mandatory
  tenant-wide — identity yang belum pernah enroll tetap login normal
  meski gate ini aktif. Endpoint baru: `GET /auth/mfa/status`,
  `POST /auth/mfa/totp/enroll/start|verify`, `POST /auth/mfa/totp/verify`
  (menyelesaikan login yang di-pause `401 MFA_REQUIRED`),
  `POST /auth/mfa/totp/disable`,
  `POST /auth/mfa/recovery-codes/regenerate`. TOTP secret dienkripsi at
  rest (AES-256-GCM, `AUTH_MFA_SECRET_ENCRYPTION_KEY`,
  `src/lib/auth/mfa-secret-crypto.ts`) — satu-satunya secret di aplikasi
  ini yang dienkripsi reversibel, bukan di-hash, karena harus bisa
  dihitung ulang untuk verifikasi kode. Recovery code disimpan hash-only,
  ditampilkan sekali. Replay code TOTP dicegah via
  `last_used_step` per factor. Reset password TIDAK menonaktifkan MFA
  (diverifikasi test integrasi). Detail lengkap: skill
  `awcms-mini-auth-online-hardening`.
- **Google OIDC login (Issue #590, selesai)** — `AUTH_GOOGLE_LOGIN_ENABLED`
  divalidasi independen dari gate di atas (`checkGoogleOidcConfig`), tapi
  aktivasi runtime-nya butuh KEDUANYA
  (`isGoogleLoginRequired(env)` = gate ∧ `AUTH_GOOGLE_LOGIN_ENABLED=true`).
  Endpoint baru: `GET /auth/providers/google/start` (redirect ke Google,
  tombol "Continue with Google" di `/login`), `GET .../callback`
  (redirect target Google, memvalidasi `state`/nonce/ID token lalu
  membuat session ATAU memicu `401 MFA_REQUIRED` bila Issue #589 aktif
  untuk identity itu), `POST .../link` (mulai alur link untuk identity
  yang sudah login, mengembalikan `authorizationUrl` sebagai JSON, bukan
  redirect), `POST .../unlink`. Provider account ditautkan via `sub`
  (subject OIDC), TIDAK PERNAH via email — auto-link by email hanya
  terjadi bila `email_verified` DAN domain-nya ada di
  `AUTH_GOOGLE_ALLOWED_DOMAINS` (kosong = auto-link selalu ditolak,
  fail-closed). ID token diverifikasi kriptografis penuh (signature RS256
  via WebCrypto, issuer, audience, expiry, nonce) — tidak pernah
  dipercaya dari query param begitu saja. `state` param membawa prefix
  tenant id (`${tenantId}.${rawToken}`) karena redirect Google adalah
  navigasi browser murni yang tidak bisa membawa header
  `X-AWCMS-Mini-Tenant-ID`. Detail lengkap: skill
  `awcms-mini-auth-online-hardening`.
- **Generic tenant OIDC SSO (Issue #591, selesai)** — `AUTH_SSO_ENABLED`
  divalidasi independen dari gate di atas (`checkSsoConfig`), tapi aktivasi
  runtime-nya butuh KEDUANYA (`isSsoRequired(env)` = gate ∧
  `AUTH_SSO_ENABLED=true`). Menggeneralisasi Google OIDC login (#590) tanpa
  mengubahnya — provider Google tetap berjalan lewat `google-oidc.ts`-nya
  sendiri; SSO generik ini adalah jalur PARALEL untuk provider
  tenant-configured (Okta, Azure AD, Keycloak, dst.), memakai ulang tabel
  `awcms_mini_oidc_auth_requests`/`awcms_mini_identity_provider_accounts`
  (migration 035, sudah generik `provider text` sejak awal) dengan
  `provider = <providerKey>`. Schema baru (migration 036):
  `awcms_mini_auth_providers` (per tenant: `provider_key`, `issuer_url`,
  `client_id`, client secret terenkripsi AES-256-GCM ATAU env-var
  reference — persis salah satu, tidak pernah keduanya, dan tidak pernah
  plaintext di response API manapun; `scopes`, `allowed_email_domains`
  jsonb, `enabled`, soft delete) dan `awcms_mini_tenant_auth_policies`
  (satu baris per tenant: `password_login_enabled`, `sso_enabled`,
  `sso_required`, `auto_link_verified_email`, `allowed_email_domains`
  jsonb, `break_glass_identity_ids` jsonb, `mfa_required` — reserved untuk
  kompatibilitas #589 di masa depan, belum ditegakkan). Endpoint baru:
  `GET /auth/sso/{providerKey}/start|callback`,
  `POST /auth/sso/{providerKey}/link|unlink` (pola identik Google), plus
  admin CRUD `identity_access.sso_providers.*`/`sso_policy.*` di
  `/api/v1/identity/sso/providers`/`/api/v1/identity/sso/policy`
  (dilindungi ABAC, migration 037). OIDC discovery
  (`.well-known/openid-configuration`) dan JWKS di-fetch per provider (beda
  dari Google yang hardcode endpoint) — timeout `AUTH_SSO_DISCOVERY_TIMEOUT_MS`,
  circuit breaker PER TENANT+PROVIDER KEY (`sso-oidc-discovery:<tenantId>:<key>`/
  `sso-oidc-jwks:<tenantId>:<key>`/`sso-oidc-token:<tenantId>:<key>`, dikoreksi
  Issue #610 setelah security-auditor menemukan versi awal keying-nya hanya
  per `providerKey`, yang bisa bocor lintas tenant kalau dua tenant memakai
  `providerKey` sama), hanya trip pada kegagalan transport genuine (bukan
  respons 4xx valid dari provider), plus negative-TTL failure cache 30 detik
  (per tenant+provider key juga) yang meredam probing berulang tanpa
  memblokir login sah — lihat `generic-oidc-client.ts`. `AUTH_SSO_MAX_PROVIDERS_PER_TENANT`
  (Issue #612) membatasi jumlah baris provider aktif per tenant, supaya
  admin tenant jahat tidak bisa melipatgandakan total budget probing-nya
  dengan mendaftarkan banyak provider. **Break-glass
  enforcement**: `sso_required=true` atau `password_login_enabled=false`
  tidak bisa disimpan (`PATCH .../policy` → `409 BREAK_GLASS_REQUIRED`)
  kecuali minimal satu `break_glass_identity_ids` adalah identity yang saat
  ini `active` DENGAN tenant_user membership `active` — dicek ulang dari DB
  di titik SAVE, bukan hanya di titik login. `login.ts` menegakkan
  `password_login_enabled=false` HANYA saat `isSsoRequired(env)` aktif
  (deployment offline/LAN yang tidak pernah menyalakan gate ini tidak
  pernah menjalankan query tambahan ini maupun berubah perilaku). Detail
  lengkap: skill `awcms-mini-auth-online-hardening`,
  `src/modules/identity-access/README.md`.
- **Admin policy UI (Issue #592, selesai)** — `/admin/security`
  (`src/pages/admin/security.astro` + `src/lib/auth/auth-security-status.ts`)
  menampilkan ringkasan status keenam fitur di atas dan menjadi permukaan
  admin untuk `PATCH /api/v1/identity/sso/policy` +
  `POST|PATCH|DELETE /api/v1/identity/sso/providers[/{id}]` (#591's admin CRUD
  API, tidak ada endpoint baru untuk #592). Dua gate independen mengontrol apa
  yang dirender: gate deployment `isFullOnlineSecurityActive(env)` (#587) — di
  setiap deployment offline/LAN/local (default), halaman hanya menampilkan
  `StateNotice` informational, tanpa form/tabel apa pun; DAN ABAC
  (`identity_access.sso_policy.*`/`sso_providers.*`). Detail lengkap: skill
  `awcms-mini-auth-online-hardening`, `src/modules/identity-access/README.md`.
- **#593 (dokumentasi/kontrak/readiness penutup epic, selesai)** — audit
  epic-wide ini sendiri: `scripts/security-readiness.ts` menambah
  `checkSsoBreakGlassReady` (critical) yang mem-verifikasi ULANG dari DB,
  pada waktu readiness/go-live (bukan hanya waktu save kebijakan), bahwa
  setiap tenant dengan `sso_required=true`/`password_login_enabled=false`
  masih punya minimal satu break-glass identity yang BENAR-BENAR eligible
  saat ini — menutup celah "break-glass identity dinonaktifkan setelah
  kebijakan disimpan" yang tidak bisa dideteksi `saveTenantAuthPolicy`'s
  validasi save-time saja.

### Batas ukuran request body (Issue #686, epic #679, platform-hardening)

Tidak ada env var — batas ini adalah konstanta kode
(`src/lib/security/request-body-limit.ts`), sengaja tidak dibuat
configurable agar tidak ada deployment yang bisa diam-diam melonggarkan
plafon keras tanpa review kode. Setiap handler `/api/*` yang menerima
body membaca lewat `readJsonBody`/`readTextBody`/`readFormBody`
(pengganti `request.json()`/`.text()`/`.formData()` langsung) —
menegakkan `Content-Length` yang dideklarasikan SEBELUM byte apa pun
dibaca, dan penghitungan byte streaming untuk body chunked/tanpa
`Content-Length` (declared length tidak pernah dipercaya sendirian).
Tier: `default` (128 KiB, mayoritas endpoint CRUD/settings/auth — termasuk
`sync/pull`, body-nya hanya `{ limit? }` kecil), `large` (5 MiB, endpoint
konten-berat: blog post/page/template/theme, email template/announcement,
homepage section news-portal, `sync/push`/`sync/objects` batch). Plafon
keras `BODY_SIZE_HARD_CEILING_BYTES` (10 MiB, sama
urutan besaran dengan `NEWS_MEDIA_R2_MAX_UPLOAD_BYTES` di atas) — tidak
ada tier yang boleh melebihinya, ditegakkan tes unit, bukan hanya
didokumentasikan. Body yang terlalu besar selalu `413
PAYLOAD_TOO_LARGE`, dibedakan dari `400 VALIDATION_ERROR` (JSON tidak
valid) — endpoint konten-media (`media/news-images/upload-sessions/*`)
tidak terpengaruh karena byte gambar sesungguhnya lewat jalur presigned
R2, tidak pernah lewat body handler Astro (Keputusan kunci #2, skill
`awcms-mini-news-portal`). Backstop tambahan di
`src/middleware.ts` menolak `Content-Length` yang dideklarasikan
melebihi plafon keras SEBELUM request menyentuh handler mana pun — lapis
kedua, bukan pengganti, pengecekan per-handler di atas (tidak bisa
menangkap body chunked/tanpa `Content-Length`, hanya yang
dideklarasikan). `deploy/nginx/awcms-mini.conf.example`'s
`client_max_body_size 10m` diselaraskan dengan plafon keras yang sama
— defense-in-depth di lapisan proxy, bukan satu-satunya perlindungan
(doc 18 §Topologi deployment LAN-first: banyak deployment jalan tanpa
nginx sama sekali).

### Sync & node

| Var                            | Wajib     | Default          | Sensitif | Fungsi                                                                                                                                                    |
| ------------------------------ | --------- | ---------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AWCMS_MINI_NODE_ID`           | –         | `local-dev-node` | –        | **DEPRECATED** (Issue #689, target hapus `1.0.0`) — tidak pernah dibaca; identitas node berasal dari `awcms_mini_sync_nodes` (DB); lihat §Config registry |
| `AWCMS_MINI_SYNC_ENABLED`      | –         | `false`          | –        | Aktifkan sync hybrid                                                                                                                                      |
| `AWCMS_MINI_SYNC_HMAC_SECRET`  | bila sync | –                | Ya       | Signature HMAC                                                                                                                                            |
| `AWCMS_MINI_SYNC_MAX_SKEW_SEC` | –         | `300`            | –        | Toleransi anti-replay                                                                                                                                     |

### Storage

| Var                             | Wajib   | Default     | Sensitif | Fungsi                                                                                                                                     |
| ------------------------------- | ------- | ----------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `STORAGE_DRIVER`                | –       | `local`     | –        | **DEPRECATED** (Issue #689, target hapus `1.0.0`) — tidak pernah dibaca; switch lokal/R2 sesungguhnya `R2_ENABLED`; lihat §Config registry |
| `LOCAL_STORAGE_PATH`            | –       | `./storage` | –        | **DEPRECATED** (Issue #689, target hapus `1.0.0`) — tidak pernah dibaca; lihat §Config registry                                            |
| `R2_ENABLED`                    | –       | `false`     | –        | Aktifkan R2                                                                                                                                |
| `R2_ACCOUNT_ID`                 | bila R2 | –           | Ya       | Akun R2                                                                                                                                    |
| `R2_ACCESS_KEY_ID`              | bila R2 | –           | Ya       | Kredensial R2                                                                                                                              |
| `R2_SECRET_ACCESS_KEY`          | bila R2 | –           | Ya       | Kredensial R2                                                                                                                              |
| `R2_BUCKET`                     | bila R2 | –           | –        | Bucket                                                                                                                                     |
| `OBJECT_SYNC_UPLOAD_TIMEOUT_MS` | –       | `10000`     | –        | Timeout upload dispatcher (Issue #436, `bun run sync:objects:dispatch`)                                                                    |

### Email (base — Issue #493-#495, epic #492)

Modul base reusable (bukan contoh domain) untuk password reset, system
announcement, dan workflow notification — lihat `src/modules/email/README.md`.
Provider-neutral: `EMAIL_PROVIDER` memilih adapter — `mailketing` (adapter
nyata, Issue #495) atau `log` (menulis log terstruktur alih-alih memanggil
provider nyata; dev lokal/test tanpa kredensial Mailketing). **Sengaja beda
namespace** dari baris `MAILKETING_ENABLED`/`MAILKETING_API_TOKEN` di
§Provider CRM (opsional) di bawah — baris itu tetap contoh ilustratif
domain retail/POS "email receipt" (historical issue #390, closed _not
planned_), tidak diubah oleh epic ini.

| Var                             | Wajib           | Default      | Sensitif | Fungsi                                                |
| ------------------------------- | --------------- | ------------ | -------- | ----------------------------------------------------- |
| `EMAIL_ENABLED`                 | –               | `false`      | –        | Aktifkan modul email                                  |
| `EMAIL_PROVIDER`                | bila aktif      | –            | –        | `mailketing` atau `log`                               |
| `EMAIL_FROM_ADDRESS`            | bila aktif      | –            | –        | Alamat pengirim default                               |
| `EMAIL_FROM_NAME`               | –               | `AWCMS-Mini` | –        | Nama pengirim default                                 |
| `EMAIL_SEND_TIMEOUT_MS`         | –               | `10000`      | –        | Timeout satu percobaan kirim (dispatcher, Issue #495) |
| `EMAIL_SEND_MAX_RETRIES`        | –               | `5`          | –        | Batas percobaan retry sebelum `failed` final          |
| `EMAIL_MAILKETING_ACCOUNT_ID`   | bila mailketing | –            | Ya       | Identifier akun Mailketing                            |
| `EMAIL_MAILKETING_API_TOKEN`    | bila mailketing | –            | Ya       | Token/secret API Mailketing                           |
| `EMAIL_MAILKETING_API_BASE_URL` | bila mailketing | –            | –        | Base URL endpoint API Mailketing                      |

### Public routing (opsional, online-first — Issue #556, epic #555)

**Config-only saat Issue #556 ditulis** — tabel var di bawah masih berlaku
identik, tapi konsumennya sudah bertambah sejak saat itu: schema
tenant-domain (#557), module descriptor `tenant_domain` (#558), resolver
host-based `resolvePublicTenantFromRequest` (#559), dan rute publik `/news`
(#560, lihat `src/modules/blog-content/README.md` §Rute publik `/news`)
semuanya sudah ada dan membaca var-var ini. Default (semua var di bawah
tidak di-set) tetap kompatibel dengan deployment offline/LAN yang sudah
ada: rute publik hanya lewat `/blog/{tenantCode}` legacy, tanpa resolusi
tenant dari host — **offline/LAN tetap default, bukan online-first**.
`scripts/validate-env.ts` (`checkPublicRoutingConfig`) menegakkan tabel ini.

| Var                             | Wajib                                     | Default             | Sensitif | Fungsi                                                                                                   |
| ------------------------------- | ----------------------------------------- | ------------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `PUBLIC_TENANT_RESOLUTION_MODE` | –                                         | – (legacy behavior) | –        | `host_default`/`env_default`/`setup_default`/`tenant_code_legacy` — nilai lain gagal validasi            |
| `PUBLIC_DEFAULT_TENANT_ID`      | bila env_default (salah satu dengan CODE) | –                   | –        | UUID tenant default dipakai mode `env_default`                                                           |
| `PUBLIC_DEFAULT_TENANT_CODE`    | bila env_default (salah satu dengan ID)   | –                   | –        | Kode tenant default dipakai mode `env_default`                                                           |
| `PUBLIC_CANONICAL_BASE_PATH`    | –                                         | `/news`             | –        | Base path publik `/news`; wajib absolute path diawali `/` bila diisi                                     |
| `PUBLIC_TRUST_PROXY`            | –                                         | `false`             | –        | Percaya header proxy (`X-Forwarded-Host` dkk.) — **hanya** `true` di belakang reverse proxy tepercaya    |
| `PUBLIC_PLATFORM_ROOT_DOMAIN`   | bila host_default                         | –                   | –        | Root domain platform dipakai resolver host-based (Issue #559) membedakan subdomain tenant dari host lain |

Aturan validasi cross-field (keputusan desain Issue #556, didokumentasikan
di sini karena issue tidak merincinya secara eksplisit):

- `PUBLIC_TENANT_RESOLUTION_MODE` tidak di-set → **bukan error**, tidak ada
  var lain yang wajib — sama seperti `tenant_code_legacy` di lapisan
  _validasi config_ ini (keduanya tidak mewajibkan var tambahan apa pun).
  **Tapi keduanya BUKAN perilaku yang sama di resolver runtime** (keputusan
  eksplisit Issue #560, `src/lib/tenant/public-host-tenant-resolver.ts`'s
  `resolvePublicTenantFromRequest`): mode tidak di-set (`undefined`) tetap
  menjalankan seluruh fallback chain env→setup untuk rute tanpa `tenantCode`
  (`/news`), sedangkan `tenant_code_legacy` eksplisit selalu me-return
  `null` tanpa mencoba fallback apa pun — mode itu berarti operator secara
  eksplisit memilih "tidak ada tebakan tenant default sama sekali".
- `host_default` → `PUBLIC_PLATFORM_ROOT_DOMAIN` **wajib**. Resolver
  host-based (Issue #559) mencocokkan `Host`/subdomain masuk terhadap root
  domain ini untuk membedakan subdomain tenant yang valid dari host asing —
  tanpa root domain, mode ini tidak punya cara aman menentukan tenant mana
  pun dari host.
- `env_default` → minimal salah satu dari `PUBLIC_DEFAULT_TENANT_ID` atau
  `PUBLIC_DEFAULT_TENANT_CODE` **wajib**.
- `setup_default`/`tenant_code_legacy` → tidak ada var tambahan wajib pada
  lapisan config ini (`setup_default` menentukan tenant default lewat data
  Setup Wizard di database, bukan env — di luar scope issue ini).
- `PUBLIC_CANONICAL_BASE_PATH` bila diisi harus absolute path: diawali `/`,
  tanpa spasi, tanpa `//`, tanpa trailing slash kecuali persis `/`.

**Catatan keamanan `PUBLIC_TRUST_PROXY`**: defaultnya **wajib** `false`.
Set `true` **hanya** bila aplikasi berjalan di belakang reverse proxy
tepercaya (mis. `deploy/nginx/awcms-mini.conf.example` dengan TLS
termination) yang benar-benar memvalidasi/mengisi ulang header
`X-Forwarded-Host` dari klien luar — jangan pernah mempercayai header ini
langsung dari klien tanpa proxy tepercaya di depan, karena resolver
host-based Issue #559 (`src/lib/tenant/public-host-tenant-resolver.ts`)
memakainya untuk menentukan tenant, dan spoofing header bisa mengarahkan
request ke tenant yang salah tanpa membocorkan keberadaan tenant lain
(lihat epic #555 §Security notes).

**Persyaratan operasional mengikat**: proxy tepercaya di depan **wajib**
satu hop yang langsung bersebelahan (directly-adjacent) dan **wajib
menimpa (overwrite)** header `X-Forwarded-Host` secara penuh di setiap
request — tidak pernah append/forward nilai yang datang dari klien.
Topologi yang didukung repo ini tidak pernah menghasilkan lebih dari satu
nilai `X-Forwarded-Host` yang sah. Resolver Issue #559 secara sengaja
**tidak** menebak-nebak mana yang tepercaya kalau header itu ternyata
berisi beberapa nilai comma-separated saat runtime (tidak ada konfigurasi
"N trusted hop" di repo ini untuk menghitung dari kanan) — kalau itu
terjadi, resolver mencatatnya sebagai anomali dan fallback ke header
`Host` biasa, persis seperti `PUBLIC_TRUST_PROXY=false` untuk request itu.
Proxy yang salah konfigurasi (append, bukan overwrite) tetap dianggap
tidak tepercaya oleh aplikasi meski operator sudah set `PUBLIC_TRUST_PROXY=true` —
perbaiki konfigurasi proxy-nya, jangan andalkan aplikasi menebak nilai
mana yang benar.

### Cloudflare DNS adapter (opsional — Issue #567, epic #555, modul `tenant_domain`)

Manual domain management (`POST /api/v1/tenant/domains/{id}/verify`, Issue
#562) tetap default MVP. Var di bawah ini semuanya opsional/backward
compatible — tidak di-set sama sekali (atau `TENANT_DOMAIN_DNS_PROVIDER=manual`)
tetap lulus `config:validate` tanpa var lain wajib, dan **belum ada rute
apa pun** di repo ini yang memanggil adapter tersebut (lihat
`src/modules/tenant-domain/README.md` §Cloudflare DNS adapter untuk
detail lengkap — issue ini hanya menambah provider boundary-nya, bukan
wiring ke endpoint).

| Var                                   | Wajib           | Default  | Sensitif | Fungsi                                                                                                                                                |
| ------------------------------------- | --------------- | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TENANT_DOMAIN_DNS_PROVIDER`          | –               | `manual` | –        | `manual` (default) atau `cloudflare` — nilai lain gagal validasi                                                                                      |
| `TENANT_DOMAIN_PLATFORM_ROOT_DOMAIN`  | bila cloudflare | –        | –        | Root domain platform; adapter menolak record di luar domain ini atau subdomainnya                                                                     |
| `TENANT_DOMAIN_CLOUDFLARE_ZONE_ID`    | bila cloudflare | –        | –        | Zone id Cloudflare tempat record dibuat/diperiksa                                                                                                     |
| `TENANT_DOMAIN_CLOUDFLARE_API_TOKEN`  | bila cloudflare | –        | Ya       | Token API Cloudflare — hanya dari env/secret manager, tidak pernah disimpan di DB                                                                     |
| `TENANT_DOMAIN_CLOUDFLARE_TIMEOUT_MS` | –               | `8000`   | –        | Timeout per panggilan adapter (ms) — nilai kosong/tidak valid selalu jatuh ke default, tidak pernah gagalkan boot (pola sama `EMAIL_SEND_TIMEOUT_MS`) |

Aturan validasi cross-field (`scripts/validate-env.ts`'s
`checkTenantDomainDnsConfig`): `TENANT_DOMAIN_DNS_PROVIDER` tidak di-set atau
`manual` → tidak ada var lain wajib. `cloudflare` → ketiga var lain
(`TENANT_DOMAIN_PLATFORM_ROOT_DOMAIN`/`TENANT_DOMAIN_CLOUDFLARE_ZONE_ID`/
`TENANT_DOMAIN_CLOUDFLARE_API_TOKEN`) wajib diisi.
`TENANT_DOMAIN_PLATFORM_ROOT_DOMAIN` sengaja **var terpisah** dari
`PUBLIC_PLATFORM_ROOT_DOMAIN` (§Public routing di atas) meski keduanya
biasanya bernilai sama secara operasional — var itu menggerbangi resolver
host-based publik (Issue #559), var ini menggerbangi hostname mana yang
boleh disentuh adapter Cloudflare (Issue #567), mencegah perubahan satu
concern diam-diam mengubah concern lain.

**Catatan keamanan mengikat**: `TENANT_DOMAIN_CLOUDFLARE_API_TOKEN` hanya
pernah dibaca dari environment/secret manager — tidak pernah disimpan di
`awcms_mini_tenant_domains`, `awcms_mini_module_settings`, atau tabel DB
lain mana pun, dan tidak pernah dirender di admin UI mana pun. Error dari
adapter (`src/modules/tenant-domain/infrastructure/cloudflare-dns-adapter.ts`)
di-redact: hanya kode error numerik Cloudflare yang disurfacekan (bukan
teks `.message` mentah), token/zone id disaring dari teks error apa pun
sebagai defense in depth, dan tidak pernah stack trace. Setiap panggilan
provider timeout-bounded (default 8 detik, bisa diubah lewat
`TENANT_DOMAIN_CLOUDFLARE_TIMEOUT_MS` — security audit follow-up PR #580,
sebelumnya hardcoded) dan dijalankan di luar transaksi DB mana pun (ADR-0006).

### Visitor analytics (opsional, privacy-first — Issue #617, epic: visitor analytics #617-#624)

Modul `visitor_analytics` (`src/modules/visitor-analytics/`). Setiap var
di bawah ini opsional dengan default privacy-first — tidak di-set sama
sekali tetap lulus `config:validate` dan tidak pernah menyimpan raw IP,
raw user-agent, atau geolokasi. **Config-only saat Issue #617 ditulis** —
belum ada tabel analytics (#618), middleware collector (#620), API
(#621), dashboard (#622), atau enrichment geolokasi (#623) yang membaca
var-var ini; itu semua issue lanjutan di epic yang sama.
`scripts/validate-env.ts` (`checkVisitorAnalyticsConfig`) menegakkan
tabel ini.

| Var                                           | Wajib | Default | Sensitif | Fungsi                                                                                                                                                        |
| --------------------------------------------- | ----- | ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VISITOR_ANALYTICS_ENABLED`                   | –     | `true`  | –        | Master switch koleksi telemetry pengunjung                                                                                                                    |
| `VISITOR_ANALYTICS_MODE`                      | –     | `basic` | –        | `basic`/`detailed` — nilai lain gagal validasi                                                                                                                |
| `VISITOR_ANALYTICS_COLLECT_ADMIN`             | –     | `true`  | –        | Koleksi telemetry rute `/admin/*`                                                                                                                             |
| `VISITOR_ANALYTICS_COLLECT_PUBLIC`            | –     | `true`  | –        | Koleksi telemetry rute publik                                                                                                                                 |
| `VISITOR_ANALYTICS_COLLECT_API`               | –     | `false` | –        | Koleksi telemetry panggilan `/api/v1/*`                                                                                                                       |
| `VISITOR_ANALYTICS_DETAILED_ENABLED`          | –     | `false` | –        | Cadangan granularitas session/event mode `detailed`                                                                                                           |
| `VISITOR_ANALYTICS_RAW_IP_ENABLED`            | –     | `false` | –        | Simpan alamat IP mentah — default aman: mati                                                                                                                  |
| `VISITOR_ANALYTICS_RAW_USER_AGENT_ENABLED`    | –     | `false` | –        | Reserved — belum ada kolom raw user-agent (migration 039 hanya `user_agent_hash`); saat ini no-op, lihat `src/modules/visitor-analytics/README.md` §Collector |
| `VISITOR_ANALYTICS_GEO_ENABLED`               | –     | `false` | –        | Aktifkan enrichment geolokasi (Issue #623) — default aman: mati                                                                                               |
| `VISITOR_ANALYTICS_TRUST_PROXY`               | –     | `false` | –        | Percaya header `X-Forwarded-For` dkk. — **hanya** `true` di belakang proxy tepercaya                                                                          |
| `VISITOR_ANALYTICS_TRUST_CLOUDFLARE`          | –     | `false` | –        | Percaya header khusus Cloudflare (`CF-Connecting-IP`, `CF-IPCountry`)                                                                                         |
| `VISITOR_ANALYTICS_ONLINE_WINDOW_SECONDS`     | –     | `300`   | –        | Jendela waktu "online sekarang" — wajib integer positif bila diisi                                                                                            |
| `VISITOR_ANALYTICS_EVENT_RETENTION_DAYS`      | –     | `90`    | –        | Retensi event — wajib integer positif bila diisi                                                                                                              |
| `VISITOR_ANALYTICS_RAW_DETAIL_RETENTION_DAYS` | –     | `30`    | –        | Retensi raw detail — wajib integer positif bila diisi                                                                                                         |
| `VISITOR_ANALYTICS_ROLLUP_RETENTION_DAYS`     | –     | `730`   | –        | Retensi rollup agregat — wajib integer positif bila diisi                                                                                                     |
| `VISITOR_ANALYTICS_HASH_SALT`                 | –     | `""`    | Ya       | Salt fingerprint visitor pseudonymous (Issue #619) — jangan isi nilai asli di sini                                                                            |

> **Peringatan operasional — `VISITOR_ANALYTICS_TRUST_CLOUDFLARE`:** hanya
> nyalakan flag ini bila deployment benar-benar **hanya** bisa dijangkau
> lewat edge Cloudflare (mis. origin di-firewall ke rentang IP
> Cloudflare). Flag ini mempercayai `CF-Connecting-IP` **dan**
> `CF-IPCountry` sekaligus — kalau origin masih bisa diakses langsung,
> klien mana pun bisa memalsukan kedua header itu dan meracuni data IP
> serta geolokasi di analytics. Sama seperti `VISITOR_ANALYTICS_TRUST_PROXY`,
> ini adalah asumsi operasional/infrastruktur, bukan sesuatu yang bisa
> divalidasi dari kode aplikasi.

**Kontrak operasional `VISITOR_ANALYTICS_TRUST_PROXY` /
`VISITOR_ANALYTICS_TRUST_CLOUDFLARE`** mengikuti kontrak yang sama
dengan `PUBLIC_TRUST_PROXY`/`X-Forwarded-Host` di atas: proxy tepercaya
**wajib menimpa (overwrite)** header `X-Forwarded-For`/`CF-Connecting-IP`/
`CF-IPCountry` secara penuh di setiap request, tidak pernah
append/forward nilai dari klien. `resolveAnalyticsClientIp`
(`src/modules/visitor-analytics/domain/client-ip.ts`) secara sengaja
**tidak** menebak-nebak mana yang tepercaya kalau salah satu header itu
berisi beberapa nilai comma-separated saat runtime — kejadian itu
dicatat sebagai anomali (log warning) dan gagal aman (fallback ke
sumber berikutnya / `null`), persis seperti perilaku resolver Issue
#559 untuk `X-Forwarded-Host`.

Aturan validasi (`checkVisitorAnalyticsConfig`): `VISITOR_ANALYTICS_MODE`
bila diisi wajib salah satu dari `VISITOR_ANALYTICS_MODES` (`basic` |
`detailed`); empat var retensi/jendela di atas bila diisi wajib integer
positif (`parsePositiveInt`) — nilai kosong/tidak valid pada var boolean
manapun selalu jatuh ke `false`, mengikuti konvensi var boolean lain di
repo ini. Belum ada aturan cross-field FORMAT di sini (`checkVisitorAnalyticsConfig`
tetap shape-only) — provider geolokasi (Issue #623) tidak menambah var
baru di layer ini.

**Aturan cross-field SAFETY (Issue #624, `bun run security:readiness`,
bukan `config:validate`)** — lima check baru yang menilai KOMBINASI var
di atas, bukan format satu var (detail penuh + tabel severity:
`docs/awcms-mini/visitor-analytics.md` §Config dan readiness checks):

- `VISITOR_ANALYTICS_RAW_IP_ENABLED=true` dengan
  `VISITOR_ANALYTICS_RAW_DETAIL_RETENTION_DAYS` melebihi
  `VISITOR_ANALYTICS_EVENT_RETENTION_DAYS` → **critical**, gagal
  `security:readiness`.
- `VISITOR_ANALYTICS_RAW_USER_AGENT_ENABLED=true` dengan retensi yang
  sama tidak aman → **warning** (flag ini sendiri masih no-op — lihat
  baris di atas).
- `VISITOR_ANALYTICS_GEO_ENABLED=true` tanpa
  `VISITOR_ANALYTICS_TRUST_CLOUDFLARE=true` → **critical**.
- `VISITOR_ANALYTICS_RAW_DETAIL_RETENTION_DAYS` melebihi
  `VISITOR_ANALYTICS_EVENT_RETENTION_DAYS`, ATAU
  `VISITOR_ANALYTICS_ROLLUP_RETENTION_DAYS` lebih pendek dari
  `VISITOR_ANALYTICS_EVENT_RETENTION_DAYS` (independen dari flag raw
  IP/UA) → **warning**.
- `VISITOR_ANALYTICS_HASH_SALT` kosong saat modul aktif → **warning**
  (hash tetap valid secara fungsional tanpa salt, hanya lebih rentan
  korelasi lintas-deployment).

Semua lima check di atas reuse `resolveVisitorAnalyticsConfig` (tidak
pernah baca `process.env.VISITOR_ANALYTICS_*` langsung) dan lulus
BERSIH pada konfigurasi default (semua var tidak di-set) — hanya
`critical` yang memblokir go-live.

### News portal — full-online R2-only preset (opsional, Issue #632, epic `news_portal` #631-#642/#649)

Modul `news_portal` (`src/modules/news-portal/`). Preset tenant module
`news_portal_full_online_r2` (`module-management/domain/module-presets.ts`)
mengaktifkan `blog_content`+`tenant_domain`+`visitor_analytics`+`news_portal`
untuk profil news portal full-online, gambar berita **hanya** di Cloudflare
R2. Aktivasi WAJIB lewat `applyNewsPortalFullOnlineR2Preset`
(`news-portal/application/apply-news-portal-preset.ts`), yang menegakkan
readiness gate di bawah sebelum menjalankan `applyModulePreset` generik —
lihat `.claude/skills/awcms-mini-news-portal/SKILL.md` §632 untuk keputusan
arsitektur lengkap (termasuk kenapa TIDAK ada var `DEPLOYMENT_PROFILE`/
`BLOG_PUBLIC_ROUTE_MODE`/`BLOG_PUBLIC_BASE_PATH` baru — dua yang terakhir
sudah ada sebagai konsep lain: `blog_content`'s per-tenant module setting
`publicRouteMode` dan `PUBLIC_CANONICAL_BASE_PATH` di atas).

| Var                                          | Wajib        | Default                                     | Sensitif | Fungsi                                                                                                                                                                                    |
| -------------------------------------------- | ------------ | ------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEWS_PORTAL_ENABLED`                        | –            | `false`                                     | –        | Master switch preset `news_portal_full_online_r2` itu sendiri                                                                                                                             |
| `NEWS_PORTAL_PROFILE`                        | bila enabled | –                                           | –        | Wajib `full_online_r2` (satu-satunya nilai valid hari ini)                                                                                                                                |
| `NEWS_MEDIA_R2_ENABLED`                      | –            | `false`                                     | –        | Master switch mode R2-only news media                                                                                                                                                     |
| `NEWS_MEDIA_R2_ACCOUNT_ID`                   | bila enabled | –                                           | –        | Boleh sama dengan `R2_ACCOUNT_ID` (satu akun Cloudflare) atau berbeda                                                                                                                     |
| `NEWS_MEDIA_R2_ACCESS_KEY_ID`                | bila enabled | –                                           | Ya       | WAJIB berbeda dari `R2_ACCESS_KEY_ID` — ditegakkan `config:validate`/`security:readiness`                                                                                                 |
| `NEWS_MEDIA_R2_SECRET_ACCESS_KEY`            | bila enabled | –                                           | Ya       | WAJIB berbeda dari `R2_SECRET_ACCESS_KEY` — ditegakkan `config:validate`/`security:readiness`                                                                                             |
| `NEWS_MEDIA_R2_BUCKET`                       | bila enabled | –                                           | –        | WAJIB berbeda dari `R2_BUCKET` — ditegakkan `config:validate`/`security:readiness`                                                                                                        |
| `NEWS_MEDIA_R2_PUBLIC_BASE_URL`              | bila enabled | –                                           | –        | Custom domain publik (HTTPS absolut), mis. `https://media.contoh-berita.id`. Saat `APP_ENV=production`, WAJIB custom domain nyata — bukan `*.r2.dev`/`localhost`/`127.0.0.1` (Issue #635) |
| `NEWS_MEDIA_R2_PRESIGNED_UPLOAD_TTL_SECONDS` | –            | `300`                                       | –        | TTL presigned PUT upload (bukan TTL baca — baca selalu publik). Maksimum `3600` detik (Issue #635)                                                                                        |
| `NEWS_MEDIA_R2_MAX_UPLOAD_BYTES`             | –            | `10485760` (10 MiB)                         | –        | Batas ukuran per file                                                                                                                                                                     |
| `NEWS_MEDIA_R2_ALLOWED_MIME_TYPES`           | –            | `image/jpeg,image/png,image/webp,image/gif` | –        | Allow-list MIME — `image/svg+xml` sengaja tidak termasuk default (risiko XSS). Tipe di luar kelima tipe yang dikenal sniffer ditolak `config:validate` (Issue #635)                       |
| `NEWS_MEDIA_R2_PENDING_TTL_MINUTES`          | –            | `60`                                        | –        | Batas usia objek `pending_upload` sebelum dibersihkan lifecycle job (belum ada — dilaporkan warning oleh `security:readiness` bila terlampaui, Issue #635)                                |

`bun run config:validate` (`checkNewsPortalProfileConfig`,
`checkNewsMediaR2Config`, `checkNewsMediaR2SeparationFromSyncR2`,
`checkNewsMediaR2AllowedMimeTypesKnown`,
`checkNewsMediaR2PresignedTtlUpperBound` — dua terakhir Issue #635) menolak
boot bila `NEWS_PORTAL_PROFILE` bukan nilai yang dikenal, bila
`NEWS_MEDIA_R2_ENABLED=true` tapi var wajib di atas hilang, bila
`NEWS_MEDIA_R2_BUCKET`/`_ACCESS_KEY_ID`/`_SECRET_ACCESS_KEY` sama persis
dengan `R2_BUCKET`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` milik
sync-storage (Issue #631 architecture doc §2), bila allow-list MIME berisi
tipe di luar yang dikenal sniffer, ATAU bila TTL presigned upload melebihi
3600 detik. `bun run security:readiness`
(`checkNewsPortalFullOnlineR2PresetReady`, critical;
`checkNewsMediaR2SvgNotAllowed`, warning;
`checkNewsMediaR2PublicBaseUrlProductionSafe`, critical — Issue #635;
`checkNewsMediaR2NoStalePendingObjects`, warning — Issue #635) menilai
kombinasi penuh syarat aktivasi preset, memperingatkan bila allow-list MIME
di-override untuk mengizinkan `image/svg+xml`, menolak (critical) URL
publik `*.r2.dev`/loopback saat `APP_ENV=production`, dan memperingatkan
bila ada objek `pending_upload` yang sudah lewat TTL di tabel registry
(lintas semua tenant).

Tidak ada var `FILE_STORAGE_DRIVER`/`LOCAL_FILE_UPLOADS_ENABLED`/
`LOCAL_MEDIA_STORAGE_ENABLED` di sini — mode ini secara struktural tidak
punya opsi fallback filesystem lokal untuk gambar berita sama sekali
(bukan flag yang di-set `false`, karena tidak ada kode jalur upload
lokal untuk media berita yang perlu dimatikan — lihat
`tests/unit/news-portal-no-local-fallback.test.ts` dan architecture doc
§3.3-3.4).

### Provider CRM (opsional) — contoh domain retail/POS

| Var                    | Wajib      | Default | Sensitif | Fungsi             |
| ---------------------- | ---------- | ------- | -------- | ------------------ |
| `STARSENDER_ENABLED`   | –          | `false` | –        | WhatsApp receipt   |
| `STARSENDER_API_KEY`   | bila aktif | –       | Ya       | API key StarSender |
| `MAILKETING_ENABLED`   | –          | `false` | –        | Email receipt      |
| `MAILKETING_API_TOKEN` | bila aktif | –       | Ya       | Token Mailketing   |

### AI analyst (opsional)

| Var                   | Wajib      | Default | Sensitif | Fungsi              |
| --------------------- | ---------- | ------- | -------- | ------------------- |
| `AI_ANALYST_ENABLED`  | –          | `false` | –        | Aktifkan AI analyst |
| `AI_PROVIDER_API_KEY` | bila aktif | –       | Ya       | Kredensial AI       |
| `AI_MODEL`            | –          | –       | –        | Model yang dipakai  |

## Feature flag

```mermaid
flowchart LR
  Boot[Boot] --> Val[Validasi env]
  Val --> Flags{Feature flags}
  Flags -->|R2 off| L[Storage lokal]
  Flags -->|EMAIL_ENABLED off| Q0[Email module - outbox menunggu, dispatcher tidak jalan]
  Flags -->|StarSender off| Q1[WA masuk queue - tak terkirim]
  Flags -->|Mailketing off| Q2[Email masuk queue - tak terkirim]
  Flags -->|AI off| NoAi[Endpoint AI nonaktif]
  Flags -->|Sync off| LanOnly[LAN-only]
  Flags -->|PUBLIC_TENANT_RESOLUTION_MODE unset| LegacyBlog[Legacy blog per-tenantCode route]
```

Aturan: fitur off tidak menghentikan POS; pesan/objek tetap masuk queue dan menunggu fitur diaktifkan. `EMAIL_ENABLED off` (base, Issue #493) dan `Mailketing off` (contoh domain retail/POS §Provider CRM) sama-sama "queue menunggu", tapi keduanya jalur terpisah — base tidak mengasumsikan use case "email receipt".

## `.env.example` lengkap (rekomendasi)

```env
# Inti
APP_ENV=development
APP_URL=http://localhost:4321
APP_TIMEZONE=Asia/Jakarta
APP_DEFAULT_LOCALE=id
LOG_LEVEL=info
AUDIT_LOG_RETENTION_DAYS=730
FORM_DRAFT_RETENTION_DAYS=30

# Database
DATABASE_URL=postgres://awcms-mini:awcms_mini_password@localhost:5432/awcms-mini
DATABASE_POOL_MAX=20
DATABASE_STATEMENT_TIMEOUT_MS=15000
DATABASE_PGBOUNCER=false

# Auth
AUTH_JWT_SECRET=change-me-in-production
AUTH_SESSION_TTL_MIN=120
AUTH_COOKIE_SECURE=true
AUTH_LOGIN_MAX_ATTEMPTS=5
AUTH_LOGIN_RATE_LIMIT_MAX=20
AUTH_LOGIN_RATE_LIMIT_WINDOW_SEC=60
AUTH_PASSWORD_RESET_TOKEN_TTL_MIN=30
AUTH_PASSWORD_RESET_RATE_LIMIT_MAX=5
AUTH_PASSWORD_RESET_RATE_LIMIT_WINDOW_SEC=900
AUTH_ONLINE_SECURITY_ENABLED=false
AUTH_ONLINE_SECURITY_PROFILE=disabled
TURNSTILE_ENABLED=false
TURNSTILE_VERIFY_TIMEOUT_MS=5000
AUTH_MFA_ENABLED=false
AUTH_MFA_TOTP_ISSUER=AWCMS-Mini
AUTH_MFA_TOTP_PERIOD_SEC=30
AUTH_MFA_TOTP_DIGITS=6
AUTH_MFA_CHALLENGE_TTL_SEC=300
AUTH_MFA_RATE_LIMIT_MAX=5
AUTH_MFA_RATE_LIMIT_WINDOW_SEC=300
AUTH_GOOGLE_LOGIN_ENABLED=false
AUTH_GOOGLE_REDIRECT_PATH=/api/v1/auth/providers/google/callback
AUTH_SSO_ENABLED=false
AUTH_SSO_DISCOVERY_TIMEOUT_MS=5000
AUTH_SSO_MAX_PROVIDERS_PER_TENANT=20

# Sync
AWCMS_MINI_NODE_ID=local-dev-node
AWCMS_MINI_SYNC_ENABLED=false
AWCMS_MINI_SYNC_HMAC_SECRET=change-me
AWCMS_MINI_SYNC_MAX_SKEW_SEC=300

# Storage
STORAGE_DRIVER=local
LOCAL_STORAGE_PATH=./storage
OBJECT_SYNC_UPLOAD_TIMEOUT_MS=10000
R2_ENABLED=false

# Email (base, Issue #493) — lihat src/modules/email/README.md
EMAIL_ENABLED=false
EMAIL_FROM_NAME=AWCMS-Mini
EMAIL_SEND_TIMEOUT_MS=10000
EMAIL_SEND_MAX_RETRIES=5

# Public tenant routing (opsional, online-first, config-only — Issue #556,
# epic #555). PUBLIC_TENANT_RESOLUTION_MODE tidak di-set = legacy
# /blog/{tenantCode}, offline/LAN tetap default.
PUBLIC_CANONICAL_BASE_PATH=/news
PUBLIC_TRUST_PROXY=false

# Visitor analytics (opsional, privacy-first — Issue #617, epic: visitor
# analytics #617-#624). Tidak di-set sama sekali = default aman di atas.
VISITOR_ANALYTICS_ENABLED=true
VISITOR_ANALYTICS_MODE=basic
VISITOR_ANALYTICS_RAW_IP_ENABLED=false
VISITOR_ANALYTICS_RAW_USER_AGENT_ENABLED=false
VISITOR_ANALYTICS_GEO_ENABLED=false

# News portal — full-online R2-only preset (opsional — Issue #632, epic
# `news_portal`). Tidak di-set sama sekali = preset tidak aktif.
NEWS_PORTAL_ENABLED=false
NEWS_MEDIA_R2_ENABLED=false

# Provider opsional (default off) — contoh domain retail/POS
STARSENDER_ENABLED=false
MAILKETING_ENABLED=false
AI_ANALYST_ENABLED=false
```

## Profil per-environment

| Environment         | Karakteristik                                                                     |
| ------------------- | --------------------------------------------------------------------------------- |
| development         | Semua provider off, DB lokal, cookie tidak secure                                 |
| staging             | Meniru prod, data uji, backup aktif                                               |
| production (online) | HTTPS, secret manager, backup+restore teruji, sync opsional                       |
| **offline/LAN**     | Tanpa internet; sync/R2/WA/email off atau tertunda; POS penuh jalan; backup lokal |

## Topologi deployment LAN-first

```mermaid
flowchart TB
  subgraph LAN["Toko / LAN"]
    P1[Aplikasi Operasional 1]
    P2[Aplikasi Operasional 2]
    A1[Admin]
    Srv[AWCMS-Mini - Bun/Astro]
    DB[(PostgreSQL)]
    Bak[Backup lokal]
    Srv --- DB
    Srv --- Bak
    P1 --- Srv
    P2 --- Srv
    A1 --- Srv
  end
  Srv -. saat online .-> Cloud[(Server pusat / R2 / provider)]
```

- Satu server LAN menjalankan aplikasi + PostgreSQL; klien via jaringan lokal.
- Provider eksternal & sync hanya saat online; POS tidak bergantung padanya.
- Deployment: `deploy/systemd`, `deploy/nginx`, `deploy/pgbouncer`, `deploy/backup` (doc 11).

## Validasi konfigurasi saat boot

- Var wajib hilang → gagal start dengan pesan jelas (tanpa membocorkan nilai).
- Flag aktif tanpa kredensial (mis. `R2_ENABLED=true` tanpa key) → gagal start.
- `PUBLIC_TENANT_RESOLUTION_MODE` diisi nilai selain 4 mode terdokumentasi,
  `host_default` tanpa `PUBLIC_PLATFORM_ROOT_DOMAIN`, `env_default` tanpa
  `PUBLIC_DEFAULT_TENANT_ID`/`PUBLIC_DEFAULT_TENANT_CODE`, atau
  `PUBLIC_CANONICAL_BASE_PATH` bukan absolute path → gagal start (Issue #556;
  lihat §Public routing di atas). Var ini tidak di-set sama sekali tetap
  lulus (perilaku legacy offline/LAN tidak berubah).
- `VISITOR_ANALYTICS_MODE` diisi nilai selain `basic`/`detailed`, atau
  salah satu dari empat var retensi/jendela (`VISITOR_ANALYTICS_ONLINE_WINDOW_SECONDS`/
  `_EVENT_RETENTION_DAYS`/`_RAW_DETAIL_RETENTION_DAYS`/`_ROLLUP_RETENTION_DAYS`)
  diisi nilai bukan integer positif → gagal start (Issue #617; lihat
  §Visitor analytics di atas). Semua var ini tidak di-set sama sekali
  tetap lulus dengan default privacy-first.
- Secret tidak pernah masuk log (redaction, doc 10).

## Acceptance criteria

- Boot memvalidasi env; var wajib hilang menghentikan start dengan pesan aman.
- Provider off tidak menghentikan POS; pesan/objek masuk queue.
- Secret hanya dari env; tidak ada di kode/commit/log/response.
- Preferensi tenant (locale/theme) dari `awcms_mini_tenants`, bukan hardcode.
- Profil offline/LAN berjalan penuh tanpa internet.
