# News Portal — R2 Incident Response

Runbook insiden untuk media berita R2-only di mode **full-online**
(lihat [`full-online-r2-architecture.md`](full-online-r2-architecture.md)
§1 untuk asumsi — **tidak berlaku** untuk offline/LAN, yang tidak
mengaktifkan mode ini). Mencakup tiga skenario yang diminta Issue #631:
presigned URL bocor, object exposure publik, dan upload berbahaya.
Struktur mengikuti Detect → Contain → Eradicate → Recover → Post-incident,
konsisten dengan doc 20 §Batasan dan pola respons insiden lain di repo.

## 0. Peran & eskalasi

| Peran                           | Tanggung jawab dalam insiden ini                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------- |
| Operator/on-call                | Deteksi awal, eksekusi containment (rotasi kredensial, hapus objek), eskalasi.      |
| Admin tenant                    | Keputusan take-down konten publik yang terpengaruh, komunikasi ke editorial.        |
| Pemilik platform (multi-tenant) | Keputusan bila insiden lintas-tenant (kredensial platform-wide, mis. rotasi masal). |

Semua rotasi kredensial darurat dan tindakan penghapusan objek massal
**wajib** dicatat sebagai audit event `critical` (skill
`awcms-mini-audit-log`) dengan `correlationId` yang menghubungkan
seluruh langkah insiden untuk investigasi pasca-insiden.

## 1. Presigned upload URL bocor

**Contoh pemicu**: presigned URL ikut ter-log di layanan pihak ketiga
(browser devtools network log yang di-screenshot dan dibagikan, proxy
korporat yang mencatat URL penuh, dsb.) sebelum TTL habis.

### Detect

- Presigned URL yang sama dipakai untuk PUT dari IP/User-Agent yang
  jelas berbeda dari sesi editor yang menginisiasi (bila logging
  request R2 tersedia di sisi operator/Cloudflare).
- Objek `pending` dengan checksum yang tidak pernah cocok dengan
  klaim manapun dari sesi yang sah (indikasi seseorang mencoba PUT
  konten berbeda ke key yang bocor).

### Contain

1. **Tunggu TTL habis** (default 5 menit,
   `NEWS_MEDIA_R2_PRESIGNED_UPLOAD_TTL_SECONDS`) — presigned URL R2/S3
   tidak bisa dicabut manual sebelum TTL, jadi mitigasi utama adalah TTL
   pendek by design (`full-online-r2-architecture.md` §8).
2. Bila objek terlanjur ter-PUT dengan konten tidak sah oleh pemegang
   URL bocor: object key tersebut **tidak pernah** dianggap `confirmed`
   kecuali checksum-nya cocok klaim asli (§9 arsitektur) — pastikan
   baris metadata tetap `pending`/`rejected`, jangan pernah manual-force
   `confirmed`.
3. Hapus objek fisik dari R2 langsung (di luar jalur aplikasi normal,
   akses admin R2) bila isinya terbukti tidak sah.

### Eradicate

- Tidak perlu rotasi kredensial R2 untuk skenario ini **kecuali** URL
  yang bocor ternyata membawa informasi kredensial (bukan sekadar
  presigned URL biasa) — presigned URL yang benar tidak pernah
  menyertakan secret key mentah di dalamnya (hanya signature turunan),
  jadi kebocoran presigned URL saja **tidak** mengharuskan rotasi
  `NEWS_MEDIA_R2_SECRET_ACCESS_KEY`.

### Recover

- Editor mengulang upload dari langkah inisiasi (object key baru,
  presigned URL baru).

### Post-incident

- Catat di audit log: siapa yang menginisiasi upload asli, kapan URL
  diperkirakan bocor, tindakan containment.
- Bila pola berulang untuk identity/tenant yang sama → evaluasi apakah
  TTL perlu diperpendek lebih lanjut untuk tenant tersebut, atau
  edukasi operasional ke editor (`newsroom-user-guide.md`).

## 2. Object exposure publik (bucket/objek yang tidak seharusnya publik)

**Contoh pemicu**: objek `pending`/belum layak publish ternyata
diakses lewat custom domain publik sebelum `confirmed` (§8 arsitektur —
ini **residual risk yang sudah diketahui**, bukan bug baru: status
Postgres tidak mengontrol akses storage-level R2). Atau: kesalahan
konfigurasi CORS/bucket policy membuat bucket **sync-storage** yang
seharusnya privat menjadi bisa diakses publik (skenario lintas-modul,
lihat `full-online-r2-architecture.md` §2).

### Detect

- Laporan eksternal (mis. gambar yang belum dipublikasikan terlihat di
  URL publik) atau audit rutin (`r2-security-checklist.md` §Monitoring).
- Pemindaian berkala: bandingkan daftar `object_key` yang `confirmed`
  DAN direferensikan konten publik (`blog_content`) terhadap objek yang
  benar-benar reachable di custom domain — objek reachable yang tidak
  ada di kedua himpunan itu adalah kandidat exposure yang tidak
  diinginkan (`pending` lama, atau upload gagal `confirm`).

### Contain

1. **Bucket media berita**: karena publik-by-design, "object exposure"
   di sini secara spesifik berarti objek `pending`/tidak sah yang
   ter-expose sebelum waktunya — hapus objek fisik langsung dari R2
   (bukan sekadar ubah status Postgres, karena §8 sudah menegaskan
   status Postgres tidak mengontrol akses storage).
