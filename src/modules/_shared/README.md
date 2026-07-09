# Shared Module Foundation

Folder ini berisi kontrak lintas-modul yang boleh dipakai semua modul AWCMS-Mini.

## Module Contract

Setiap modul wajib mendeklarasikan `ModuleDescriptor` dari `module-contract.ts`, lalu mendaftarkannya lewat `src/modules/index.ts`.

## API Response

Endpoint REST memakai helper dari `api-response.ts` agar response konsisten:

- sukses: `{ success: true, data, meta }`
- gagal: `{ success: false, error: { code, message, details? }, meta }`

## Idempotency Store

`idempotency.ts` backs `awcms_mini_idempotency_keys` (migration 012) for every high-risk mutation endpoint that requires `Idempotency-Key` (doc 10, skill `awcms-mini-idempotency`). `saveIdempotencyRecord` uses `INSERT ... ON CONFLICT (tenant_id, request_scope, idempotency_key) DO NOTHING RETURNING id` and throws `IdempotencyRaceLostError` when a concurrent request already claimed the same key — two parallel requests can both pass `findIdempotencyRecord` under READ COMMITTED before either commits, and only one may win the unique index. `withTenant` (`src/lib/database/tenant-context.ts`) catches this error at the one chokepoint every caller already goes through: it rolls back the loser's transaction (so its mutation never persists) and returns a clean `409 IDEMPOTENCY_CONFLICT` instead of a raw constraint error, without touching the ~25 individual route files.

## Soft Delete Convention

Resource master/config/draft yang bisa dihapus wajib memakai kolom:

- `deleted_at`
- `deleted_by`
- `delete_reason`

Query list/detail default harus menyaring `deleted_at IS NULL`. Akses arsip, restore, dan purge harus memakai permission eksplisit dan audit log. Helper awal tersedia di `soft-delete.ts`; repository spesifik modul tetap wajib memakai query terparametrisasi dan RLS sesuai doc 10/16.
