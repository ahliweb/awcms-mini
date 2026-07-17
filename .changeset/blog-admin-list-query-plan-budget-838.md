---
"awcms-mini": patch
---

Kunci index blog admin list dari Issue #830 dengan query-plan budget (Issue
#838, epic #818). #830 menambahkan `(tenant_id, updated_at DESC)` untuk
`awcms_mini_blog_posts`/`awcms_mini_blog_pages` dengan bukti EXPLAIN kuat, tapi
tidak ada budget yang mencegahnya regresi — index bisa terhapus dan CI tetap
hijau.

**Sinyal budget-nya `Sort`, bukan `Seq Scan` — ini terukur, bukan asumsi.**
Menyalin bentuk lima budget sebelumnya (`forbiddenNodeTypes: ["Seq Scan"]`)
akan menghasilkan **gate vakum**. Dengan index di-`DROP` sungguhan pada skala
fixture `safe`, planner **tidak** jatuh ke Seq Scan: RLS selalu menyuntikkan
`tenant_id = current_setting(...)` dan tabelnya masih punya
`..._tenant_deleted_idx`, jadi planner memakai index itu lalu menambah `Sort`:

| Blog admin post list  | Plan                                                    | Cost   |
| --------------------- | ------------------------------------------------------- | ------ |
| index ada             | `Limit -> Index Scan`                                    | 62,06  |
| index di-`DROP`       | `Limit -> Sort -> Bitmap Heap Scan -> Bitmap Index Scan` | 939,88 |

Budget "Seq Scan saja" LULUS pada plan kedua. Karena itu kategori baru
`admin_list` melarang `Sort`/`Incremental Sort` (invarian sesungguhnya:
`ORDER BY` dilayani urutan index, jadi plan tidak menyortir apa pun),
dengan `maxTotalCost` sebagai lapis pertahanan kedua yang independen.

Perubahan:

- Dua budget baru — `blog-posts-admin-list` dan `blog-pages-admin-list` —
  di `query-plan-budgets.ts`, SQL pasangannya (bentuk asli
  `listBlogPostsForAdmin`/`listBlogPagesForAdmin`, termasuk filter opsional
  yang di-bind NULL seperti tampilan default) di `query-plan-runner.ts`.
- `awcms_mini_blog_pages` kini di-seed (`scale-profiles.ts` field `blogPages`,
  `generateBlogPages`, `insertBlogPages`, plus DELETE di
  `resetPerformanceFixtureRows`). Tanpa ini budget page mustahil: **budget di
  atas tabel kosong = gate vakum**, Postgres Seq Scan tabel 0 baris apa pun
  index-nya.
- `updated_at` kini benar-benar dihasilkan generator untuk post dan page.
  Sebelumnya tidak pernah di-insert sehingga jatuh ke `DEFAULT now()` — satu
  nilai per transaksi seeding (terukur: 5 nilai distinct untuk 3000 baris).
  Budget `ORDER BY updated_at DESC` di atas kolom konstan bukan proxy yang
  bermakna; kini tersebar realistis (selalu >= `created_at`).
- Proof adversarial: unit test menjalankan budget terhadap plan terukur di
  atas **termasuk assertion bahwa varian naif TIDAK menangkap regresinya**,
  dan integration test benar-benar `DROP INDEX` (dikembalikan di `finally`,
  drop diassert ke `pg_indexes` lebih dulu) lalu memastikan gate MERAH —
  persis DoD Issue #838.

Terdokumentasi juga di `performance-suite.md`: statistik planner di suite ini
sering basi karena peran `awcms_mini_app` bukan owner tabel, sehingga `ANALYZE`
**di-skip diam-diam dengan WARNING, bukan error** — assertion bentuk plan
bertahan pada regime statistik buruk, assertion cost tidak. Itulah alasan
budget `admin_list` memimpin dengan bentuk plan.

Konsekuensi lanjutan yang juga terukur: `CREATE INDEX` memperbarui
`pg_class.reltuples`/`relpages` sebagai efek samping (`-1/0` → `2000/334`),
sehingga planner tahu jumlah baris sebenarnya tapi **tetap nol statistik
kolom** — satu-satunya kondisi di mana index budget ini justru kalah tipis:

| kondisi `pg_class`                | plan                                    | cost  |
| --------------------------------- | --------------------------------------- | ----- |
| `reltuples=-1` (belum di-analyze) | `Index Scan(..._tenant_updated_idx)`     | 8,3   |
| `reltuples` nyata, nol stat kolom | `Sort` + `Scan(..._tenant_deleted_idx)`  | 8,19  |
| ter-`ANALYZE` penuh (DB nyata)    | `Index Scan(..._tenant_updated_idx)`     | 57,17 |

Dua plan itu **seri dalam ~1%**, jadi planner ambil yang sedikit lebih murah —
lemparan koin, bukan penilaian. Baris tengah tidak pernah terjadi di deployment
nyata (autovacuum menghasilkan baris ketiga). Karena itu proof `DROP INDEX`
meng-assert pemulihan index lewat `pg_indexes.indexdef` (round-trip terhadap
definisi yang ditangkap sebelum drop), **bukan** dengan menjalankan `EXPLAIN`
ulang: memulihkan index itu fakta schema, jadi di-assert sebagai fakta schema.
Assertion inti (before hijau, regressed merah) tidak berubah dan tetap
terbukti merah lewat mutation test.
