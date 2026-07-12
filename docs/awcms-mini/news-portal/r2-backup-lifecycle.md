# News Portal — R2 Backup, Lifecycle & Retention

Kebijakan backup, lifecycle objek, retensi, dan privasi/minimisasi data
untuk media berita R2-only di mode **full-online** (lihat
[`full-online-r2-architecture.md`](full-online-r2-architecture.md) §1 —
**tidak berlaku** untuk offline/LAN). Berbeda dari PostgreSQL (yang
punya `deploy/backup/backup-postgres.sh` dan konvensi soft delete doc
05), R2 di sini menyimpan **satu-satunya salinan** bytes gambar berita
(§3 arsitektur: "PostgreSQL hanya metadata") — kebijakan backup/lifecycle
untuk R2 karena itu sama pentingnya dengan backup database, bukan
pelengkap opsional.

## 1. Mengapa ini kritis — R2 adalah satu-satunya salinan

Karena mandat R2-only (tidak ada fallback filesystem lokal, §3
arsitektur), kehilangan objek di R2 berarti **kehilangan gambar berita
secara permanen** — tidak ada salinan lokal untuk dipulihkan. Ini
konsekuensi langsung dari trade-off yang diterima secara eksplisit di
§16 (ISO 22301) `full-online-r2-architecture.md`. Kebijakan di dokumen
ini adalah mitigasi untuk trade-off tersebut.

## 2. Lifecycle objek `pending`

- Objek berstatus `pending` (belum melewati langkah `confirm`/validasi
  penuh — lihat `full-online-r2-architecture.md` §5/§9) **wajib**
  dibersihkan otomatis setelah `NEWS_MEDIA_R2_PENDING_TTL_MINUTES`
  (default 60 menit) — baik baris metadata (hard delete, bukan soft
  delete, karena baris `pending` bukan "resource" yang pernah dipakai
  siapa pun) maupun objek fisik di R2.
