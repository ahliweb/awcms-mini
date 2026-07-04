# Modul Observability Logging (`observability_logging`)

Log event, audit event, security event: penyimpanan tenant-scoped, redaction wajib, correlation ID.

> **Status: skeleton (experimental).** Belum production-ready — lihat TODO di bawah.
> Struktur wajib: `module.ts`, `domain/`, `application/`, `infrastructure/`, `api/` (doc 10).

## Endpoint (kontrak doc 05, base path `/api/v1`)

- `GET /api/v1/logs/recent`
- `GET /api/v1/logs/audit`
- `GET /api/v1/logs/security`

## Tabel yang dimiliki

- `awcms_log_events`
- `awcms_audit_events`
- `awcms_security_events`

## Aturan wajib

- Route tipis -> ABAC guard -> validasi -> service -> repository (doc 10).
- Data tenant-scoped: tenant context + filter `tenant_id` + RLS (doc 16).
- High-risk action: audit + (bila mutation) Idempotency-Key.
- Data sensitif dimask/redact sebelum keluar (mapper safe DTO).

## TODO implementasi

- [ ] Repository audit/log/security event (insert di dalam transaction mutation)
- [ ] API read-only dengan ABAC guard (role Auditor)
