---
name: awcms-mini-news-portal
description: Kerjakan bagian mana pun dari epic news_portal AWCMS-Mini (Issue #631-#642, #649). Gunakan saat menambah/mengubah preset full-online R2-only, media object registry, presigned upload flow, R2 readiness checks, homepage composer, ad/video/quality-checklist berbasis media R2, tag linking, atau SEO/social preview `/news`. Merangkum keputusan arsitektur yang sudah dibuat (docs/awcms-mini/news-portal/) supaya issue lanjutan tidak mengulang/kontradiksi.
---

# AWCMS-Mini — News Portal (full-online R2-only media)

Epic `news_portal` (#631-#642, #649) menambah lapisan editorial +
media di atas `blog_content` (base module, sudah `active`) dan online
public routing (`tenant_domain`, ADR-0009/ADR-0010), khusus untuk
deployment **full-online** yang mengaktifkan mode **R2-only** untuk
gambar berita. Epic lanjutan `social-publishing` (#643-#647) **bergantung**
pada fondasi arsitektur epic ini (khususnya media registry #633 untuk
gambar yang dibagikan ke platform sosial) tapi **bukan** bagian tabel
status di bawah — lihat skill/dokumentasi terpisah begitu epic itu
mulai dikerjakan.

## Kapan pakai skill ini vs skill generik

Skill ini melengkapi (bukan menggantikan) `awcms-mini-new-endpoint`,
`awcms-mini-new-migration`, `awcms-mini-integration` (pola outbox/
circuit breaker untuk R2, ADR-0006), `awcms-mini-idempotency` (mutation
`confirm` upload), `awcms-mini-sensitive-data` (foto berpotensi PII),
`awcms-mini-abac-guard`, dan `awcms-mini-blog-content` (model konten
post/page/gallery/ads yang jadi konsumen media registry). Skill ini
menyediakan konteks **cross-cutting epic spesifik** — terutama
keputusan "R2-only, bucket terpisah dari sync-storage" yang wajib
dipertahankan setiap issue.

**Baca dulu** `docs/awcms-mini/news-portal/full-online-r2-architecture.md`
sebelum mengerjakan issue mana pun di epic ini — dokumen itu (bukan
skill ini) adalah sumber kebenaran arsitektur; skill ini merangkum
status + pointer, bukan menduplikasi isinya.

## Status per issue (jangan bangun ulang yang sudah ada)

| Issue | Scope                                                                                                                        | Status                                               |
| ----- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| #631  | Dokumentasi arsitektur full-online R2-only + SOP + security + IR + backup + user guide                                       | **Selesai** — lihat §Dokumen yang sudah ada di bawah |
| #632  | Preset `news_portal_full_online_r2` (module descriptor/config gate)                                                          | Belum dikerjakan — lihat §632 di bawah               |
| #633  | Tenant-scoped R2-only media object registry (schema + migration)                                                             | Belum dikerjakan — lihat §633 di bawah               |
| #634  | Direct-to-R2 presigned upload flow (endpoint upload/confirm)                                                                 | Belum dikerjakan — lihat §634 di bawah               |
| #635  | Config validation + readiness checks (`config:validate`/`security:readiness`/`production:preflight`) untuk R2 image delivery | Belum dikerjakan — lihat §635 di bawah               |
| #636  | `blog_content` wajib referensi R2 media object untuk gambar berita saat mode aktif                                           | Belum dikerjakan — lihat §636 di bawah               |
| #637  | Editorial homepage section composer `/news` dengan render R2-only                                                            | Belum dikerjakan — lihat §637 di bawah               |
| #638  | Preset placement iklan news portal dengan validasi gambar R2-only                                                            | Belum dikerjakan — lihat §638 di bawah               |
| #639  | Content block `video_news` dengan thumbnail R2 wajib                                                                         | Belum dikerjakan — lihat §639 di bawah               |
| #640  | Content quality checklist publishing dengan syarat gambar R2                                                                 | Belum dikerjakan — lihat §640 di bawah               |
| #641  | Automatic internal tag linking untuk konten post/news                                                                        | Belum dikerjakan — lihat §641 di bawah               |
| #642  | Public social share buttons di halaman artikel `/news`                                                                       | Belum dikerjakan — lihat §642 di bawah               |
| #649  | SEO + social preview metadata lengkap di halaman artikel `/news`                                                             | Belum dikerjakan — lihat §649 di bawah               |

Urutan dependency yang disarankan (dari objective masing-masing issue):
631 → 632 → 633 → 634 → 635 (readiness butuh #632-#634 ada untuk
divalidasi) → 636 (butuh #633 registry) → 637/638/639/640 (butuh #636,
bisa paralel satu sama lain) → 641 (independen, hanya butuh
`blog_content` taxonomies yang sudah ada) → 642/649 (butuh #636 untuk
gambar R2 yang valid dipakai preview sosial, bisa paralel).

## Yang sudah ada — pakai ulang, jangan re-derive

### Dokumen arsitektur (Issue #631, `docs/awcms-mini/news-portal/`)

Enam dokumen, semua docs-only (tidak ada kode/migration/endpoint di
issue ini):

- **`full-online-r2-architecture.md`** — dokumen utama. Berisi:
  ruang lingkup full-online-only (§1), keputusan **bucket R2 terpisah
  dari `sync-storage`** (§2 — lihat §Keputusan kunci di bawah), lima
  prinsip inti tidak bisa dinegosiasi (§3), konvensi env var
  `NEWS_MEDIA_R2_*` (§4, **belum** ada di `.env.example`/doc 18 — itu
  tugas #632/#633), model data konseptual media registry (§5), konvensi
  object key (§6), dua diagram alur upload (§7), lifecycle presigned
  URL (§8), urutan validasi MIME/ekstensi/checksum (§9), CORS (§10),
  custom domain (§11), Cache-Control (§12), rotasi kredensial (§13),
  diagram trust boundary (§14), dan pemetaan kepatuhan penuh ke
  ISO/IEC 27001/27002/27005/27017/27018/27701/27034, ISO 22301, OWASP
  ASVS, OWASP API Security Top 10 (§15).
- **`r2-upload-sop.md`** — SOP operasional Jalur A (direct-to-R2,
  disarankan) dan Jalur B (server-streaming tanpa temp file lokal),
  urutan validasi, penanganan error, troubleshooting operator.
- **`r2-security-checklist.md`** — checklist siap-pakai (validasi,
  object key, presigned URL, CORS, custom domain/cache, kredensial,
  readiness gates, monitoring) + contoh kebijakan API token R2
  least-privilege. §7 checklist ini eksplisit menyatakan **belum ada**
  check nyata di `config:validate`/`security:readiness` untuk news
  media sampai #635 mengimplementasikannya — jangan klaim readiness
  sudah ditegakkan sebelum #635 selesai.
- **`r2-incident-response.md`** — runbook Detect/Contain/Eradicate/
  Recover/Post-incident untuk tiga skenario: presigned URL bocor,
  object exposure publik, upload berbahaya.
- **`r2-backup-lifecycle.md`** — lifecycle objek `pending` (TTL default
  60 menit), retention policy per klasifikasi data, deteksi objek
  `orphaned`, strategi backup (replikasi/versioning — pilihan operator,
  bukan mandat tunggal), kontinuitas (RPO/RTO), privasi/minimisasi.
- **`newsroom-user-guide.md`** — panduan editor/jurnalis (bukan
  developer): cara upload, format/ukuran didukung, pesan error umum,
  praktik terbaik privasi/atribusi, ke mana gambar dipakai.

Test: tidak ada (docs-only, tidak ada acceptance criteria berupa
kode/test di issue #631). Validasi: `bun run lint`, `bun run check:docs`,
`bun run build`.

### Keputusan kunci #1 — bucket R2 terpisah dari `sync-storage` (WAJIB dipertahankan)

`src/modules/sync-storage/` sudah memakai R2 sejak Issue 6.3/#436
(`R2_ENABLED`/`R2_ACCOUNT_ID`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`/
`R2_BUCKET`) sebagai **object queue privat** untuk sinkronisasi
offline/LAN (lampiran/receipt, machine-to-machine via HMAC). News
portal media adalah kebutuhan yang **fundamental berbeda** — publik,
diakses browser, custom domain, CORS untuk direct-upload. **Jangan
pernah** menyatukan keduanya ke bucket/kredensial yang sama:

- Bucket berbeda mencegah kesalahan konfigurasi publik (CORS/custom
  domain) di satu fungsi membocorkan objek privat fungsi lain.
- Kredensial berbeda membatasi blast radius — kompromi token media
  publik (bucket yang memang sudah publik) tidak pernah memberi akses
  tulis ke objek sync privat, dan sebaliknya.
- Konvensi penamaan env var **`NEWS_MEDIA_R2_*`** (bukan `R2_*` yang
  sudah dipakai) — lihat `full-online-r2-architecture.md` §4 untuk
  daftar lengkap yang wajib diikuti implementor persis apa adanya.
- Cloudflare **account** boleh sama (satu akun, dua bucket) — yang
  wajib terpisah adalah bucket dan API token, bukan akun.

Issue #632/#633 **wajib** menambahkan validasi eksplisit bahwa
`NEWS_MEDIA_R2_BUCKET` ≠ `R2_BUCKET` (dan kredensial keduanya berbeda)
di `config:validate`/`security:readiness` — jangan hanya
mendokumentasikan tanpa menegakkan (lihat `r2-security-checklist.md` §7
untuk kontrak lengkap yang wajib dipenuhi #635).

### Keputusan kunci #2 — tidak ada fallback lokal, tidak ada temp file

Mode ini (bila `NEWS_MEDIA_R2_ENABLED=true`) **tidak pernah** menulis
bytes gambar ke `LOCAL_STORAGE_PATH`/disk lokal server sebagai
pengganti R2 — baik sebagai fallback kegagalan maupun sebagai file
sementara di tengah proses upload (`full-online-r2-architecture.md`
§3.3/§3.4, `r2-upload-sop.md` §2/§3). Ini kebalikan dari `sync-storage`
(yang memang menyimpan lokal dulu, upload R2 belakangan via dispatcher
— desain yang benar untuk kasus offline-first-nya). Implementor #634
**wajib** memverifikasi tidak ada `Bun.write(tempPath, ...)`/
`fs.writeFile` perantara di jalur upload manapun sebelum PR dianggap
selesai.

### Keputusan kunci #3 — object key tidak pernah berisi PII/nama file asli

Format wajib: `news-media/{tenantId}/{yyyy}/{mm}/{uuid}.{ext}` — `uuid`
dari `crypto.randomUUID()`, `ext` **diturunkan dari MIME tervalidasi**
(bukan ekstensi asli client). `original_filename` tetap disimpan
sebagai kolom metadata terpisah untuk tampilan, tidak pernah masuk key
(`full-online-r2-architecture.md` §6). Implementor #633 (schema) dan
#634 (endpoint) wajib mengikuti format ini persis.

### Keputusan kunci #4 — status `pending`/`confirmed` tidak mengontrol akses storage

Residual risk yang sudah didokumentasikan dan **wajib** terus
dipertahankan setiap issue lanjutan: begitu objek ter-PUT sukses ke R2,
ia langsung reachable publik lewat custom domain — status Postgres
`pending` **tidak** memblokir pembacaan storage-level
(`full-online-r2-architecture.md` §8). Mitigasi: object key tidak bisa
ditebak (Keputusan #3), konten editorial tidak pernah menunjuk objek
`pending` (hanya `confirmed`), dan lifecycle job membersihkan objek
`pending` basi (`r2-backup-lifecycle.md` §2, `NEWS_MEDIA_R2_PENDING_TTL_MINUTES`
default 60 menit). Jangan mengimplementasikan kontrol yang mengasumsikan
status Postgres sudah cukup untuk mencegah akses publik — bila
implementor #634 menemukan cara menegakkan ACL per-objek R2 yang nyata,
itu peningkatan yang harus didokumentasikan sebagai penggantian
keputusan ini, bukan diam-diam diasumsikan sudah ada.

### Keputusan kunci #5 — `image/svg+xml` dilarang default

MIME allow-list default (`full-online-r2-architecture.md` §4/§9):
`image/jpeg, image/png, image/webp, image/gif`. SVG sengaja tidak
termasuk karena risiko XSS (script tersemat). Mengizinkannya butuh
pipeline sanitasi khusus dan keputusan terpisah — bukan sekadar
menambah ke allow-list di issue mana pun.

## §632 — Preset `news_portal_full_online_r2` (belum dikerjakan)

Ringkasan scope dari objective issue: menambah preset yang
mengkonfigurasi AWCMS-Mini untuk news portal full-online, gambar
hanya di R2. Implementor **wajib**:

- Memakai env var persis sesuai `full-online-r2-architecture.md` §4
  (`NEWS_MEDIA_R2_*`), menambahkannya ke `.env.example` dan
  `18_configuration_env_reference.md` (belum ada di kedua tempat itu
  sampai issue ini).
- Preset ini **tidak** mengubah default deployment offline/LAN/base
  generik apa pun — hanya aktif untuk tenant/deployment yang eksplisit
  mengaktifkannya (§1 arsitektur).
- Perbarui baris status tabel di atas menjadi **Selesai** dan tambahkan
  subbagian `### §632 — ...` (pola sama subbagian lain di bawah) begitu
  selesai — jangan hanya mengubah kata "Belum dikerjakan" tanpa
  merangkum keputusan konkret yang dibuat.

## §633 — Media object registry (belum dikerjakan)

Ringkasan scope: tabel tenant-scoped R2-only media registry dipakai
`blog_content`, homepage section, galeri, ads, gambar SEO, thumbnail
video. Implementor **wajib** mengikuti bentuk konseptual
`full-online-r2-architecture.md` §5 (kolom, tidak ada binary),
konvensi object key §6, dan migration lewat skill
`awcms-mini-new-migration` (RLS `ENABLE`+`FORCE`, pola sama tabel
tenant-scoped lain).

## §634 — Direct-to-R2 presigned upload flow (belum dikerjakan)

Ringkasan scope: endpoint upload presigned + confirm (Jalur A) dan/atau
server-streaming (Jalur B) sesuai `r2-upload-sop.md` §2/§3. Implementor
**wajib**: `Idempotency-Key` untuk langkah `confirm` (skill
`awcms-mini-idempotency`), panggilan R2 di luar DB transaction
(ADR-0006), circuit breaker + timeout (pola sama `object-storage`
breaker `sync-storage` sudah pakai), validasi berlapis persis urutan
`full-online-r2-architecture.md` §9.

## §635 — Readiness checks (belum dikerjakan)

Ringkasan scope: `config:validate`, `security:readiness`,
`production:preflight` untuk R2 image delivery. Kontrak lengkap yang
wajib dipenuhi: `r2-security-checklist.md` §7 (termasuk penegakan
`NEWS_MEDIA_R2_BUCKET` ≠ `R2_BUCKET`, kredensial berbeda, SVG tidak di
allow-list kecuali override eksplisit). Implementor **wajib**
memperbarui `r2-security-checklist.md` §7 begitu check nyata ditulis
(ganti "belum ada" jadi nama fungsi/test).

## §636 — `blog_content` wajib referensi R2 media (belum dikerjakan)

Ringkasan scope: featured image, block gallery, gambar SEO, dan
surface gambar blog/news lain **wajib** menunjuk baris
`status='confirmed'` di media registry (#633) ketika mode R2-only aktif
— menerapkan Keputusan kunci #4 di atas ke `blog_content` yang sudah
ada (yang saat ini, sebelum issue ini, memakai `featuredMediaId` sebagai
UUID longgar tanpa FK dan URL bebas `isAbsoluteHttpUrl` untuk gallery —
lihat `src/modules/blog-content/README.md` §Media/Gallery). Implementor
**wajib** membaca subbagian itu untuk memahami perilaku sebelum issue
ini (tidak ada FK, tidak ada media library nyata) yang akan diganti.

## §637-#640, #642, #649 — konsumsi media registry (belum dikerjakan)

Ringkasan objective per issue (detail lengkap ada di body issue
GitHub masing-masing, cek `gh issue view <n>` bila butuh acceptance
criteria penuh):

- **#637** — homepage section composer `/news` dengan render R2-only
  (gambar section harus dari media registry, bukan URL bebas).
- **#638** — preset placement iklan dengan validasi gambar R2-only
  (memperluas `awcms_mini_blog_ads`'s `image_url` yang saat ini bebas
  URL http(s) — lihat `blog-content` README §Ads).
- **#639** — content block `video_news` baru dengan thumbnail R2 wajib
  (thumbnail, bukan video itu sendiri, yang wajib R2 — video hosting
  eksternal seperti YouTube/embed kemungkinan tetap di luar cakupan R2,
  cek body issue untuk detail persis sebelum implementasi).
- **#640** — content quality checklist publishing dengan syarat gambar
  R2 (mis. featured image wajib ada + confirmed sebelum status
  `published` diizinkan).
- **#642** — social share buttons publik di `/news` dengan canonical
  URL aman + Open Graph/Twitter Card + privacy-conscious.
- **#649** — SEO + social preview metadata lengkap (title/excerpt/
  canonical/gambar R2 terverifikasi) untuk crawler share.

Semua issue ini **wajib** mengonsumsi media registry (#633) dan validasi
`confirmed`-only (#636) — bukan re-derive validasi URL/MIME sendiri.

## §641 — Automatic internal tag linking (belum dikerjakan)

Ringkasan scope: auto-linking tag/taxonomy di dalam konten post/news
memakai tag/taxonomy yang **sudah ada** (`blog_content`'s
`awcms_mini_blog_terms`), sambil menjaga kontrol editorial, keamanan
SEO, aksesibilitas, dan keamanan rendering. **Tidak terkait R2/media**
secara langsung — item ini ada di epic yang sama karena sama-sama
bagian pengalaman editorial `news_portal`, tapi tidak bergantung pada
Keputusan kunci #1-#5 di atas. Implementor wajib tetap memakai whitelist
renderer yang sama (`content-block-rendering.ts`) — auto-linking tidak
boleh membuka jalur raw-HTML baru (lihat `blog-content` README
§Rendering publik tetap aman dari XSS).

## Prinsip yang wajib dipertahankan di setiap issue lanjutan

1. **Full-online-only, opt-in eksplisit** — tidak ada perilaku epic ini
   yang aktif default untuk deployment yang tidak eksplisit mengaktifkan
   preset (#632). Offline/LAN tidak boleh terpengaruh sama sekali.
2. **R2-only untuk binary, Postgres untuk metadata** — tidak ada kolom
   binary baru di tabel manapun epic ini menyentuh.
3. **Tidak ada fallback filesystem lokal, tidak ada temp file lokal** —
   lihat Keputusan kunci #2.
4. **Bucket + kredensial R2 media terpisah dari `sync-storage`** — lihat
   Keputusan kunci #1. Ini bukan saran, ini penegakan wajib di
   `config:validate`/`security:readiness` (#635).
5. **Object key: UUID + tanggal + tenant, tidak pernah nama file/PII** —
   lihat Keputusan kunci #3.
6. **Status Postgres bukan kontrol akses storage** — lihat Keputusan
   kunci #4, jangan berasumsi sebaliknya di kode/dokumentasi baru.
7. **SVG dilarang default** — lihat Keputusan kunci #5.
8. **Konten editorial hanya boleh menunjuk media `confirmed`** — dari
   #636 dan seterusnya; jangan re-derive aturan URL bebas lama.

## Referensi

- `docs/awcms-mini/news-portal/full-online-r2-architecture.md` — arsitektur lengkap + pemetaan kepatuhan.
- `docs/awcms-mini/news-portal/r2-upload-sop.md` — SOP upload.
- `docs/awcms-mini/news-portal/r2-security-checklist.md` — checklist keamanan.
- `docs/awcms-mini/news-portal/r2-incident-response.md` — runbook insiden.
- `docs/awcms-mini/news-portal/r2-backup-lifecycle.md` — backup/lifecycle/retensi.
- `docs/awcms-mini/news-portal/newsroom-user-guide.md` — panduan editor.
- `src/modules/sync-storage/README.md` — R2 usage yang sudah ada (bucket terpisah, Keputusan kunci #1).
- `src/modules/blog-content/README.md` §Media/Gallery, §Ads — perilaku sebelum #636 mengubahnya.
- `docs/adr/0006-offline-first-sync-outbox.md` — provider eksternal opsional/di luar transaksi.
- `docs/awcms-mini/deployment-profiles.md` §News portal — ringkasan per profil deployment.
- `AGENTS.md` skill table.
