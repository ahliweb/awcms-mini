# Modul Profile Identity (`profile_identity`)

Central profile untuk user/customer/supplier/contact: identifier ter-mask + hash lookup, resolver, entity link, merge request.

> **Status: skeleton (experimental).** Belum production-ready — lihat TODO di bawah.
> Struktur wajib: `module.ts`, `domain/`, `application/`, `infrastructure/`, `api/` (doc 10).

## Endpoint (kontrak doc 05, base path `/api/v1`)

- `GET|POST /api/v1/profiles`
- `GET /api/v1/profiles/{profileId}`
- `POST /api/v1/profiles/resolve`
- `POST /api/v1/profiles/{profileId}/links`
- `GET /api/v1/profiles/dedup-candidates`
- `POST /api/v1/profiles/merge-requests`

## Tabel yang dimiliki

- `awcms_profiles`
- `awcms_profile_identifiers`
- `awcms_profile_channels`
- `awcms_profile_addresses`
- `awcms_profile_entity_links`
- `awcms_profile_merge_requests`

## Aturan wajib

- Route tipis -> ABAC guard -> validasi -> service -> repository (doc 10).
- Data tenant-scoped: tenant context + filter `tenant_id` + RLS (doc 16).
- High-risk action: audit + (bila mutation) Idempotency-Key.
- Data sensitif dimask/redact sebelum keluar (mapper safe DTO).

## TODO implementasi

- [ ] Implement resolver idempotent (Idempotency-Key wajib)
- [ ] Normalisasi identifier -> value_hash (dedup) + masked_value (tampilan); nilai mentah tidak pernah keluar
