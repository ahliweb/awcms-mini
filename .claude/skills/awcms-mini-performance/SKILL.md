---
name: awcms-mini-performance
description: Audit dan tingkatkan performa aplikasi & database AWCMS-Mini. Gunakan saat diminta "optimasi performa/query", ada endpoint lambat, N+1, masalah indexing/pagination, tuning connection pool, atau perencanaan materialized view/caching. Menegakkan pola akses data doc 16, pooling/backpressure, dan pagination keyset.
---

# AWCMS-Mini — Performance & Database Tuning

Sumber kebenaran: **`docs/awcms-mini/16_backend_data_access_integration.md`** (lapisan akses data, pooling/backpressure, transaction), **`docs/awcms-mini/database-pooling.md`**, dan **`docs/awcms-mini/07_sprint_testing_production_readiness.md`** (target performa). Skill ini **peningkatan**: ukur → temukan bottleneck → perbaiki → ukur ulang.

## Aturan emas

**Ukur sebelum optimasi.** Jangan menebak — jalankan `EXPLAIN (ANALYZE, BUFFERS)` pada query yang dicurigai, dan benchmark endpoint (p50/p95/p99) sebelum & sesudah. Optimasi tanpa data = spekulasi.

## Database

- [ ] **Index RLS-aware** — query tenant-scoped selalu difilter `tenant_id`; index komposit **harus** berprefiks `(tenant_id, …)` agar cocok dengan predikat RLS + filter. Cek index hilang via `EXPLAIN` (Seq Scan pada tabel besar = merah).
- [ ] **Hindari N+1** — jangan query dalam loop; batch pakai `= ANY(tx.array(ids, "uuid"))` (lihat memory Bun SQL array binding) atau `JOIN`. Cari pola `for (…) await tx\`SELECT …\``.
- [ ] **Pagination keyset, bukan OFFSET** — `WHERE (created_at, id) < (:cursor)` + `LIMIT`, bukan `OFFSET n` besar (doc 14 §Pagination). OFFSET besar memindai lalu membuang baris. Helper bersama sudah ada (Issue #435): `encodeKeysetCursor`/`decodeKeysetCursor` (`src/modules/_shared/keyset-pagination.ts`, cursor opaque base64 `createdAt|id`, cursor rusak → `400 VALIDATION_ERROR` bukan diam-diam dianggap "tanpa cursor") — **reuse**, jangan implementasi ulang per endpoint.
- [ ] **Join setelah LIMIT bisa membuat planner salah pilih plan** — kalau query sudah punya index yang tepat tapi `EXPLAIN` tetap menunjukkan Seq Scan, cek apakah `LIMIT` diterapkan **setelah** `JOIN` (planner mengestimasi baris hasil join, bisa meleset jauh dan menganggap Index Scan lebih mahal dari kenyataan). Perbaikan: pindahkan `LIMIT`+`ORDER BY` ke **subquery sebelum join** (pola `fetchObjectQueueEntries`, `src/modules/sync-storage/application/sync-directory.ts`, Issue #435) — planner tidak lagi punya pilihan selain memenuhi `LIMIT` langsung dari index.
- [ ] **Kolom eksplisit** — hindari `SELECT *`; ambil hanya kolom yang dipakai (kurangi I/O + payload).
- [ ] **`count(*)::int`** untuk agregat kecil; ingat bigint Postgres kembali sebagai string dari Bun.SQL → `Number(...)` eksplisit, jangan `as number`.
- [ ] **jsonb** — index GIN hanya bila di-query berdasarkan isi; jangan simpan payload besar yang tak pernah difilter.
- [ ] **Materialized view / read model** — untuk laporan agregasi berat yang tak butuh real-time; refresh terjadwal. Report base saat ini agregasi baca langsung (doc: reporting) — pertimbangkan MV bila data tumbuh.
- [ ] **Statement timeout** — `DATABASE_STATEMENT_TIMEOUT_MS` mencegah query liar mengunci koneksi.

## Aplikasi & koneksi

- [ ] **Work-class pool + backpressure** — endpoint diklasifikasi (`critical_transaction`/`interactive`/`reporting`/`background_sync`/`maintenance`, doc 16). Laporan berat & sync **tidak** boleh di kelas `interactive`; saturasi → `503 DATABASE_BUSY`, bukan menjenuhkan seluruh pool.
- [ ] **Transaksi seringkas mungkin** — kerja CPU-bound (argon2 hashing) & panggilan provider eksternal **di luar** transaksi DB (ADR-0006); jangan menahan koneksi/lock saat menunggu I/O eksternal.
- [ ] **PgBouncer** — bila `DATABASE_PGBOUNCER=true`, prepared statement dinonaktifkan (mode transaction). Pastikan `DATABASE_POOL_MAX` selaras dengan limit pool server.
- [ ] **SSR reuse** — halaman admin fetch via fungsi application-layer di dalam satu `withTenant`, bukan round-trip HTTP ke API sendiri (pola `*-directory.ts`/`*-report.ts`).
- [ ] **Locking** — `FOR UPDATE` hanya pada baris yang benar-benar dimutasi bersama (mis. stok); hindari lock rentang lebar.

## Verifikasi

- `EXPLAIN ANALYZE` sebelum/sesudah menunjukkan perbaikan nyata (Seq→Index Scan, plan cost turun).
- Benchmark p95 endpoint membaik; tak ada regresi fungsional (`bun run check` hijau).
- Uji beban ringan: query saturasi kelas pool → `503`, mengering ke 0 (bukti backpressure, seperti verifikasi Issue 10.2).
- Tak ada N+1 baru; tak ada `OFFSET` besar; index cocok dengan predikat.

## Perangkap terverifikasi (audit repo 2026-07-17, epic #818)

Temuan berulang dari audit menyeluruh v0.24.0. Cek dulu ke sini sebelum mengaudit dari nol.

### Pola bug yang benar-benar muncul di repo ini

- **Klamp separuh** — `limit`/`pageSize` diklamp benar, `offset`/`page` di sebelahnya **tidak**. Muncul di dua tempat independen (#819 `boundedPage`, #831 preview offset), keduanya dengan klamp yang benar **satu baris di bawahnya**. Saat menyentuh pagination, klamp **kedua** sisi + jaga `NaN`/`Infinity` (`Number("abc")` → `NaN` → `Math.max(NaN,1)` → `NaN` → `OFFSET NaN` → **500**).
- **Signal invariant di dalam loop per-modul** — #824: `migrationsAppliedSignal` **tidak menerima `moduleKey`** (hasil identik untuk 23 modul) tapi dijalankan 23× lengkap dengan `readdir` + full-table scan ⇒ ≈92 query/render. **Kalau fungsi tidak menerima parameter loop-nya, hasilnya invariant — hoist keluar.** Cache `readdir`/YAML di module scope; preseden: `readYamlCached` (`health-registry.ts:220-232`).
- **API batch-shaped, implementasi N+1** — #835: `resolveMediaReferences` menerima banyak ref sekaligus, caller membatch dengan benar, implementasinya query satu-satu. Pemanggil yang menulis kode benar tetap membayar N query. Periksa implementasi, jangan percaya signature.
- **Kerja berat di dalam critical section** — #834: `readEdgeMap` full-tenant dipanggil **setelah** `pg_advisory_xact_lock` ⇒ throughput turun linear terhadap ukuran tenant, bukan kedalaman. Ambil data **sebelum** lock, revalidasi di dalam.
- **Rescan di dalam loop** — #833: `subjectFacts.filter(...)` per rule per key ⇒ O(P×R×K×F×S) ≈ 6M kunjungan per POST, di dalam transaksi. Hoist `Map`/`Set` sekali per request.
- **`FOR UPDATE` tanpa `LIMIT` + I/O eksternal sambil memegang lock** — #835: job scheduled-publish mengunci semua row yang match lalu memanggil port social-publishing. Pakai `LIMIT n` + `FOR UPDATE SKIP LOCKED` per batch; jangan tarik kolom terlebar (`content_*`) di query _pemilihan_.
- **Telemetri di jalur kritis** — #832: `await collectRequestAnalytics(...)` memblokir tiap request publik (4-6 RTT masuk TTFB). Telemetri fail-open tidak boleh di-await sebelum response.
- **Resolusi nyaris-statis tanpa cache** — #832: host→tenant di-resolve tiap request padahal berubah hitungan hari.
- **`ORDER BY` tanpa index pendukung** — #830: `ORDER BY updated_at DESC` pada blog posts/pages, tanpa index `updated_at` sama sekali. Index `(tenant_id, status, published_at DESC)` **tidak** menolong. Cek index untuk kolom `ORDER BY`, bukan hanya kolom `WHERE`.
- **Leading wildcard mematikan GIN** — `title ILIKE '%x%'` melumpuhkan index `search_vector` yang sudah ada. Pakai `search_vector @@`.

### Sudah benar — JANGAN "diperbaiki"

Diverifikasi optimal; menyentuhnya = regresi atau kerja sia-sia.

- `workflow-graph.ts` `detectCycle` (:803-856) — DFS `visiting`/`visited` Set = **O(V+E)**, optimal. `MAX_NODES = 64` membatasi semuanya. 949 barisnya adalah validasi bentuk per-node, **bukan** algoritma.
- `module-dependency-graph.ts:167-181` — Kahn naif O(V×(V+E)), tapi V≈23 statis & **build-time only**. Tidak pernah menggigit.
- `evaluateAccess` (`access-control.ts:301`) — murni, Set-based, O(1).
- Keyset pagination **sudah** dipakai tepat: `visitor-analytics`, `blog-search`, `email`, `tenant-domain`, `sync-*` via `_shared/keyset-pagination.ts`.
- `data-lifecycle/archive-purge-job.ts:199` — `SELECT *` **legit** (archiver generik lintas tabel arbitrer); keyset cursor loop benar.
- i18n catalog sudah di-cache (`catalog.ts:15`).
- **57 FK non-leading** dalam `(tenant_id, x)` **tidak perlu** index tambahan — setiap query memfilter `tenant_id` eksplisit per doc 16. Menambahnya = biaya tulis tanpa manfaat. (Beda dengan **32 FK tanpa index sama sekali**, #830 — itu nyata.)

### Karakter arsitektural yang perlu diketahui

Repo ini **tidak punya recursive CTE sama sekali** dan **tidak punya per-level query loop**. Pola hierarki selalu: satu bulk query muat seluruh adjacency tenant → walk in-memory. Untuk tenant kecil ini tepat, dan kegagalannya adalah **kebalikan N+1** (satu query terlalu besar, bukan terlalu banyak query). `organization-structure` (#834) satu-satunya tempat recursive CTE benar-benar berbayar.

## Performance suite representatif (Issue #744)

Untuk audit performa yang butuh bukti lebih dari sekadar `EXPLAIN` manual —
fixture multi-tenant sintetik berskala, skenario load/soak/saturasi-dan-
recovery, dan budget regresi query-plan versioned — gunakan suite yang
sudah ada di `src/lib/performance/`, jangan bangun tooling ad hoc baru:

```bash
# Safe subset (detik) — dijalankan di CI job `quality` (.github/workflows/ci.yml),
# BUKAN bagian dari komposit `bun run check` (sama seperti resilience:dr-drill):
bun run performance:suite -- --confirm-non-production=<APP_ENV>
bun run performance:query-plan:check -- --confirm-non-production=<APP_ENV>

# Full lane (skala besar + soak, terjadwal/manual — --full):
bun run performance:suite -- --confirm-non-production=<APP_ENV> --full
```

Menambah budget baru? Registrasikan di
`src/lib/performance/query-plan-budgets.ts` (SQL pasangannya di
`query-plan-runner.ts`) dengan `approval.reason` yang jelas — mengubah
threshold yang sudah ada wajib diff yang direview, bukan flag runtime.
Lihat [`performance-suite.md`](../../../docs/awcms-mini/performance-suite.md)
untuk arsitektur lengkap, safe subset vs full lane, dan format artefak.

## Skill terkait

`awcms-mini-new-migration` (tambah index via migration berurutan), `awcms-mini-integration` (I/O eksternal & outbox), `awcms-mini-testing` (benchmark/load test), `awcms-mini-production-preflight` (`db:pool:health`).
