# Shared Runtime Library

Folder `src/lib/` disediakan untuk helper lintas-modul:

- `auth/`
- `database/`
- `errors/`
- `files/`
- `i18n/`
- `logging/`

Implementasi detail masuk issue berikutnya. Semua kode di folder ini wajib Bun-only, tidak menyimpan secret, dan mengikuti lapisan service/repository di doc 10 dan doc 16.

## `database/` (Issue 0.2, 10.2)

- `client.ts` — `getDatabaseClient()`, singleton `Bun.SQL` dari `DATABASE_URL`, dengan pool config (`max`, `prepare`, `connection.statement_timeout`) dari Issue 10.2.
- `tenant-context.ts` — `withTenant()`, transaction tenant-scoped (`SET LOCAL app.current_tenant_id`) yang sejak Issue 10.2 juga menerapkan work-class concurrency gate + circuit breaker (lihat `docs/awcms-mini/database-pooling.md`).
- `work-class.ts` — semaphore aplikasi per work class (`critical_transaction`/`interactive`/`reporting`/`background_sync`/`maintenance`), Issue 10.2.
- `circuit-breaker.ts` — circuit breaker 3-state (closed/open/half_open), Issue 10.2.

Dokumen lengkap: `docs/awcms-mini/database-migrations.md` (migration runner) dan `docs/awcms-mini/database-pooling.md` (pooling/backpressure).
