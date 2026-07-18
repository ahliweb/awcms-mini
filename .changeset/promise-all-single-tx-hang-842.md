---
"awcms-mini": patch
---

Hapus seluruh kelas `Promise.all` di atas satu transaction handle (`tx`), lalu
pasang gate statis supaya tidak kambuh untuk kelima kalinya (Issue #842, epic
#818).

Satu koneksi Postgres melayani **satu query pada satu waktu**. `tx` terikat ke
tepat satu koneksi, jadi `Promise.all([q1(tx), q2(tx)])` bukan sekadar
kehilangan paralelisme — ia **menghang sungguhan** di repo ini, dan koneksi yang
tersangkut lalu merusak `resetDatabase()` **setiap test sesudahnya**, sehingga
gejalanya muncul jauh dari penyebabnya. Catatan kanoniknya ada di
`src/modules/reporting/application/projection-reconciliation.ts:89-94`.

Sapuan kelas penuh menemukan **11 site**, bukan dua seperti dugaan awal isu —
seluruhnya pre-existing (2026-07-07 s.d. 2026-07-15), tidak ada yang regresi PR
manapun:

- `module-management/application/module-matrix.ts` (2 site: fan-out katalog, dan
  loop per-modul yang aman **hanya** selama `healthContext` yang sudah
  di-prefetch ikut dioper — satu argumen hilang dan tiap iterasi jadi 4 query
  konkuren di atas satu `tx`; kini loop sekuensial sehingga keamanannya
  struktural, bukan bergantung pada argumen yang tak diwajibkan siapa pun)
- `reference-data/application/reference-resolution-query.ts` (2 site)
- `visitor-analytics/application/rollup.ts` dan `analytics-queries.ts` (4 query
  masing-masing)
- `admin/blog/index.astro`, `admin/blog/posts/[id].astro`,
  `admin/modules/[moduleKey].astro` (yang terlebar: `fetchModuleHealthReport`
  dipanggil tanpa context ter-prefetch, sendirian menambah 4 query — sampai
  delapan balapan di satu koneksi)
- `api/v1/blog/menus/index.ts` (fan-out **tak terbatas**: satu query konkuren per
  menu milik tenant)
- `api/v1/data-exchange/imports/[id]/preview.ts`, `api/v1/analytics/devices.ts`

Semua gating permission dipertahankan persis: read yang ditolak tetap tidak
mengeluarkan query apa pun dan tetap memakai fallback-nya. Tidak ada performa
yang hilang — yang mahal adalah **jumlah** query, bukan serialisasinya (kemenangan
Issue #824 adalah meruntuhkan ≈92 query per render jadi 4, dan await berurutan
mempertahankannya utuh). Komentar usang di `admin/modules.astro` yang masih
mengklaim health dihitung paralel lewat `Promise.all` ikut dikoreksi.

Gate baru `bun run tx:lint:check`
(`scripts/tx-concurrency-lint-check.ts`, dipasang di `check` dan `ci.yml`)
menandai `Promise.all`/`allSettled` yang menyentuh transaction handle. Kelas ini
sudah kambuh 4x dan **test suite lolos setiap kali** — sifatnya load-dependent,
jadi test fungsional memang bukan gate untuk kelas ini. Konkurensi di atas POOL
(`sql`) tetap legal dan tak tersentuh: pool memberi koneksi terpisah per query.

Gate membaca **token, bukan teks mentah**: komentar dan literal string/template
di-blank lebih dulu lewat state machine. Ini bukan kehati-hatian teoretis —
setiap perbaikan di atas menaruh komentar berbunyi "Sequential, NOT
`Promise.all` … over the same `tx`" tepat di atas kode yang diperbaiki, jadi gate
berbasis substring akan menandai justru kode yang sudah benar; dan gate saudaranya
`ci-check-parity.test.ts` shipped dengan cacat "prosa memuaskan gate" yang persis
sama (diperbaiki di PR #839).
