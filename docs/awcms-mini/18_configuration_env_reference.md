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

### Inti aplikasi

| Var                         | Wajib | Default                 | Sensitif | Fungsi                                                                                                                                                                        |
| --------------------------- | ----- | ----------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_ENV`                   | Ya    | `development`           | –        | development/staging/production                                                                                                                                                |
| `APP_URL`                   | Ya    | `http://localhost:4321` | –        | Base URL aplikasi                                                                                                                                                             |
| `APP_TIMEZONE`              | Ya    | `Asia/Jakarta`          | –        | Timezone default                                                                                                                                                              |
| `APP_DEFAULT_LOCALE`        | –     | `id`                    | –        | Locale default                                                                                                                                                                |
| `LOG_LEVEL`                 | –     | `info`                  | –        | debug/info/warn/error                                                                                                                                                         |
| `AUDIT_LOG_RETENTION_DAYS`  | –     | `730`                   | –        | Retensi `awcms_mini_audit_events` (hari) dipakai `bun run logs:audit:purge` (Issue #447; doc 04 §Retention awal)                                                              |
| `FORM_DRAFT_RETENTION_DAYS` | –     | `30`                    | –        | Retensi `awcms_mini_form_drafts` `expired`/`abandoned` (hari) dipakai `bun run form-drafts:purge` (Issue #484; `--retention-days=<n>` CLI flag override lebih diprioritaskan) |

### Database & pool

| Var                             | Wajib | Default | Sensitif | Fungsi                       |
| ------------------------------- | ----- | ------- | -------- | ---------------------------- |
| `DATABASE_URL`                  | Ya    | –       | Ya       | Koneksi PostgreSQL           |
| `DATABASE_POOL_MAX`             | –     | `20`    | –        | Maks koneksi pool            |
| `DATABASE_STATEMENT_TIMEOUT_MS` | –     | `15000` | –        | Timeout statement            |
| `DATABASE_PGBOUNCER`            | –     | `false` | –        | Mode PgBouncer (transaction) |

### Auth & keamanan

| Var                                         | Wajib | Default | Sensitif | Fungsi                                          |
| ------------------------------------------- | ----- | ------- | -------- | ----------------------------------------------- |
| `AUTH_JWT_SECRET`                           | Ya    | –       | Ya       | Signing token sesi                              |
| `AUTH_SESSION_TTL_MIN`                      | –     | `120`   | –        | Umur sesi                                       |
| `AUTH_COOKIE_SECURE`                        | –     | `true`  | –        | Cookie hanya HTTPS di prod                      |
| `AUTH_LOGIN_MAX_ATTEMPTS`                   | –     | `5`     | –        | Lockout login (per identitas)                   |
| `AUTH_LOGIN_RATE_LIMIT_MAX`                 | –     | `20`    | –        | Rate limit login per sumber+tenant (Issue #437) |
| `AUTH_LOGIN_RATE_LIMIT_WINDOW_SEC`          | –     | `60`    | –        | Jendela waktu rate limit login (detik)          |
| `AUTH_PASSWORD_RESET_TOKEN_TTL_MIN`         | –     | `30`    | –        | Umur token reset password (Issue #496)          |
| `AUTH_PASSWORD_RESET_RATE_LIMIT_MAX`        | –     | `5`     | –        | Rate limit forgot/reset per sumber+tenant       |
| `AUTH_PASSWORD_RESET_RATE_LIMIT_WINDOW_SEC` | –     | `900`   | –        | Jendela waktu rate limit reset password (detik) |

### Sync & node

| Var                            | Wajib     | Default          | Sensitif | Fungsi                |
| ------------------------------ | --------- | ---------------- | -------- | --------------------- |
| `AWCMS_MINI_NODE_ID`           | Ya        | `local-dev-node` | –        | Identitas node        |
| `AWCMS_MINI_SYNC_ENABLED`      | –         | `false`          | –        | Aktifkan sync hybrid  |
| `AWCMS_MINI_SYNC_HMAC_SECRET`  | bila sync | –                | Ya       | Signature HMAC        |
| `AWCMS_MINI_SYNC_MAX_SKEW_SEC` | –         | `300`            | –        | Toleransi anti-replay |

### Storage

| Var                             | Wajib   | Default     | Sensitif | Fungsi                                                                  |
| ------------------------------- | ------- | ----------- | -------- | ----------------------------------------------------------------------- |
| `STORAGE_DRIVER`                | –       | `local`     | –        | local/r2                                                                |
| `LOCAL_STORAGE_PATH`            | –       | `./storage` | –        | Path file lokal                                                         |
| `R2_ENABLED`                    | –       | `false`     | –        | Aktifkan R2                                                             |
| `R2_ACCOUNT_ID`                 | bila R2 | –           | Ya       | Akun R2                                                                 |
| `R2_ACCESS_KEY_ID`              | bila R2 | –           | Ya       | Kredensial R2                                                           |
| `R2_SECRET_ACCESS_KEY`          | bila R2 | –           | Ya       | Kredensial R2                                                           |
| `R2_BUCKET`                     | bila R2 | –           | –        | Bucket                                                                  |
| `OBJECT_SYNC_UPLOAD_TIMEOUT_MS` | –       | `10000`     | –        | Timeout upload dispatcher (Issue #436, `bun run sync:objects:dispatch`) |

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

**Config-only.** Menyiapkan environment variable untuk mode public tenant
routing online, tanpa mengimplementasikan schema tenant-domain, rute publik
`/news`, atau resolver host-based — itu issue lanjutan #557-#567 di epic
yang sama. Default (semua var di bawah tidak di-set) tetap kompatibel
dengan deployment offline/LAN yang sudah ada: rute publik hanya lewat
`/blog/{tenantCode}` legacy, tanpa resolusi tenant dari host — **offline/LAN
tetap default, bukan online-first**. `scripts/validate-env.ts`
(`checkPublicRoutingConfig`) menegakkan tabel ini.

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

- `PUBLIC_TENANT_RESOLUTION_MODE` tidak di-set → **bukan error**; setara
  perilaku `tenant_code_legacy` hari ini, tidak ada var lain yang wajib.
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
host-based yang akan dibangun di Issue #559 memakainya untuk menentukan
tenant, dan spoofing header bisa mengarahkan request ke tenant yang salah
tanpa membocorkan keberadaan tenant lain (lihat epic #555 §Security notes).

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
- Secret tidak pernah masuk log (redaction, doc 10).

## Acceptance criteria

- Boot memvalidasi env; var wajib hilang menghentikan start dengan pesan aman.
- Provider off tidak menghentikan POS; pesan/objek masuk queue.
- Secret hanya dari env; tidak ada di kode/commit/log/response.
- Preferensi tenant (locale/theme) dari `awcms_mini_tenants`, bukan hardcode.
- Profil offline/LAN berjalan penuh tanpa internet.
