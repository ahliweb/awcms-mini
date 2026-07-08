# Production Security Readiness

Dokumen ini mencatat implementasi Issue 10.3 (doc 07 §Production readiness
checklist, doc 03, doc 16, doc 20 threat model, ADR-0003 RLS, ADR-0004
RBAC/ABAC default-deny, ADR-0005 soft delete/immutability, dan skill
`awcms-mini-production-preflight`).

## Ringkasan

```mermaid
flowchart LR
  Pre[bun run production:preflight] --> Cfg[config:validate]
  Cfg --> Mig[db:migrate]
  Mig --> Spec[api:spec:check]
  Spec --> Test[bun test]
  Test --> Build[build]
  Build --> Probe{Server reachable?}
  Probe -->|ya| Pool[db:pool:health]
  Probe -->|tidak| Skip[skip - dicatat, bukan gagal]
  Pool --> Sec[security:readiness]
  Skip --> Sec
  Sec --> Gate{Critical finding?}
  Gate -->|ya| Block[GO-LIVE DIBLOKIR]
  Gate -->|tidak| Ready[GO-LIVE DIIZINKAN]
```

`config:validate` (Issue 12.2) jalan **paling pertama** — config harus
valid sebelum tahap manapun mencoba konek database atau menjalankan
migration (`scripts/production-preflight.ts`'s `STAGES` array).

Tiga skrip baru menjadi deliverable inti issue ini:

| Perintah                       | Skrip                             | Fungsi                                                                        |
| ------------------------------ | --------------------------------- | ----------------------------------------------------------------------------- |
| `bun run db:pool:health`       | `scripts/db-pool-health.ts`       | CLI wrapper `GET /api/v1/database/pool/health` (Issue 10.2)                   |
| `bun run security:readiness`   | `scripts/security-readiness.ts`   | Menjalankan checklist keamanan otomatis, exit non-zero bila ada critical fail |
| `bun run production:preflight` | `scripts/production-preflight.ts` | Orkestrasi seluruh tahap preflight + verdict go/no-go akhir                   |

Ketiganya murni CLI/script — **tidak ada perubahan OpenAPI/AsyncAPI** pada
issue ini (tidak ada endpoint atau event baru).

## 1. `db:pool:health`

Memanggil endpoint `GET /api/v1/database/pool/health` (Issue 10.2,
`src/pages/api/v1/database/pool/health.ts`) dari base URL yang bisa
dikonfigurasi lewat env `APP_URL` (default `http://localhost:4321`, sama
seperti yang sudah ada di `.env.example`). Semantik exit code mengikuti
3-tier status endpoint tersebut:

- `"healthy"` atau `"degraded"` → exit `0` (degraded tetap dianggap lulus —
  hanya peringatan untuk diselidiki sebelum go-live, sesuai desain endpoint
  Issue 10.2 sendiri).
- `"unhealthy"` → exit non-zero (hard failure).
- Fetch gagal total (server belum jalan, connection refused) → **juga** hard
  failure dengan pesan error yang jelas — tidak pernah terlihat seperti lulus
  diam-diam.

## 2. `security:readiness`

Menjalankan daftar tetap check bernama, masing-masing menghasilkan:

```ts
{
  name: string;
  severity: "critical" | "warning" | "info";
  status: "pass" | "fail";
  evidence: string;
}
```

Exit non-zero bila **ada satu saja** check `critical` berstatus `fail` —
persis diagram gate skill `awcms-mini-production-preflight`.

### Pemetaan checklist doc 07 → status implementasi

| Item checklist doc 07                         | Status                                                                                                                                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No hardcoded secret                           | **Otomatis** (critical) — heuristik grep `src/`, `scripts/`, config file yang di-track git                                                                                                             |
| `.env` tidak dikomit                          | **Otomatis** (critical) — `git ls-files` tidak boleh memuat `.env`                                                                                                                                     |
| Password hash modern                          | **Otomatis** (critical) — memanggil `hashPassword()` sungguhan, memeriksa awalan `$argon2id$`                                                                                                          |
| Login lockout                                 | **Otomatis** (critical) — memanggil `evaluateLoginAttempt()` dengan skenario 5x gagal                                                                                                                  |
| RLS aktif                                     | **Otomatis** (critical) — query langsung `pg_class.relrowsecurity` per tabel `awcms_mini_%`                                                                                                            |
| ABAC aktif (default deny)                     | **Otomatis** (critical) — memanggil `evaluateAccess()` dengan permission kosong                                                                                                                        |
| Audit log aktif                               | **Otomatis** (critical) — `SELECT to_regclass('awcms_mini_audit_events')`                                                                                                                              |
| Soft delete/restore/purge audit aktif         | **Otomatis** (warning) — cek seed permission + grep `recordAuditEvent` di 3 endpoint profile                                                                                                           |
| Sync HMAC bila hybrid                         | **Otomatis** (warning/info) — cek env secret bukan placeholder `.env.example`, skip bila sync off                                                                                                      |
| Error tidak expose stack trace                | **Best-effort otomatis** (warning/info) — butuh server hidup; `info` bila tidak bisa dicek                                                                                                             |
| Restore/purge berizin dan diaudit             | Tercakup di baris "soft delete/restore/purge audit aktif" di atas (satu check gabungan)                                                                                                                |
| Tax data masking                              | **Out of scope** — lihat §Item di luar cakupan                                                                                                                                                         |
| CRM opt-out                                   | **Out of scope** — lihat §Item di luar cakupan                                                                                                                                                         |
| AI read-only                                  | **Out of scope** — lihat §Item di luar cakupan                                                                                                                                                         |
| PostgreSQL tidak public                       | **Manual** — lihat §Item di luar cakupan                                                                                                                                                               |
| Least-privilege DB user                       | **Otomatis sebagian** (critical, cakupan connection role — lihat "App DB connection role does not bypass RLS" di atas) + **manual** untuk provisioning grant/role menyeluruh                           |
| Backup aktif / restore tested                 | **Manual** (SOP + skrip sudah ada di `deploy/backup/{backup,restore}-postgres.sh` sejak Issue 12.2 — lihat skill `awcms-mini-production-preflight`)                                                    |
| PostgreSQL version sesuai target              | **Manual** — versi di-pin di `docker-compose.yml` (Issue 12.2, `postgres:18.4`), tidak diverifikasi ulang dari kode aplikasi                                                                           |
| Build pass / migration pass / API spec valid  | **Otomatis** — via `production:preflight` (bukan `security:readiness`), tahap `build`/`db:migrate`/`api:spec:check`                                                                                    |
| Setup wizard locked                           | Sudah diverifikasi live sejak Issue 12.1 (`awcms_mini_setup_state` singleton); tidak diulang sebagai check readiness terpisah di issue ini — di luar cakupan penambahan baru                           |
| Role default tersedia                         | Sudah diverifikasi live sejak Issue 12.1; tidak diulang sebagai check readiness terpisah                                                                                                               |
| Logging aktif                                 | Sudah ada sejak Issue 10.1 (`src/lib/logging/logger.ts`); tidak diulang sebagai check terpisah                                                                                                         |
| Index utama / partial index soft delete       | Diverifikasi lewat test migration per issue (lihat `tests/*.test.ts` masing-masing); tidak diulang sebagai check runtime terpisah di sini                                                              |
| Pool sehat / slow query monitoring            | **Otomatis** via `db:pool:health` (pool); slow query monitoring di luar cakupan base ini (butuh `pg_stat_statements`/APM eksternal — deployment concern)                                               |
| Security response headers (CSP/HSTS/dst.)     | **Diperbarui Issue #437** (warning) — hit server nyata, cek `content-security-policy`/`x-content-type-options`/`x-frame-options`/`referrer-policy`/`permissions-policy` di respons `GET /login`        |
| Login rate limiting (sumber+tenant)           | **Diperbarui Issue #437** (warning) — `checkRateLimit()` murni, menegaskan percobaan ke-4 ditolak setelah `maxAttempts=3`                                                                              |
| Email provider config lengkap bila diaktifkan | **Ditambahkan Issue #499** (critical) — `checkEmailProviderConfigReady` menggunakan ulang `checkEmailConfig` (`validate-env.ts`, Issue #493) verbatim; skip (pass) bila `EMAIL_ENABLED` bukan `"true"` |

### Item di luar cakupan generic base ini

Dicetak eksplisit di laporan `security:readiness` sebagai bagian "Out of
scope for this generic base" — **tidak** disembunyikan atau dipaksakan jadi
check palsu:

| Item                      | Alasan                                                                                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tax data masking          | Tidak ada modul pajak/Coretax di base generik ini — concern domain aplikasi turunan (mis. AWPOS).                                                                                                                                          |
| CRM opt-out               | Tidak ada modul CRM di base generik ini — concern domain aplikasi turunan.                                                                                                                                                                 |
| AI read-only              | Tidak ada modul AI analyst/tool-calling di base generik ini — concern domain aplikasi turunan.                                                                                                                                             |
| PostgreSQL tidak public   | Concern deployment profile — `docker-compose.yml`/`deployment-profiles.md` ada sejak Issue 12.2, tapi eksposur jaringan nyata bergantung konfigurasi operator saat deploy, tidak bisa diverifikasi dari kode aplikasi saja. Manual.        |
| Least-privilege DB user   | Role/grant DB diprovisi saat deploy. Connection role aplikasi sendiri (bukan superuser/bypass-RLS) sudah diverifikasi otomatis (lihat check di atas); grant/role lain tetap manual.                                                        |
| Backup/restore tested     | Skrip `deploy/backup/{backup,restore}-postgres.sh` sudah ada sejak Issue 12.2 — butuh dijalankan sungguhan terhadap environment terprovisi untuk membuktikan hasil restore (lihat SOP di skill `awcms-mini-production-preflight`). Manual. |
| PostgreSQL version pinned | Version pin ada di `docker-compose.yml` (`postgres:18.4`) sejak Issue 12.2, bukan diverifikasi dari kode aplikasi. Manual — konfirmasi versi server nyata (`SELECT version();`).                                                           |

## 3. `production:preflight`

Mengorkestrasi tahap berikut sebagai child process (`Bun.spawn`), berurutan,
mencatat pass/fail per tahap, lalu mencetak verdict akhir:

1. `bun run config:validate` — **paling pertama** (Issue 12.2): config
   harus valid sebelum tahap manapun mencoba konek database atau
   menjalankan migration.
2. `bun run db:migrate`
3. `bun run api:spec:check`
4. `bun test`
5. `bun run build`
6. `bun run db:pool:health` — **hanya bila** probe `GET /api/v1/health`
   menunjukkan ada server yang menjawab; bila tidak, tahap ini dicatat
   `skipped` (bukan `failed`) dengan alasan eksplisit di laporan. Ini
   keputusan desain yang disengaja: `production:preflight` bisa dijalankan
   di CI/lingkungan tanpa server berjalan tanpa memblokir seluruh preflight
   pada satu tahap yang memang butuh server hidup.
7. `bun run security:readiness`

`bun install` **sengaja tidak** dijalankan oleh skrip ini — itu langkah
setup environment (mengambil dependency), bukan readiness check, dan di luar
tanggung jawab skrip ini (skill `awcms-mini-production-preflight` mencantumkannya
sebagai langkah terpisah sebelum command list preflight).

Semua tahap tetap dijalankan meskipun tahap sebelumnya gagal (bukan
fail-fast) — laporan akhir mendaftar **seluruh** tahap yang gagal, bukan
hanya yang pertama, supaya satu kegagalan tidak menyembunyikan masalah lain.

Verdict akhir: `GO-LIVE DIIZINKAN` (exit 0) jika tidak ada tahap `fail`,
`GO-LIVE DIBLOKIR` (exit non-zero) jika ada.

## Cara menjalankan sebelum go-live

```bash
bun install
bun run config:validate
bun run db:migrate
bun run api:spec:check
bun test
bun run build
bun run preview &            # atau `bun run dev` — perlu server hidup untuk db:pool:health
bun run db:pool:health
bun run security:readiness
bun run production:preflight
```

Atau cukup `bun run production:preflight` setelah server (opsional) sudah
hidup — skrip ini menjalankan seluruh tahap di atas kecuali `bun install`.

## Test

`tests/security-readiness.test.ts` menutup logika murni yang tidak butuh
koneksi DB/server sungguhan: heuristik `scanLineForHardcodedSecret`
(termasuk kasus negatif — placeholder, member-expression, baca dari
`process.env`), `checkAbacDefaultDeny`, `checkLoginLockoutImplemented`, dan
`checkSyncHmacSecretNotDefault` (ketiga cabang: sync off, sync on dengan
placeholder, sync on dengan secret asli).

Check yang butuh Postgres sungguhan (`checkRlsEnabled`,
`checkAuditLogTableReachable`, sebagian `checkSoftDeletePermissionsSeededAndAudited`)
**tidak** di-unit-test dengan DB palsu — itu akan menguji mock, bukan query
sungguhan. Pembuktiannya ada di verifikasi live (lihat
`docs/awcms-mini/AUDIT_STANDAR_PENGEMBANGAN_2026-07-04.md` entri Issue 10.3),
termasuk skenario RLS sengaja dimatikan untuk membuktikan gate benar-benar
memblokir, bukan sekadar skrip yang selalu mencetak "pass".

## Gap yang belum ditutup

- Slow query monitoring (`pg_stat_statements`/APM) tidak diverifikasi
  otomatis — butuh tooling observability eksternal di luar cakupan base ini.
- `checkErrorsDontLeakStackTraces` best-effort: hanya menguji satu bentuk
  request (POST `/sync/push` tanpa header HMAC) terhadap satu daftar
  substring stack-trace yang umum; bukan jaminan menyeluruh seluruh endpoint.
- Item deployment (PostgreSQL tidak public, least-privilege user menyeluruh,
  backup/restore, version pinned) tetap verifikasi **manual** terhadap
  environment terprovisi — `docker-compose.yml`/deployment profile/skrip
  backup sudah ada sejak Issue 12.2, tapi eksposur jaringan nyata, hasil
  restore, dan versi server yang benar-benar berjalan tidak bisa dibuktikan
  dari kode aplikasi saja.
- Security headers (Issue #437) hanya dicek **kehadirannya** (nama header
  ada di respons), bukan validitas isi CSP secara mendalam — lihat
  `docs/awcms-mini/20_threat_model_security_architecture.md` §Matrix
  kepatuhan untuk verifikasi CSP yang lebih lengkap (headless-Chrome/CDP).
- Rate limiter login (Issue #437) in-memory per-proses, tidak dibagi antar
  instance pada deployment multi-instance — lihat
  `src/lib/security/rate-limit.ts` untuk detail keterbatasan ini.
- Email observability/security/incident-response detail (Issue #499:
  structured log per tahap, audit event, `GET /reports/email-health`,
  catatan insiden provider outage/rotasi kredensial/accidental bulk send)
  didokumentasikan di `src/modules/email/README.md` §Observability,
  security tests, and production readiness — tidak diduplikasi di sini.
