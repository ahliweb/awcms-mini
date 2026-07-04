# Modul Sync Storage (`sync_storage`)

Offline-first sync: node, outbox/inbox HMAC-signed, conflict manual, object queue R2 opsional.

> **Status: skeleton (experimental).** Belum production-ready — lihat TODO di bawah.
> Struktur wajib: `module.ts`, `domain/`, `application/`, `infrastructure/`, `api/` (doc 10).

## Endpoint (kontrak doc 05, base path `/api/v1`)

- `POST /api/v1/sync/push`
- `POST /api/v1/sync/pull`
- `GET /api/v1/sync/status`
- `GET /api/v1/sync/conflicts`
- `POST /api/v1/sync/conflicts/{id}/resolve`

## Tabel yang dimiliki

- `awcms_sync_nodes (rencana)`
- `awcms_sync_outbox (rencana)`
- `awcms_sync_inbox (rencana)`
- `awcms_sync_conflicts (rencana)`
- `awcms_object_sync_queue (rencana)`

## Aturan wajib

- Route tipis -> ABAC guard -> validasi -> service -> repository (doc 10).
- Data tenant-scoped: tenant context + filter `tenant_id` + RLS (doc 16).
- High-risk action: audit + (bila mutation) Idempotency-Key.
- Data sensitif dimask/redact sebelum keluar (mapper safe DTO).

## TODO implementasi

- [ ] Schema sync (migration baru saat diimplementasi)
- [ ] HMAC timestamp.body + anti-replay skew 300s (skill awcms-mini-sync-hmac)
