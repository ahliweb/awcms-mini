# Modul Database Connectivity (`database_connectivity`)

Pooling work-class, antrean + backpressure, circuit breaker, PgBouncer profile, pool health.

> **Status: skeleton (experimental).** Belum production-ready — lihat TODO di bawah.
> Struktur wajib: `module.ts`, `domain/`, `application/`, `infrastructure/`, `api/` (doc 10).

## Endpoint (kontrak doc 05, base path `/api/v1`)

- `GET /api/v1/database/pool/health`

## Tabel yang dimiliki

- (tidak memiliki tabel sendiri)

## Aturan wajib

- Route tipis -> ABAC guard -> validasi -> service -> repository (doc 10).
- Data tenant-scoped: tenant context + filter `tenant_id` + RLS (doc 16).
- High-risk action: audit + (bila mutation) Idempotency-Key.
- Data sensitif dimask/redact sebelum keluar (mapper safe DTO).

## TODO implementasi

- [ ] Pool gate per work class (critical/interactive/reporting/background/maintenance)
- [ ] 503 DATABASE_BUSY saat antrean timeout + event database.pool.saturated
