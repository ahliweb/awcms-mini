# ADR-0003 — PostgreSQL + RLS untuk isolasi multi-tenant

- **Status:** Accepted
- **Tanggal:** 2026-07-05
- **Terkait:** `docs/awcms-mini/04_erd_data_dictionary.md`, `docs/awcms-mini/16_backend_data_access_integration.md`

## Konteks

Base bersifat multi-tenant. Mengandalkan filter `tenant_id` di kode aplikasi saja rapuh — satu query yang lupa memfilter dapat membocorkan data lintas-tenant. Kami butuh pertahanan berlapis (defense in depth) di level database.

## Keputusan

Kami memutuskan memakai **PostgreSQL** dengan **Row Level Security (RLS)** pada semua tabel tenant-scoped: `ENABLE` + `FORCE ROW LEVEL SECURITY` + policy `tenant_id = current_setting('app.current_tenant_id')`. Konteks tenant di-set per transaksi via `SET LOCAL` (`set_config(..., true)`) agar aman dengan PgBouncer transaction pooling. Query tetap memfilter `tenant_id` secara eksplisit sebagai lapisan pertama; RLS adalah lapisan kedua. Koneksi aplikasi produksi memakai role **non-superuser** (superuser bypass RLS).

## Konsekuensi

- **Positif:** kebocoran lintas-tenant tercegah di level DB walau kode keliru; teruji dengan role non-superuser.
- **Trade-off:** setiap transaksi wajib men-set konteks tenant; migration wajib menambah policy; ada sedikit overhead.
- **Netral:** UUID sebagai PK, `timestamptz`, `numeric` untuk uang/kuantitas menjadi standar turunan.

## Alternatif yang dipertimbangkan

- **Isolasi hanya di aplikasi** — ditolak: satu bug = kebocoran data lintas-tenant.
- **Database per tenant** — ditolak: biaya operasional dan migrasi tinggi untuk skala base.
