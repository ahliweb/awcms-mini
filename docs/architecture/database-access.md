# Database Access

## Purpose

This document defines the shared database access surface for services in AWCMS Mini.

## Source of Truth

- singleton access module: `src/db/index.mjs`
- postgres client factory: `src/db/client/postgres.mjs`
- transaction wrapper: `src/db/transactions.mjs`
- error classifier: `src/db/errors.mjs`

## Connection Pooler (ADR-013)

PostgreSQL diakses via **connection pooler open-source** (Supavisor/PgBouncer/PgCat). Lihat personal-coding `awcms-shared-standards.md` §7.1/§7.2.

### Environment

| Env                     | Default                                    | Keterangan                                                            |
| ----------------------- | ------------------------------------------ | --------------------------------------------------------------------- |
| `DATABASE_URL`          | `postgres://localhost:5432/awcms_mini_dev` | Koneksi direct (fallback & dev/diagnostik)                            |
| `DATABASE_TRANSPORT`    | `direct`                                   | `direct` \| `pooler`                                                  |
| `DATABASE_POOLER_URL`   | _(kosong)_                                 | Connection string ke pooler; dipakai bila `DATABASE_TRANSPORT=pooler` |
| `DATABASE_POOLING_MODE` | `session`                                  | `session` (app long-running, default) \| `transaction` (serverless)   |

### Mode pooling

- **`session` (default & DISARANKAN untuk awcms-mini):** app Hono long-running di Coolify; konteks sesi & RLS `set_config` terjaga.
- **`transaction`:** hanya untuk runtime serverless/auto-scaling tinggi.

### Aturan transaction mode (§7.2)

- Driver `pg` + Kysely **tidak** memprepare statement (query tanpa `name`) → aman di transaction mode tanpa flag `prepare:false` khusus. Jangan beri `name` pada query di hot path.
- RLS: `set_config('app.current_user_id', ..., true)` + query yang memakainya **WAJIB** satu transaksi (lihat `withTransaction`).
- Negative test isolasi RLS **WAJIB** dijalankan via pooler.

### Setup operator (Coolify)

1. Jalankan PgBouncer/Supavisor sebagai service yang menunjuk PostgreSQL utama.
2. Set `DATABASE_TRANSPORT=pooler` + `DATABASE_POOLER_URL=<url-pooler>` di environment app.
3. Set `DATABASE_POOLING_MODE=session` (default) untuk awcms-mini.
4. Pertahankan `DATABASE_URL` (direct) untuk migrasi/diagnostik.

## Rules

- services should acquire database access through `src/db/index.mjs`
- services should use `withTransaction(...)` for multi-step writes
- nested transaction intent must be explicit through strategy selection
- error handling should classify database failures through `classifyDatabaseError(...)`
- repositories should filter `deleted_at is null` by default for soft-deletable entities
- repositories should expose explicit soft-delete, restore, or include-deleted paths instead of mixing deleted rows into normal reads

## Transaction Strategy

### `reuse`

- default nested strategy
- if a controlled transaction already exists, reuse it
- use this for normal service composition

### `savepoint`

- nested strategy for partial rollback boundaries inside an existing controlled transaction
- use only when a service truly needs savepoint semantics

## Recommended Service Pattern

```js
import { getDatabase, withTransaction } from "../db/index.mjs";

const db = getDatabase();

await withTransaction(db, async (trx) => {
  // multi-step write using trx
});
```

## Error Classification Kinds

- `authentication`
- `connection`
- `constraint`
- `migration`
- `not_found`
- `query`
- `transaction`
- `unknown`

## Validation

- `pnpm test:unit`
- `pnpm typecheck`
- `pnpm build`