- **Implementasi (Issue #690, epic #679 platform-hardening):**
  `bun run news-media:reconcile` (`scripts/news-media-r2-reconcile.ts`,
  logika di `src/modules/news-portal/application/news-media-
reconciliation.ts`) adalah job ini. Dibangun di atas shared worker
  runner (`src/lib/jobs/job-runner.ts`, Issue #697) — advisory lock per
  nama job, timeout, `--dry-run`, JSON telemetry — no-op sepenuhnya bila
  `NEWS_MEDIA_R2_ENABLED` bukan `"true"`. Lihat §Operator SOP di bawah
  untuk cara menjalankan/menjadwalkannya.
- **Urutan mutasi yang sebenarnya diimplementasikan** — klaim baris DB
  DULU (UPDATE/DELETE ber-guard atomik, `pending_upload`/`uploaded` ->
  `failed`), baru hapus objek R2, baru hard-delete baris `failed`
  tersebut. Ini deliberately BERBEDA dari urutan "hapus R2 dulu" yang
  disebut di paragraf sebelumnya (ditulis sebelum implementasi ada):
  klaim-DB-dulu diperlukan supaya klaim atomik yang sama dipakai
  `finalizeNewsMediaUploadSession` (Issue #634, "atomic claim before R2
  call") bisa menyerialkan job ini terhadap `finalize()` yang sedang
  berjalan bersamaan — bila job ini menghapus objek R2 duluan, sebuah
  `finalize()` yang genuinely sedang berjalan bisa kehilangan objeknya.
  Konsekuensi kegagalan-parsial yang disebut di atas (baris metadata
  basi tanpa objek R2 vs objek R2 yatim tanpa baris metadata) tetap
  aman dengan urutan job-klaim-dulu ini: kegagalan R2-delete meninggalkan
  baris `failed` (bukan `pending`) yang di-retry pass berikutnya oleh job
  yang sama; kegagalan setelah R2-delete tapi sebelum hard-delete baris
  meninggalkan objek R2 yatim tanpa baris — persis kategori
  **orphan-in-R2** §4 yang dideteksi/dibersihkan job ini sendiri di run
  berikutnya (self-healing, bukan jalan buntu).
- Job ini idempoten by construction — sekali baris/objek dibersihkan,
  tidak lagi cocok dengan kriteria kandidat pass berikutnya (tidak ada
  bookkeeping "sudah diproses" terpisah).

## 3. Retention policy per klasifikasi data

| Klasifikasi                                                   | Retensi                                                                                                                | Alasan                                                                                                                                                                       |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Objek `pending` (belum confirmed)                             | `NEWS_MEDIA_R2_PENDING_TTL_MINUTES` (default 60 menit)                                                                 | Belum pernah jadi bagian konten publik — risiko exposure lebih besar dari manfaat menyimpan lama (§8 arsitektur).                                                            |
| Objek `confirmed` yang direferensikan konten aktif            | Tidak terbatas (aset editorial, bagian arsip berita)                                                                   | Berita yang sudah publish adalah aset jangka panjang — sama prinsip immutability posted document (doc 05).                                                                   |
| Objek `confirmed` yang tidak lagi direferensikan (`orphaned`) | Masa tenggang minimum 30 hari sebelum hapus fisik, dapat dikonfigurasi operator                                        | Memberi jendela waktu untuk membatalkan penghapusan tidak sengaja (mis. draft yang direvisi lalu gambar lama "kehilangan" referensi sementara) sebelum penghapusan permanen. |
| Baris metadata `deleted` (soft delete)                        | Baris tetap ada (audit trail) sesuai konvensi soft delete doc 05; objek fisik R2 dihapus setelah masa tenggang di atas | Konsisten dengan pola soft delete resource lain — `deleted_at`/`deleted_by` di baris metadata, bukan penghapusan baris itu sendiri.                                          |

Retensi lebih pendek untuk data yang lebih berisiko (`pending`) dan
lebih panjang untuk aset yang sudah jadi bagian konten publik —
prinsip yang sama dipakai `visitor-analytics.md` (retensi bertingkat
sesuai sensitivitas/nilai data).

## 4. Deteksi objek `orphaned`

Objek `confirmed` menjadi kandidat `orphaned` ketika tidak ada lagi
referensi aktif dari `blog_content` (post/page/ads/gallery/video
thumbnail) atau surface news-portal lain (Issue #637-#640, #649) yang
menunjuknya.

**Titik referensi baru ditambahkan Issue #639:** blok `video_news`
content_json's `thumbnailMediaObjectId` (opsional) — diverifikasi
`verified`/`attached`/tenant-sama saat mode R2-only aktif, PERSIS pola
`featuredMediaId`/gallery `mediaObjectId` (#636). Sama seperti keduanya,
thumbnail video TIDAK PERNAH ditandai `attached` (tidak pernah menulis
`owner_resource_type`/`owner_resource_id`) — jadi belum menambah cross-
referencing NYATA untuk deteksi orphan di bawah, hanya menambah satu
lagi titik referensi yang WAJIB masuk daftar begitu cross-referencing itu
akhirnya dibangun.

**Status implementasi (Issue #690):** cross-referencing ke seluruh
titik referensi `blog_content` di atas (bukan hanya `owner_resource_id`
tabel registry sendiri) **masih di luar cakupan** — persis seperti
dicatat semula ("daftar titik referensi ini wajib diperbarui setiap
kali issue lanjutan menambah surface baru"), ini tetap benar dan belum
dikerjakan. Yang SUDAH diimplementasikan Issue #690
(`news-media-reconciliation.ts`) adalah DUA hal yang lebih sempit tapi
saling melengkapi:

1. **Physical cleanup untuk baris yang SUDAH ditandai `orphaned`** —
   `bun run news-media:reconcile` menyapu baris `status='orphaned'`
   yang `orphaned_at`-nya (kolom baru migration 046, diisi
   `markNewsMediaObjectOrphaned`) sudah melewati masa tenggang §3
   (`NEWS_MEDIA_R2_ORPHAN_GRACE_DAYS`, default 30 hari, minimum 30
   hari ditegakkan `config:validate`): objek R2 dihapus fisik, baris
   metadata di-soft-delete (BUKAN hard delete — §3's retention table).
   Job ini TIDAK menentukan sendiri kapan sebuah baris `attached`/
   `verified` menjadi `orphaned` (itu bagian cross-referencing yang
   masih di luar cakupan) — ia hanya bertindak begitu status itu SUDAH
   ada, dari sumber mana pun (manual, atau issue masa depan yang
   akhirnya mengimplementasikan cross-referencing di atas).
2. **Rekonsiliasi drift DB-vs-R2** (bukan "orphan" dalam arti "tidak
   direferensikan konten", tapi dalam arti "metadata DB dan objek fisik
   R2 tidak sinkron") — dua kategori tambahan:
   - **orphan-in-DB**: baris `uploaded`/`verified`/`attached`
     (DB mengira objek ada) tapi objek TIDAK ditemukan di listing R2.
     **Report-only** — job ini TIDAK PERNAH memutasi baris ini secara
     otomatis (baris `attached` bisa jadi sedang aktif melayani konten
     publish; mengubahnya tanpa keputusan manusia adalah persis jenis
     mutasi mengejutkan yang harus dihindari). Lihat §Operator SOP di
     bawah untuk remediasi.
   - **orphan-in-R2**: objek R2 yang TIDAK PUNYA baris DB sama sekali
     (status apa pun, termasuk yang sudah soft-deleted) — celah nyata
     karena `purgeNewsMediaObject` (hard delete baris, endpoint purge)
     tidak (dan sengaja tidak, ADR-0006: panggilan R2 tidak pernah di
     dalam transaksi DB) menghapus objek R2-nya sendiri secara
     sinkron. Job ini menutup celah itu secara asinkron: objek seperti
     ini dihapus fisik setelah umurnya (dari `LastModified` R2 sendiri,
     satu-satunya timestamp yang tersedia karena tidak ada baris DB)
     melewati masa tenggang §3 yang sama, DAN setelah pengecekan ulang
     tepat sebelum penghapusan (point lookup langsung ke DB,
     `objectKeyExistsForTenant`) memastikan tidak ada baris baru yang
     baru saja dibuat untuk key yang sama — inilah yang mencegah race
     condition (baris baru dibuat tepat sebelum job menghapus).

## 5. Strategi backup (di luar retensi lifecycle di atas)

R2 tidak punya mekanisme point-in-time-restore native yang setara
`pg_dump`/WAL PostgreSQL. Strategi yang direkomendasikan (dipilih
operator sesuai skala, bukan mandat tunggal — didokumentasikan di sini
sebagai opsi, implementasi konkret di luar cakupan Issue #631):

1. **Replikasi terjadwal ke bucket/region sekunder** — job periodik
   (pola sama `sync:objects:dispatch`) menyalin objek `confirmed` baru
   ke bucket cadangan (bisa provider R2 lain/region lain, atau S3-
   compatible lain) — memberi RPO setara interval job (mis. harian).
2. **Cloudflare R2 bucket versioning** (bila tersedia di rencana/plan
   operator) — melindungi dari penghapusan/overwrite tidak sengaja,
   walau §12 arsitektur sudah membuat overwrite key yang sama secara
   praktis tidak pernah terjadi by design (immutable per key).
3. **Minimal**: backup metadata PostgreSQL (`deploy/backup/*`, sudah
   ada) memastikan operator setidaknya tahu **objek mana** yang pernah
   ada (`object_key`, checksum, ukuran) sekalipun bytes-nya hilang —
   memungkinkan re-upload manual dari sumber asli (arsip redaksi) bila
   diperlukan, walau ini bukan pengganti backup bytes itu sendiri.

Operator **wajib** memilih minimal satu dari (1)/(2) untuk deployment
production yang menganggap arsip gambar berita sebagai aset penting
jangka panjang — dokumen ini tidak mewajibkan salah satu secara
spesifik karena trade-off biaya/kompleksitas berbeda per skala operator,
tapi **mewajibkan keputusan eksplisit dicatat** (bukan dibiarkan tanpa
strategi backup sama sekali, mengingat §1 di atas).

## 6. Kontinuitas (ISO 22301)

- **RPO (Recovery Point Objective)** untuk media: bergantung strategi
  §5 yang dipilih operator — replikasi harian berarti RPO ≤ 24 jam untuk
  objek yang hilang di antara siklus replikasi.
- **RTO (Recovery Time Objective)**: pembacaan gambar publik yang sudah
  ter-upload **tidak bergantung** pada ketersediaan aplikasi AWCMS-Mini
  (custom domain R2 melayani langsung) — RTO untuk _pembacaan_ gambar
  yang sudah ada secara praktis mendekati RTO Cloudflare R2 itu sendiri
  (di luar kendali aplikasi). RTO untuk _upload baru_ bergantung pada
  ketersediaan R2 API — tidak ada fallback (§3 arsitektur, trade-off
  diterima).
- **Rencana komunikasi** saat R2 outage berkepanjangan: editorial tetap
  bisa mempublikasikan artikel teks tanpa gambar baru (gambar bukan
  syarat mutlak publish, lihat `blog_content`), operator mengomunikasikan
  status ke redaksi lewat kanal operasional yang sudah ada (di luar
  cakupan dokumen ini).

## 7. Privasi & minimisasi data

- **Object key tidak pernah berisi PII** (§6 arsitektur) — hanya UUID +
  partisi tanggal + tenant ID.
- **Metadata minimal** — tabel registry (§5 arsitektur) hanya menyimpan
  field teknis (MIME, ukuran, checksum, dimensi) dan atribusi
  operasional (`uploaded_by`, timestamp) — tidak ada field bebas yang
  mendorong penyimpanan data pribadi berlebih di luar `alt_text`
  (yang memang untuk aksesibilitas, diisi sadar oleh editor).
- **EXIF/metadata tersemat pada file gambar** (mis. GPS lokasi
  pengambilan foto dari kamera/HP) **direkomendasikan** dibersihkan
  sebelum/saat upload — ini **belum diimplementasikan** (di luar cakupan
  Issue #631/#634 saat ini) dan dicatat di sini sebagai kontrol yang
  wajib dipertimbangkan implementor #634 atau issue hardening lanjutan,
  bukan diklaim sudah ada.
- **Right-to-erasure/hapus permintaan subjek** — mengikuti alur soft
  delete → hard delete masa tenggang yang sama (§3) yang sudah ada untuk
  penghapusan reguler; tidak ada mekanisme percepatan khusus permintaan
  privasi di scope epic ini (dicatat sebagai keterbatasan, bukan
  diabaikan).

## 8. Operator SOP — `bun run news-media:reconcile` (Issue #690)

**Prasyarat**: `NEWS_MEDIA_R2_ENABLED=true`. Job ini `skipped` tanpa efek
apa pun bila tidak.

**Langkah rutin (dijadwalkan)**:

1. Jadwalkan `bun run news-media:reconcile` harian via cron/systemd
   timer (sama seperti job terjadwal lain — lihat
   `deployment-profiles.md` §Job registry/§Shared worker runner). Job
   ini memakai advisory lock per nama (`src/lib/jobs/job-runner.ts`) —
   aman dijalankan lebih sering; instance kedua yang tumpang tindih
   otomatis di-skip, bukan error.
2. Sebelum mengaktifkan jadwal pertama kali (atau setelah insiden),
   jalankan `bun run news-media:reconcile --dry-run` dulu untuk melihat
   kategori/jumlah TANPA mutasi apa pun:
   `healthy` / `orphanInDb` / `expiredPending` / `staleOrphaned` /
   `orphanInR2`. Output JSON (`itemCounts`) dan ringkasan satu baris
   dicetak ke stdout; `--json-output=<path>` untuk menyimpan ke file.
3. Bila `tenantsWithR2ListFailure > 0` di telemetry — outage/kredensial
   R2 sementara. Job TIDAK crash, TIDAK memblokir tenant lain, TIDAK
   perlu intervensi manual — coba lagi pada jadwal berikutnya. Bila
   berulang di banyak run berturut-turut, periksa kredensial
   `NEWS_MEDIA_R2_*`/status Cloudflare R2.

**Remediasi kategori `orphan-in-DB`** (baris DB mengharapkan objek R2
yang ternyata hilang — job ini TIDAK PERNAH memutasi baris ini secara
otomatis, murni laporan):

1. Identifikasi baris dari `orphanInDb` (objectId/objectKey/status)
   di log/telemetry (TIDAK PERNAH berisi signed URL/kredensial — hanya
   object key, yang tidak mengandung PII, §7).
2. Bila `status='attached'` — periksa apakah konten yang mereferensikan
   objek ini (`owner_resource_type`/`owner_resource_id`) sudah publish
   dengan gambar rusak; komunikasikan ke redaksi, minta re-upload
   gambar pengganti (attach ulang) atau unlink dari editorial UI.
3. Bila `status='uploaded'/'verified'` tanpa attach — kemungkinan
   upload yang gagal secara tidak normal (mis. proses R2 mati di
   tengah `finalize`); aman dihapus manual (soft delete lewat editorial
   UI/endpoint) karena belum pernah dipakai konten apa pun.
4. Tidak ada mekanisme auto-remediation di scope Issue #690 ini —
   keputusan tetap di tangan operator/editor, sesuai desain "jangan
   pernah memutasi baris yang berpotensi masih direferensikan tanpa
   keputusan manusia".

**Retensi/privasi**: job ini tidak menyimpan/menampilkan data baru di
luar yang sudah ada di §7 — telemetry hanya berisi `object_key`
(bukan PII), status, dan angka. `NEWS_MEDIA_R2_ORPHAN_GRACE_DAYS`
(default 30 hari, minimum 30 hari) mengikuti kebijakan retensi §3 yang
sama; mengubahnya di bawah minimum ditolak `config:validate`.

## 9. Referensi

- `full-online-r2-architecture.md` §16 (ISO 22301), §15 (ISO 27018/27701), §4 (env vars termasuk `NEWS_MEDIA_R2_ORPHAN_GRACE_DAYS`, Issue #690).
- `r2-security-checklist.md` §Monitoring & audit.
- `r2-incident-response.md` §Object exposure publik.
- `deploy/backup/README.md` — backup PostgreSQL yang sudah ada (metadata saja).
- `docs/awcms-mini/visitor-analytics.md` §Retensi — pola retensi bertingkat yang direplikasi di sini.
- `docs/awcms-mini/deployment-profiles.md` §Shared worker runner — `news-media:reconcile` sebagai salah satu job terdaftar.
