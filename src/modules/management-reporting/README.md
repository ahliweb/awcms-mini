# Modul Management Reporting (`management_reporting`)

Dashboard dan laporan read-only berbasis view/materialized view per modul domain.

> **Status: skeleton (experimental).** Belum production-ready — lihat TODO di bawah.
> Struktur wajib: `module.ts`, `domain/`, `application/`, `infrastructure/`, `api/` (doc 10).

## Endpoint (kontrak doc 05, base path `/api/v1`)

- (belum ada — ditentukan saat implementasi)

## Tabel yang dimiliki

- `report views (per aplikasi domain)`

## Aturan wajib

- Route tipis -> ABAC guard -> validasi -> service -> repository (doc 10).
- Data tenant-scoped: tenant context + filter `tenant_id` + RLS (doc 16).
- High-risk action: audit + (bila mutation) Idempotency-Key.
- Data sensitif dimask/redact sebelum keluar (mapper safe DTO).

## TODO implementasi

- [ ] Kontrak query laporan read-only + pagination keyset