2. **Bucket sync-storage jadi publik (skenario lintas-modul, lebih
   serius)**: segera perbaiki konfigurasi bucket (cabut public access/
   custom domain yang salah pasang) di dashboard R2 — ini pelanggaran
   terhadap §2 arsitektur (segregasi bucket) dan **wajib** dianggap
   insiden kebocoran data tenant (bukan sekadar media), eskalasi ke
   pemilik platform.
3. Rotasi kredensial bucket yang terpengaruh (§`r2-security-checklist.md`
   §Kredensial) bila ada indikasi kredensial itu sendiri yang bocor
   (bukan hanya kesalahan konfigurasi).

### Eradicate

- Perbaiki root cause: kesalahan konfigurasi CORS/custom domain (§10/§11
  arsitektur) atau bug yang membuat objek `pending` tidak pernah
  dibersihkan lifecycle job (`r2-backup-lifecycle.md`).
- Bila root cause adalah bug aplikasi (mis. `confirm` gagal tapi objek
  tetap ter-upload dan tidak pernah dibersihkan) — perbaikan kode masuk
  issue tersendiri, bukan bagian dokumentasi ini.

### Recover

- Verifikasi ulang seluruh checklist §CORS/§Custom domain di
  `r2-security-checklist.md` untuk bucket yang terpengaruh.
- Jalankan ulang `bun run security:readiness` setelah perbaikan.

### Post-incident

- Dokumentasikan sebagai risiko residual yang **terealisasi** (bukan
  lagi hanya "diterima secara teoretis" — lihat §15 ISO 27005 di
  `full-online-r2-architecture.md`) — evaluasi apakah mitigasi
  (`NEWS_MEDIA_R2_PENDING_TTL_MINUTES`) perlu diperketat.

## 3. Upload berbahaya

**Contoh pemicu**: percobaan upload file dengan MIME dipalsukan
(mis. payload berbahaya di-rename `.jpg`), file SVG berisi script,
file berukuran ekstrem (zip-bomb-style), atau percobaan berulang dengan
checksum yang selalu mismatch (indikasi automated probing/scanning).

### Detect

- Tingkat penolakan validasi (§9 arsitektur) yang tidak wajar tinggi
  dari satu identity/IP dalam jendela waktu pendek.
- Percobaan upload MIME di luar allow-list (termasuk `image/svg+xml`)
  berulang.
- Checksum mismatch berulang dari identity yang sama pada `confirm`
  (indikasi mencoba menukar isi objek setelah klaim awal).

### Contain

- Validasi berlapis (§9 arsitektur) — termasuk `GET` penuh + MIME
  sniffing dari magic bytes saat `confirm`, bukan `HEAD` saja — dirancang
  untuk mencegah file berbahaya mencapai status `confirmed`/tereferensi
  publik **selama implementasi benar-benar menjalankan `GET`+sniffing di
  KEDUA jalur** (§9: tidak ada jalur pintas untuk Jalur A). Ini adalah
  kontrol yang wajib diverifikasi ada di kode (mis. lewat test integrasi
  yang meng-upload payload HTML/JS berkedok `.jpg`), bukan diasumsikan
  otomatis benar hanya karena didokumentasikan. Langkah containment
  tambahan berikut tetap **operasional**, bukan pengganti kontrol
  teknis di atas:
  - Objek yang tertolak validasi tetap ter-upload sementara ke R2 pada
    Jalur A (client PUT duluan, confirm menyusul) — pastikan lifecycle
    job (`r2-backup-lifecycle.md`) membersihkannya, jangan biarkan
    menumpuk.
  - Bila pola indikasi serangan aktif (bukan kesalahan pengguna biasa),
    pertimbangkan menonaktifkan sementara `news_media.upload` untuk
    identity yang bersangkutan (ABAC, aksi manual admin) sambil
    investigasi.
- Rate limiting endpoint upload (di luar cakupan dokumentasi ini secara
  spesifik — ikuti pola rate limit yang sudah ada di `lib/security/
rate-limit.ts` untuk endpoint sensitif lain) direkomendasikan sebagai
  kontrol tambahan saat Issue #634 mengimplementasikan endpoint ini.

### Eradicate

- Tidak ada "pembersihan sistem" khusus diperlukan bila validasi
  berfungsi seperti dirancang (file berbahaya tidak pernah confirmed/
  publik) — fokus eradication adalah memastikan **tidak ada** celah di
  urutan validasi (§9) yang terlewat untuk kasus spesifik yang memicu
  insiden ini (mis. tipe file baru yang lolos sniffing MIME karena bug).

### Recover

- Tidak ada dampak ke konten publik yang sudah ter-_confirmed_ (validasi
  berlapis mencegah file berbahaya pernah mencapai status itu).

### Post-incident

- Tambahkan signature/MIME baru ke daftar yang diblokir bila ditemukan
  teknik baru yang nyaris lolos, sebagai follow-up issue tersendiri
  (bukan revisi diam-diam ke dokumen arsitektur).
- Catat sebagai audit event `critical` bila identity tertentu
  dinonaktifkan sementara (§Contain di atas).

## 4. Referensi

- `full-online-r2-architecture.md` §8 (residual risk presigned URL/public
  object), §9 (validasi), §15 (pemetaan ISO 27005 risiko).
- `r2-security-checklist.md` §Monitoring & audit.
- `r2-backup-lifecycle.md` §Lifecycle objek pending.
- `SECURITY.md` (repo root) — kebijakan pelaporan kerentanan umum.
- `.claude/skills/awcms-mini-audit-log/SKILL.md` — pola audit event.
