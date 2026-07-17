---
"awcms-mini": patch
---

Perbaiki dua beban performa di jalur hierarki `organization_structure` (Issue
#834). Keduanya murni optimasi — verdict, kontrak, dan hasil setiap fungsi tidak
berubah sedikit pun.

**1. `resolveLegalEntityScope`: walk descendant O(S x depth), worst O(U²) → O(U + E).**
Adapter memanggil `computeDescendants` sekali per unit yang mendeklarasikan legal
entity, dan tiap panggilan mengalokasi `visited` set **baru** — nol sharing,
sehingga setiap subtree yang dipakai bersama di-walk ulang sekali untuk tiap seed
di atasnya. `computeDescendantClosure` yang baru mengerjakan hal yang sama
sebagai **satu traversal multi-source di atas satu `visited` set bersama**: tiap
node dikunjungi tepat sekali.

**2. `readEdgeMap` full-tenant di dalam critical section advisory lock → recursive CTE ancestor chain.**
`reparentUnit` memuat **seluruh** edge map tenant di dalam
`pg_advisory_xact_lock` tenant-wide, jadi throughput reparent per tenant turun
linear terhadap **ukuran tenant** — padahal cycle check hanya bergantung pada
**kedalaman** hierarki. `validateReparent` hanya pernah berjalan **ke atas** dari
`candidateParentId`, jadi `readAncestorChainEdgeMap` (recursive CTE) memuat cukup
rantai ancestor saja: verdict identik, O(depth) bukan O(tenant).
`candidateParentId === null` kini melewati query sepenuhnya (tak mungkin bikin
cycle).

**Advisory lock TIDAK diubah dan TIDAK dilemahkan.** Map tetap dibaca **setelah**
lock diambil — urutan itulah perbaikan race-nya, dan alternatif "ambil map
sebelum lock lalu revalidasi" justru membuka kembali race yang lock ini tutup.
Yang mengecil hanya **jumlah kerja di dalam** lock. Test konkurensi reparent yang
ada tetap hijau, ditambah test baru untuk cycle dalam (8 hop) lewat endpoint
nyata.

**Benchmark, tenant 10.000 unit (Postgres 18, seluruh unit mendeklarasikan legal
entity yang sama — worst case untuk walk per-seed):**

| Shape                | Baca di dalam lock (SQL) | Walk `resolveLegalEntityScope` |
| -------------------- | ------------------------ | ------------------------------ |
| Wide (spine 50)      | 5,67 ms → 0,40 ms (14x)  | 28,62 ms → 1,02 ms (28x)       |
| Deep (chain 10k)     | 4,97 ms → 1,58 ms (3,1x) | 4383,55 ms → 0,83 ms (5304x)   |

Shape deep mengonfirmasi ledakan kuadratik yang diprediksi issue secara empiris.
Hasil kedua shape identik dengan sebelum perubahan (10.000 scope).

**Tanpa migration.** Recursive step-nya lookup `(tenant_id,
organization_unit_id)` per level; `EXPLAIN ANALYZE` mengonfirmasi Nested Loop +
Index Scan di tiap level (`shared hit=6`, tanpa seq scan) memakai index yang
sudah ada dari `sql/063`.

**Koreksi premis issue.** DoD meminta `resolveLegalEntityScope` "filter root
beneran di SQL", dengan alasan walk-nya redundan. Itu keliru dua kali:
`awcms_mini_organization_units` **tidak punya kolom `parent_id`** (hierarki hidup
di tabel `awcms_mini_organization_unit_hierarchies` yang terpisah dan
effective-dated), jadi predikat `parent_id IS NULL` tak bisa ditulis; dan
walk-nya **load-bearing**, bukan redundan — descendant rutin **tidak**
mendeklarasikan entity-nya sendiri (mereka mewarisi secara struktural), jadi
closure-nya benar-benar lebih besar dari seed set. Memfilter seed ke root akan
**diam-diam mempersempit scope otorisasi**: unit yang mendeklarasikan entity di
bawah parent yang tidak mendeklarasikannya akan hilang bersama seluruh
subtree-nya. Yang cacat adalah **bentuk** walk-nya, bukan keberadaannya. Test
regresi baru mengunci kontrak ini agar "perbaikan" root-filter itu tidak
diterapkan nanti.

Ini recursive CTE **pertama** di repo. Pola "satu bulk query muat seluruh
adjacency tenant, walk in-memory" tetap benar di semua read path lain (di sana
map penuh memang jawabannya); ia salah **khusus di sini** karena baca ini duduk
di dalam lock tenant-wide dan hanya butuh satu jalur ke akar.
