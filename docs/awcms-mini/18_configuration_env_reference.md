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

| Var                        | Wajib | Default                 | Sensitif | Fungsi                                                                                                           |
| -------------------------- | ----- | ----------------------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| `APP_ENV`                  | Ya    | `development`           | –        | development/staging/production                                                                                   |
| `APP_URL`                  | Ya    | `http://localhost:4321` | –        | Base URL aplikasi                                                                                                |
| `APP_TIMEZONE`             | Ya    | `Asia/Jakarta`          | –        | Timezone default                                                                                                 |
| `APP_DEFAULT_LOCALE`       | –     | `id`                    | –        | Locale default                                                                                                   |
| `LOG_LEVEL`                | –     | `info`                  | –        | debug/info/warn/error                                                                                            |
| `AUDIT_LOG_RETENTION_DAYS` | –     | `730`                   | –        | Retensi `awcms_mini_audit_events` (hari) dipakai `bun run logs:audit:purge` (Issue #447; doc 04 §Retention awal) |

### Database & pool

| Var                             | Wajib | Default | Sensitif | Fungsi                       |
| ------------------------------- | ----- | ------- | -------- | ---------------------------- |
| `DATABASE_URL`                  | Ya    | –       | Ya       | Koneksi PostgreSQL           |
| `DATABASE_POOL_MAX`             | –     | `20`    | –        | Maks koneksi pool            |
| `DATABASE_STATEMENT_TIMEOUT_MS` | –     | `15000` | –        | Timeout statement            |
| `DATABASE_PGBOUNCER`            | –     | `false` | –        | Mode PgBouncer (transaction) |

### Auth & keamanan

| Var                                | Wajib | Default | Sensitif | Fungsi                                          |
| ---------------------------------- | ----- | ------- | -------- | ----------------------------------------------- |
| `AUTH_JWT_SECRET`                  | Ya    | –       | Ya       | Signing token sesi                              |
| `AUTH_SESSION_TTL_MIN`             | –     | `120`   | –        | Umur sesi                                       |
| `AUTH_COOKIE_SECURE`               | –     | `true`  | –        | Cookie hanya HTTPS di prod                      |
| `AUTH_LOGIN_MAX_ATTEMPTS`          | –     | `5`     | –        | Lockout login (per identitas)                   |
| `AUTH_LOGIN_RATE_LIMIT_MAX`        | –     | `20`    | –        | Rate limit login per sumber+tenant (Issue #437) |
| `AUTH_LOGIN_RATE_LIMIT_WINDOW_SEC` | –     | `60`    | –        | Jendela waktu rate limit login (detik)          |

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

### Provider CRM (opsional)

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
  Flags -->|StarSender off| Q1[WA masuk queue - tak terkirim]
  Flags -->|Mailketing off| Q2[Email masuk queue - tak terkirim]
  Flags -->|AI off| NoAi[Endpoint AI nonaktif]
  Flags -->|Sync off| LanOnly[LAN-only]
```

Aturan: fitur off tidak menghentikan POS; pesan/objek tetap masuk queue dan menunggu fitur diaktifkan.

## `.env.example` lengkap (rekomendasi)

```env
# Inti
APP_ENV=development
APP_URL=http://localhost:4321
APP_TIMEZONE=Asia/Jakarta
APP_DEFAULT_LOCALE=id
LOG_LEVEL=info
AUDIT_LOG_RETENTION_DAYS=730

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

# Provider opsional (default off)
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
- Secret tidak pernah masuk log (redaction, doc 10).

## Acceptance criteria

- Boot memvalidasi env; var wajib hilang menghentikan start dengan pesan aman.
- Provider off tidak menghentikan POS; pesan/objek masuk queue.
- Secret hanya dari env; tidak ada di kode/commit/log/response.
- Preferensi tenant (locale/theme) dari `awcms_mini_tenants`, bukan hardcode.
- Profil offline/LAN berjalan penuh tanpa internet.
