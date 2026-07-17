---
"awcms-mini": patch
---

perf(middleware): analytics tidak lagi memblokir response + cache host→tenant (Issue #832)

**Akar masalah.** `src/middleware.ts` meng-`await collectRequestAnalytics(...)`
sebelum mengembalikan response, pada **setiap** request publik. Di dalamnya:
resolusi host→tenant (1-2 query, tanpa cache padahal mapping domain→tenant
berubah dalam hitungan hari) lalu satu transaksi `withTenant` (SELECT session,
UPDATE/INSERT session, INSERT visit_event). Totalnya 4-6 round trip DB masuk
langsung ke TTFB tiap halaman publik — jalur yang justru paling sensitif TTFB
di repo dengan tenant domain routing. Docblock fungsi itu sendiri mengklaim
"never delays the response beyond its own `await`"; `await` itulah masalahnya.

**Perubahan.**

- Resolusi host→tenant kini di-cache in-process dengan TTL
  `PUBLIC_TENANT_CACHE_TTL_MS` (default 60s, `0` = nonaktif), termasuk hasil
  negatif, dengan single-flight (N request dingin untuk host yang sama =
  1 query, bukan N) dan batas `MAX_ENTRIES` agar flood `Host` header tidak
  bisa menumbuhkan memori tanpa batas. Kunci cache adalah hostname
  ter-normalisasi **utuh** — bukan suffix/label — dan hanya memoize fungsi
  yang murni bergantung pada host, sehingga tidak ada jalan bagi tenant A
  melihat tenant B.
- Analytics tidak lagi memblokir response: bagian yang menyentuh `context`
  (cookie visitor, config, IP/geo/UA dari header) tetap sinkron dan inline
  (tanpa DB), sedangkan lookup tenant + write dipindah ke antrean in-memory
  terbatas. **Bukan** `void collectRequestAnalytics(...)` seperti saran
  minimal issue: itu akan membuat `context.cookies.set(...)` hilang (Astro
  sudah men-serialize cookie begitu middleware return), sehingga tiap request
  mencetak visitor key baru dan memecah semua session.
- Tidak ada kehilangan event pada shutdown normal: antrean di-flush pada
  SIGTERM/SIGINT/`beforeExit` (adapter `@astrojs/node` standalone tidak
  memasang handler sinyal apa pun, jadi tanpa ini event pending hilang).
- Invalidasi cache dipasang di endpoint tenant-domain (create/update/verify/
  delete) **setelah** transaksi commit, bukan di dalamnya.

**Angka TTFB (diukur, bukan asumsi).** Server hasil `bun run build`, Postgres
nyata, mapping host→tenant aktif, 200 sample `/news` setelah warmup:

| Skenario                       | p50 sebelum | p50 sesudah | mean sebelum | mean sesudah |
| ------------------------------ | ----------- | ----------- | ------------ | ------------ |
| DB loopback (best case DB)     | 3.94 ms     | 2.65 ms     | 4.11 ms      | 3.07 ms      |
| Write analytics lambat (+50ms) | 55.65 ms    | 2.10 ms     | 55.70 ms     | 2.44 ms      |

Baris pertama (−33% p50) memang kecil dalam angka absolut karena Postgres ada
di loopback (RTT sub-milidetik) — itu **best case** yang tidak mewakili
deployment nyata. Baris kedua mengisolasi hal yang sebenarnya diperbaiki:
dengan latensi 50ms disuntikkan ke write analytics, TTFB lama ikut naik penuh
ke 55.65 ms sementara TTFB baru tidak bergerak sama sekali (2.10 ms). Artinya
biaya analytics kini **nol** di jalur kritis, bukan sekadar lebih kecil — dan
penghematan sesungguhnya di produksi berskala dengan RTT/kontensi DB, bukan
dengan angka loopback di baris pertama.

Bukti tidak ada telemetri yang hilang (kondisi identik, write 50ms, SIGTERM
saat antrean masih terisi): tanpa flush hook 22/40 event tersimpan; dengan
flush hook 40/40.
