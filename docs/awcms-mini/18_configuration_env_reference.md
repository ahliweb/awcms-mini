# Bagian 18 — Configuration dan Environment Reference

## Prinsip konfigurasi

1. Semua secret hanya dari **environment**; `.env` di-ignore, `.env.example` placeholder.
2. Provider eksternal **opsional** via feature flag; default off; fitur off tidak menghentikan aplikasi.
3. Konfigurasi tervalidasi saat boot (`src/lib/config.ts` — fail-fast, pesan hanya nama variabel).
4. Presedensi: default kode → environment → `awcms_tenant_settings` (preferensi tenant).

## Referensi environment variable

Diimplementasi dan divalidasi oleh `loadConfig()` (`tests/lib/config.test.ts`).

### Inti aplikasi

| Var                  | Wajib | Default                 | Sensitif | Fungsi                         |
| -------------------- | ----- | ----------------------- | -------- | ------------------------------ |
| `APP_ENV`            | –     | `development`           | –        | development/staging/production |
| `APP_URL`            | –     | `http://localhost:4321` | –        | Base URL                       |
| `APP_TIMEZONE`       | –     | `Asia/Jakarta`          | –        | Timezone default               |
| `APP_DEFAULT_LOCALE` | –     | `id`                    | –        | Locale default                 |
| `LOG_LEVEL`          | –     | `info`                  | –        | debug/info/warn/error          |

### Database & pool

| Var                             | Wajib  | Default | Sensitif | Fungsi                                       |
| ------------------------------- | ------ | ------- | -------- | -------------------------------------------- |
| `DATABASE_URL`                  | **Ya** | –       | Ya       | Koneksi PostgreSQL                           |
| `DATABASE_POOL_MAX`             | –      | `20`    | –        | Maks koneksi pool                            |
| `DATABASE_STATEMENT_TIMEOUT_MS` | –      | `15000` | –        | Timeout statement                            |
| `DATABASE_PGBOUNCER`            | –      | `false` | –        | Mode PgBouncer (matikan prepared statements) |

### Auth & keamanan

| Var                       | Wajib  | Default              | Sensitif | Fungsi                                                 |
| ------------------------- | ------ | -------------------- | -------- | ------------------------------------------------------ |
| `AUTH_JWT_SECRET`         | **Ya** | –                    | Ya       | Signing token sesi (placeholder ditolak di production) |
| `AUTH_SESSION_TTL_MIN`    | –      | `120`                | –        | Umur sesi                                              |
| `AUTH_COOKIE_SECURE`      | –      | `true` di production | –        | Cookie hanya HTTPS                                     |
| `AUTH_LOGIN_MAX_ATTEMPTS` | –      | `5`                  | –        | Lockout login                                          |

### Sync & node (opsional)

| Var                       | Wajib     | Default          | Sensitif | Fungsi                |
| ------------------------- | --------- | ---------------- | -------- | --------------------- |
| `AWCMS_NODE_ID`           | –         | `local-dev-node` | –        | Identitas node        |
| `AWCMS_SYNC_ENABLED`      | –         | `false`          | –        | Aktifkan sync         |
| `AWCMS_SYNC_HMAC_SECRET`  | bila sync | –                | Ya       | Signature HMAC        |
| `AWCMS_SYNC_MAX_SKEW_SEC` | –         | `300`            | –        | Toleransi anti-replay |

### Storage & provider (opsional, default off)

| Var                                                                                      | Wajib                          | Default     | Sensitif |
| ---------------------------------------------------------------------------------------- | ------------------------------ | ----------- | -------- |
| `STORAGE_DRIVER`                                                                         | –                              | `local`     | –        |
| `LOCAL_STORAGE_PATH`                                                                     | –                              | `./storage` | –        |
| `R2_ENABLED` (+`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`) | flag; kredensial wajib bila on | `false`     | Ya       |
| `STARSENDER_ENABLED` (+`STARSENDER_API_KEY`)                                             | idem                           | `false`     | Ya       |
| `MAILKETING_ENABLED` (+`MAILKETING_API_TOKEN`)                                           | idem                           | `false`     | Ya       |
| `AI_ANALYST_ENABLED` (+`AI_PROVIDER_API_KEY`, `AI_MODEL`)                                | idem                           | `false`     | Ya       |

**Flag aktif tanpa kredensial = gagal boot** (tervalidasi test).

## Profil per-environment

| Environment | Karakteristik                                                                  |
| ----------- | ------------------------------------------------------------------------------ |
| development | Provider off, DB lokal (docker compose), cookie tidak secure                   |
| staging     | Meniru production, data uji, backup aktif                                      |
| production  | HTTPS, secret manager, backup+restore teruji, role DB non-superuser            |
| offline/LAN | Tanpa internet; sync/provider off/tertunda; aplikasi penuh jalan; backup lokal |

## Topologi deployment LAN-first

Satu server LAN menjalankan aplikasi (Bun, `deploy/systemd`) + PostgreSQL; klien via jaringan lokal (reverse proxy `deploy/nginx`); PgBouncer opsional (`deploy/pgbouncer`); backup lokal (`deploy/backup`). Provider eksternal & sync hanya saat online.

## Validasi konfigurasi saat boot

- Var wajib hilang / flag tanpa kredensial → `ConfigError` berisi daftar masalah (nama var saja, tanpa nilai).
- Secret tidak pernah masuk log — redaction logger + pesan error aman.
