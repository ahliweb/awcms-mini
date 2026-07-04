# Modul Tenant Admin (`tenant_admin`)

Tenant, office/unit kerja, tenant settings, dan setup wizard aplikasi.

> **Status: skeleton (experimental).** Belum production-ready — lihat TODO di bawah.
> Struktur wajib: `module.ts`, `domain/`, `application/`, `infrastructure/`, `api/` (doc 10).

## Endpoint (kontrak doc 05, base path `/api/v1`)

- `GET /api/v1/setup/status`
- `POST /api/v1/setup/initialize`
- `GET /api/v1/tenants/current`
- `GET|POST /api/v1/offices`
- `PATCH /api/v1/offices/{officeId}`

## Tabel yang dimiliki

- `awcms_tenants`
- `awcms_offices`
- `awcms_tenant_settings`

## Aturan wajib

- Route tipis -> ABAC guard -> validasi -> service -> repository (doc 10).
- Data tenant-scoped: tenant context + filter `tenant_id` + RLS (doc 16).
- High-risk action: audit + (bila mutation) Idempotency-Key.
- Data sensitif dimask/redact sebelum keluar (mapper safe DTO).

## TODO implementasi

- [ ] Implement setup wizard idempotent + locked (doc 17)
- [ ] Implement office CRUD dengan ABAC guard + audit
