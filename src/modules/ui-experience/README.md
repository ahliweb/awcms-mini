# Modul UI Experience (`ui_experience`)

Admin shell, navigation registry per modul, design token (doc 14), theme light/dark/system.

> **Status: skeleton (experimental).** Belum production-ready — lihat TODO di bawah.
> Struktur wajib: `module.ts`, `domain/`, `application/`, `infrastructure/`, `api/` (doc 10).

## Endpoint (kontrak doc 05, base path `/api/v1`)

- (belum ada — ditentukan saat implementasi)

## Tabel yang dimiliki

- (tidak memiliki tabel sendiri)

## Aturan wajib

- Route tipis -> ABAC guard -> validasi -> service -> repository (doc 10).
- Data tenant-scoped: tenant context + filter `tenant_id` + RLS (doc 16).
- High-risk action: audit + (bila mutation) Idempotency-Key.
- Data sensitif dimask/redact sebelum keluar (mapper safe DTO).

## TODO implementasi

- [ ] Base layout + design tokens (doc 14)
- [ ] Navigation registry yang membaca module registry + permission
