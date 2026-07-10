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
- Job pembersihan ini mengikuti pola job terjadwal yang sudah ada di
  repo (`sync:objects:dispatch`, `analytics:purge`, dsb. — lihat
  `deployment-profiles.md` §Job registry lainnya): idempoten, aman
  dijalankan berulang, tidak menjadi dependency kritis alur upload itu
  sendiri (ADR-0006 — pembersihan adalah housekeeping, bukan bagian
  jalur upload sinkron).
- Implementor job ini (di luar cakupan Issue #631, kemungkinan bagian
  dari #633/#634) **wajib** menghapus objek fisik R2 **dan** baris
  metadata dalam urutan yang aman terhadap kegagalan parsial: hapus
  objek R2 dulu, baru hapus baris metadata (bila proses gagal di
  tengah, baris metadata `pending` basi tetap ada untuk retry
  berikutnya — kebalikan urutan ini bisa meninggalkan objek R2 yatim
  tanpa jejak metadata untuk retry).

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
menunjuknya. Implementasi konkret (di luar cakupan Issue #631):

- Job periodik membandingkan `object_key` berstatus `confirmed` terhadap
  seluruh titik referensi yang diketahui (bukan hanya `featuredMediaId`
  — juga block `gallery`/`video_news`, `ad.imageUrl` versi R2-only, SEO
  share image) — daftar titik referensi ini **wajib** diperbarui setiap
  kali issue lanjutan (#637-#640, #642, #649) menambah surface baru yang
  bisa menunjuk media registry, supaya deteksi orphan tidak pernah
  salah menandai objek yang sebenarnya masih dipakai.
- Objek yang tidak ditemukan di titik referensi mana pun selama masa
  tenggang (§3) ditandai `orphaned`, lalu dihapus fisik setelah masa
  tenggang berakhir tanpa referensi baru muncul.

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

## 8. Referensi

- `full-online-r2-architecture.md` §16 (ISO 22301), §15 (ISO 27018/27701).
- `r2-security-checklist.md` §Monitoring & audit.
- `r2-incident-response.md` §Object exposure publik.
- `deploy/backup/README.md` — backup PostgreSQL yang sudah ada (metadata saja).
- `docs/awcms-mini/visitor-analytics.md` §Retensi — pola retensi bertingkat yang direplikasi di sini.
