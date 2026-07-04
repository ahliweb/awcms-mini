# Modul Localization UI (`localization_ui`)

i18n (id/en/ms/ar), kamus terjemahan, preferensi locale/theme per tenant.

> **Status: skeleton (experimental).** Belum production-ready — lihat TODO di bawah.
> Struktur wajib: `module.ts`, `domain/`, `application/`, `infrastructure/`, `api/` (doc 10).

## Endpoint (kontrak doc 05, base path `/api/v1`)

- (belum ada — ditentukan saat implementasi)

## Tabel yang dimiliki

- `awcms_i18n_entries (rencana)`
- `awcms_theme_preferences (rencana)`

## Aturan wajib

- Route tipis -> ABAC guard -> validasi -> service -> repository (doc 10).
- Data tenant-scoped: tenant context + filter `tenant_id` + RLS (doc 16).
- High-risk action: audit + (bila mutation) Idempotency-Key.
- Data sensitif dimask/redact sebelum keluar (mapper safe DTO).

## TODO implementasi

- [ ] Schema i18n + theme (migration baru saat diimplementasi)
- [ ] Loader kamus + fallback chain locale
