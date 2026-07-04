---
name: awcms-mini-new-migration
description: Buat migration SQL PostgreSQL AWCMS-Mini yang benar. Gunakan setiap kali menambah/mengubah tabel, kolom, index, constraint, atau RLS. Menegakkan penamaan NNN_awcms_mini_<area>_<desc>.sql, tenant_id, RLS, index FK, timestamptz, dan numeric sesuai doc 04 & 10.
---

# AWCMS-Mini — New SQL Migration

Ikuti standar di `docs/awcms-mini/04_erd_data_dictionary.md` dan `docs/awcms-mini/10_template_kode_coding_standard.md`.

## Penamaan

```text
sql/NNN_awcms_mini_<area>_<description>.sql
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
10. Tabel master/config/draft yang deletable wajib soft delete (`deleted_at`, `deleted_by`, `delete_reason`) + index/partial unique aktif.

## Template

```sql
BEGIN;

CREATE TABLE IF NOT EXISTS awcms_mini_<name> (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  code text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text,
  restored_at timestamptz,
  restored_by uuid
);

CREATE INDEX IF NOT EXISTS idx_awcms_mini_<name>_tenant
  ON awcms_mini_<name> (tenant_id);
CREATE INDEX IF NOT EXISTS idx_awcms_mini_<name>_tenant_created
  ON awcms_mini_<name> (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_awcms_mini_<name>_active
  ON awcms_mini_<name> (tenant_id, created_at DESC)
  WHERE deleted_at IS NULL;

ALTER TABLE awcms_mini_<name> ENABLE ROW LEVEL SECURITY;
CREATE POLICY awcms_mini_<name>_tenant_isolation ON awcms_mini_<name>
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

COMMIT;
```

## Append-only & immutable

- Posted sales document & stock movement: **append-only**, tidak di-update/delete. Koreksi lewat reversal/return/adjustment.
- Jangan tambahkan soft delete ke entitas posted/append-only/audit/security log/exported tax batch.
- Untuk business key yang boleh dipakai ulang setelah arsip, gunakan partial unique index `WHERE deleted_at IS NULL`.

## Verifikasi

```bash
bun run db:migrate   # tidak double-run, berhenti saat error
```

Setelah migrate: cek row count kritis, constraint/index, partial unique soft delete, dan RLS aktif. Update ERD/data dictionary bila perlu (doc 04) dan matrix migration (doc 13).
