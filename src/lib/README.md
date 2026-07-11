# Shared Runtime Library

Folder `src/lib/` berisi helper lintas-modul (base generik selesai, v0.23.5 — folder ini sudah terimplementasi, bukan lagi placeholder):

- `auth/` — sesi/token, `ssr-session.ts`, password hashing.
- `config/` — `registry.ts`: registry TypeScript terstruktur untuk setiap environment variable (type/required/owner/sensitivity/profiles/default/deprecation), sumber kebenaran bagi `scripts/validate-env.ts`, `.env.example`, dan doc 18 (Issue #689; skill terkait: `awcms-mini-production-preflight`, `awcms-mini-deploy`).
- `database/` — `client.ts`, `tenant-context.ts` (`withTenant`), `work-class.ts`, `circuit-breaker.ts` (registry per-provider, Issue #436).
- `errors/` — tipe/utilitas error.
- `files/` — helper file/storage lokal.
- `i18n/` — parser `.po`, catalog loader, `createTranslator`/`t()`, formatter locale-aware (Issue #433; skill `awcms-mini-i18n`).
- `integration/` — `timeout.ts` (`withTimeout` untuk panggilan keluar, Issue #436; skill `awcms-mini-integration`).
- `logging/` — `logger.ts` (JSON terstruktur + `setLogSink`), `correlation-response.ts` (propagasi `meta.correlationId`, Issue #447; skill `awcms-mini-observability`), `error-sanitizer.ts` (`sanitizeErrorForLog`/`safeErrorDetail` — redaksi pesan/`.stack`/rantai `.cause` sebuah exception sebelum di-log), `error-log.ts` (`logAdminPageError`/`logScriptFailure` — call-site helper untuk admin SSR page dan CLI worker, Issue #687).
- `security/` — `security-headers.ts`, `rate-limit.ts`, `theme-init-script.ts` (Issue #437; skill `awcms-mini-security-hardening`).
- `ui/` — `admin-form-client.ts` (`submitJson`/`showBanner`/`lockElement`, Issue #434).

Semua kode di folder ini wajib Bun-only, tidak menyimpan secret, dan mengikuti lapisan service/repository di doc 10 dan doc 16.

## `database/` (Issue 0.2, 10.2)

- `client.ts` — `getDatabaseClient()`, singleton `Bun.SQL` dari `DATABASE_URL`, dengan pool config (`max`, `prepare`, `connection.statement_timeout`) dari Issue 10.2.
- `tenant-context.ts` — `withTenant()`, transaction tenant-scoped (`SET LOCAL app.current_tenant_id`) yang sejak Issue 10.2 juga menerapkan work-class concurrency gate + circuit breaker (lihat `docs/awcms-mini/database-pooling.md`).
- `work-class.ts` — semaphore aplikasi per work class (`critical_transaction`/`interactive`/`reporting`/`background_sync`/`maintenance`), Issue 10.2.
- `circuit-breaker.ts` — circuit breaker 3-state (closed/open/half_open), Issue 10.2.

Dokumen lengkap: `docs/awcms-mini/database-migrations.md` (migration runner) dan `docs/awcms-mini/database-pooling.md` (pooling/backpressure).
