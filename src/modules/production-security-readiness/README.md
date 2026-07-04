# Modul Production Security Readiness (`production_security_readiness`)

Security control, readiness assessment, finding, go-live gates; critical finding memblokir go-live.

> **Status: skeleton (experimental).** Belum production-ready — lihat TODO di bawah.
> Struktur wajib: `module.ts`, `domain/`, `application/`, `infrastructure/`, `api/` (doc 10).

## Endpoint (kontrak doc 05, base path `/api/v1`)

- `POST /api/v1/security/go-live-gates/evaluate`

## Tabel yang dimiliki

- `awcms_security_controls (rencana)`
- `awcms_security_readiness_assessments (rencana)`
- `awcms_security_findings (rencana)`
- `awcms_go_live_gates (rencana)`

## Aturan wajib

- Route tipis -> ABAC guard -> validasi -> service -> repository (doc 10).
- Data tenant-scoped: tenant context + filter `tenant_id` + RLS (doc 16).
- High-risk action: audit + (bila mutation) Idempotency-Key.
- Data sensitif dimask/redact sebelum keluar (mapper safe DTO).

## TODO implementasi

- [ ] Schema readiness (migration baru) + evaluasi gate dari scripts/security-readiness.ts
