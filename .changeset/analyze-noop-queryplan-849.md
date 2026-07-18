---
"awcms-mini": patch
---

Buat `ANALYZE` di suite query-plan benar-benar berjalan dan gagal keras kalau
tidak (Issue #849, epic #818). PostgreSQL **diam-diam melewati** `ANALYZE` atas
tabel yang tidak dimiliki peran pemanggil — hanya WARNING, bukan error, exit
status sukses. Karena query-plan check menjalankan `ANALYZE` lewat peran
least-privilege `awcms_mini_app` (yang tidak memiliki tabel), statistik planner
tidak pernah disegarkan; budget lolos/gagal karena kebetulan timing autovacuum,
bukan pengukuran nyata (`admin_list` sempat merah palsu karena `Sort`;
`blog-posts-fulltext-search` sempat merah palsu ~874 di jalur script ber-bloat).

Perbaikan: modul baru `src/lib/performance/analyze-fixtures.ts`
(`analyzeQueryPlanFixtures`) menyegarkan statistik lewat koneksi **privileged**
(pemilik tabel) lalu **membuktikan** itu berjalan dengan memeriksa
`pg_stat_user_tables.analyze_count` benar-benar naik untuk setiap tabel — kalau
tidak, ia melempar (test: `beforeAll` gagal; script: exit 1 dengan pesan yang
bisa ditindaklanjuti). Integration harness memakai `getAdminSql()`; script
`performance:query-plan:check` memakai `PERF_ANALYZE_DATABASE_URL` (URL
owner/superuser), fallback ke `DATABASE_URL`. CI menyetel
`PERF_ANALYZE_DATABASE_URL` ke peran migration-owner. EXPLAIN tetap berjalan
RLS-enforced sebagai peran least-privilege — ANALYZE dipisah sebagai operasi
maintenance milik owner.

Tidak ada perubahan threshold budget: dengan statistik akurat semua budget lolos
dengan margin sehat (fts 472–667/800, reporting 562–1132/1300, admin-list
57–71/200). Klaim lama "fts latently red 939.5 vs 800" **tidak tereproduksi** —
biaya statistik-akurat tak pernah melewati ~667. Proof `DROP INDEX` kini
menegakkan biaya sekaligus bentuk plan (dropped ~316–472 vs budget 200), dan
gate pure-unit baru memastikan setiap tabel penggerak budget ada di daftar
ANALYZE.
