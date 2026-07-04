---
name: awpos-new-migration
description: Buat migration SQL PostgreSQL AWPOS yang benar. Gunakan setiap kali menambah/mengubah tabel, kolom, index, constraint, atau RLS. Menegakkan penamaan NNN_awpos_<area>_<desc>.sql, tenant_id, RLS, index FK, timestamptz, dan numeric sesuai doc 04 & 10.
---

# AWPOS — New SQL Migration

Ikuti standar di `docs/awpos/04_erd_data_dictionary.md` dan `docs/awpos/10_template_kode_coding_standard.md`.

## Penamaan

```text
sql/NNN_awpos_<area>_<description>.sql
```

- `NNN` berurutan, nol di depan (mis. `023`).
- **Jangan** me-rename migration yang sudah rilis; koreksi = migration baru.
- Cek nomor terakhir di `sql/` sebelum menambah.

## Aturan wajib

1. `id uuid PRIMARY KEY DEFAULT gen_random_uuid()` (perlu `pgcrypto`).
2. Tabel tenant-scoped **wajib** kolom `tenant_id uuid NOT NULL`.
3. Timestamp = `timestamptz`; uang/quantity = `numeric` (bukan float).
4. `CREATE TABLE IF NOT EXISTS` dan `CREATE INDEX IF NOT EXISTS`.
5. Index untuk `(tenant_id)`, setiap FK child, dan `(tenant_id, created_at DESC)` untuk transaksi/log.
6. `CHECK` constraint untuk kolom enum-like (status, type).
7. **RLS wajib** untuk tabel tenant-scoped (lihat template).
8. Bungkus dengan `BEGIN; ... COMMIT;`.
9. **Tidak** menyimpan password/API key/secret plaintext.

## Template

```sql
BEGIN;

CREATE TABLE IF NOT EXISTS awpos_<name> (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  code text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid
);

CREATE INDEX IF NOT EXISTS idx_awpos_<name>_tenant
  ON awpos_<name> (tenant_id);
CREATE INDEX IF NOT EXISTS idx_awpos_<name>_tenant_created
  ON awpos_<name> (tenant_id, created_at DESC);

ALTER TABLE awpos_<name> ENABLE ROW LEVEL SECURITY;
CREATE POLICY awpos_<name>_tenant_isolation ON awpos_<name>
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

COMMIT;
```

## Append-only & immutable

- Posted sales document & stock movement: **append-only**, tidak di-update/delete. Koreksi lewat reversal/return/adjustment.

## Verifikasi

```bash
bun run db:migrate   # tidak double-run, berhenti saat error
```

Setelah migrate: cek row count kritis, constraint/index, dan RLS aktif. Update ERD/data dictionary bila perlu (doc 04) dan matrix migration (doc 13).
