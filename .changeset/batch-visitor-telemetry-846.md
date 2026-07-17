---
"awcms-mini": patch
---

Batch tulisan telemetri pengunjung per tenant supaya beban pool tidak lagi naik
linear terhadap traffic publik (Issue #846, epic #818).

**Premis isu meleset, dan koreksinya yang menentukan bentuk perbaikan.** Isu
meminta "batch INSERT `visit_event` per-event". Diukur — lewat TCP proxy yang
menghitung round trip di kabel, ke Postgres nyata — satu kunjungan publik
sebenarnya berharga **5,2 round trip**: BEGIN, SET LOCAL, SELECT session, INSERT
event, COMMIT, plus 0,2 UPDATE session yang teramortisasi throttle 30 detik.
INSERT yang disebut judul isu hanya **~19%** dari biaya itu, dan tidak mungkin
di-batch sendirian: ia butuh `visitor_session_id` yang dihasilkan SELECT di
transaksi yang sama. Biaya dominannya adalah **scaffolding transaksi per-event
(~58%)**. Maka yang di-batch adalah **transaksinya**, bukan INSERT-nya: N event
satu tenant kini berharga ~5-7 round trip total, bukan 5,2 **masing-masing**.

Hasil (metode identik untuk baseline dan sesudahnya, angka setup diassert —
jumlah row tertulis dan jumlah transaksi penulis diverifikasi, bukan diasumsikan):

| skenario                             | sebelum         | sesudah         |
| ------------------------------------ | --------------- | --------------- |
| round trip / event                   | 5,2             | **0,18** (~29x) |
| per event, latensi 2ms/hop disuntik  | 28,89ms         | **1,38ms** (~21x) |
| per event, loopback                  | 1,43ms          | 0,28ms          |

Selisih loopback vs 2ms/hop (1,43ms → 28,89ms pada baseline yang sama)
menunjukkan kenapa angka ini tidak boleh diklaim dari loopback: **loopback
menyembunyikan biaya round-trip**, yaitu persis biaya yang dihapus batching.

**Trade yang dipilih sadar.** Record hidup di memori sampai batch-nya flush,
jadi crash KERAS (SIGKILL/OOM/panic) bisa kehilangan ≤ `BATCH_LINGER_MS` (200ms)
traffic per tenant atau `MAX_BATCH_SIZE` (50) event — jendela yang memang lebih
lebar dari sebelumnya. SIGTERM/SIGINT normal **tidak kehilangan apa pun**:
flush menulis batch **PARSIAL**, tidak pernah menunggu batch penuh atau linger
timer. Trade ini diterima khusus untuk visitor analytics — data agregat yang
sudah lossy by design (queue bounded drop, flush timeout, collector fail-open) —
dan **tidak berlaku untuk tulisan ledger/audit/transaksi posted**. Bounded
(`MAX_PENDING_EVENTS`) dan drop-nya nyaring lewat counter baru
`visitor_analytics_batch_dropped_total` + gauge `visitor_analytics_batch_pending`
(terpisah dari counter tahap 1 supaya operator tahu tahap MANA yang jenuh).

Jaminan #832 utuh: `enqueueVisitorTelemetry` tetap mengembalikan `void`,
antrean tetap bounded/fail-open, dan hook shutdown tetap hanya dipasang dari
`src/middleware.ts` — bukan dari panggilan data-plane.

`occurred_at` kini di-capture di jalur respons dan di-INSERT eksplisit. Tanpa
ini, penundaan batch akan menggeser timestamp setiap event ke waktu flush-nya
dan merusak analytics secara diam-diam.

**Dua trap terverifikasi empiris.** Bentuk bulk yang paling alami —
`unnest(..., tx.array(rows.map(r => JSON.stringify(r.geo)), "jsonb"))` —
memunculkan kembali bug Issue #623: byte-nya identik, tapi setiap SELECT
mengembalikan `string`, bukan objek. Karena itu insert batch memakai row helper
`tx(rows)` dengan objek polos. Mutation test juga menemukan dua celah di test
buatan sendiri: bulk UPDATE session (unnest 13 array) semula tidak dijalankan
test mana pun — dan karena berada di dalam `catch` fail-open, syntax error di
situ akan ditelan diam-diam selamanya; keduanya kini tertutup.
