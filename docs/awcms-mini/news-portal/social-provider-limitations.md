# News Portal — Social Provider Limitations

Batasan nyata per platform untuk auto posting (bukan share manual —
lihat [`social-sharing.md`](social-sharing.md) untuk itu). Dokumen ini
mendeskripsikan **perilaku yang benar-benar terimplementasi** di
`src/modules/social-publishing/`, bukan rencana/aspirasi. Untuk
arsitektur umum, lihat
[`social-publishing-architecture.md`](social-publishing-architecture.md).

## 1. Meta — Facebook Page

- **Tipe akun**: hanya **Page** — akun profil personal Facebook
  **ditolak**, ditegakkan di **dua lapis**: (1) connect-time
  (`POST /accounts`, `422 SOCIAL_ACCOUNT_UNSUPPORTED_TYPE`), dan (2)
  dispatch-time (`social-publish-dispatch.ts`, sebelum
  `adapter.publish()` dipanggil, job gagal terminal
  `unsupported_account_type`, `retryable: false`). Lapis kedua ini
  yang benar-benar menutup celah — lapis pertama saja bisa dilewati
  bila data lolos masuk lewat jalur lain.
- **Jenis post**: link post ke `/{page-id}/feed` — bukan foto/video
  native upload untuk Facebook Page (gambar disertakan sebagai bagian
  metadata link preview, bukan attachment foto terpisah).
- **Idempotensi**: Graph API **tidak** punya parameter idempotency-key
  native untuk `/feed`. Adapter ini **tidak** mengimplementasikan
  dedup sendiri — memanggil `publish()` dua kali dengan
  `idempotencyKey` yang sama tetap menghasilkan dua panggilan Graph API
  independen. Pencegahan duplikat nyata sepenuhnya berasal dari
  transisi status job outbox (`pending`/`approved` → `publishing` →
  `published`, tidak pernah diklaim ulang) — bukan sesuatu yang
  diklaim diimplementasikan di level adapter.
- **Error message**: pesan error asli Meta (`error.message`/
  `fbtrace_id`) **tidak pernah** diteruskan verbatim ke log/response —
  dipetakan ke katalog pesan tetap (`meta_oauth_exception_190`,
  `meta_permission_error_10`, `meta_rate_limited_32`, dst.).
- **Token**: hanya skema referensi `env:VAR_NAME` yang benar-benar bisa
  diresolusi — prefix lain (`secretsmanager:`/`vault:`/dst.) diterima
  sebagai bentuk yang sah tapi gagal resolve (`needs_reauth`, fail
  closed, bukan throw).
- **Di luar cakupan**: Stories/Reels, sinkronisasi metrik sosial
  (likes/comments), moderasi komentar — tidak diimplementasikan sama
  sekali.

## 2. Meta — Instagram Business

- **Tipe akun**: hanya Instagram **Business/Professional**, **wajib**
  terhubung ke Facebook Page — akun personal Instagram ditolak (sama
  dua lapis dengan §1). Tidak ada tipe akun IG standalone di Meta API;
  `providerAccountType` untuk `meta_instagram` selalu `"page"`.
- **Alur publish**: 2 panggilan Graph API berurutan (buat media
  container di `/{ig-user-id}/media`, lalu publish di
  `.../media_publish`) — **wajib** ada gambar (media container tidak
  bisa dibuat tanpa gambar untuk feed post Instagram standar); artikel
  tanpa gambar terverifikasi R2 **tidak bisa** diposting ke Instagram
  lewat adapter ini (berbeda dari Facebook Page/LinkedIn yang bisa
  degradasi ke post teks/link).
- **Gambar**: hanya dari objek R2 terverifikasi (`NEWS_MEDIA_R2_*`) —
  gambar eksternal/lokal ditolak sebelum panggilan API terjadi.
- **Idempotensi & error handling**: sama seperti §1 (tidak ada
  idempotency-key native, katalog error tetap).
- **Di luar cakupan**: Stories/Reels Instagram, carousel multi-gambar,
  publish video.

## 3. LinkedIn — organization page

- **Tipe akun**: `linkedin_organization` — `providerAccountId`
  **wajib** sudah berupa full URN (`urn:li:organization:{id}`).
  Adapter **tidak** mem-parsing/membangun URN dari ID mentah.
- **Role organisasi dicek LIVE, tidak disimpan sebagai snapshot** —
  role LinkedIn seorang member (admin org) bisa dicabut kapan saja di
  sisi LinkedIn tanpa notifikasi ke aplikasi ini; menyimpan snapshot
  lama berisiko memberi rasa aman palsu. Adapter memanggil
  `organizationAcls` **pada setiap percobaan publish**, bukan hanya
  sekali saat connect.
- **Tidak ada alur OAuth interaktif** — berbeda dari
  `google-oauth-client.ts` (redirect flow nyata), adapter ini **tidak**
  membangun redirect OAuth LinkedIn. Connect tetap manual/operator-
  driven lewat form generik yang sama seperti provider lain.
  `LINKEDIN_CLIENT_ID`/`_OAUTH_REDIRECT_URI` hanya mendeskripsikan
  LinkedIn App yang didaftarkan operator di LinkedIn Developer portal
  (syarat app-review), bukan endpoint nyata di kode ini.
- **Gambar**: Images API asli LinkedIn (`initializeUpload` → fetch
  bytes → `PUT`), digerbang cek trust R2 (`isTrustedR2MediaUrl`) —
  **lebih lemah dari cek Meta**: hanya `url.startsWith(publicBaseUrl)`
  (prefix/substring check biasa), **bukan** pengecekan host persis
  seperti Meta's `isAcceptableProviderMediaUrl` (host dibandingkan
  lewat `new URL()`, lihat
  [`social-publishing-architecture.md`](social-publishing-architecture.md)
  §8) — tidak melakukan `new URL()` parse, tidak membandingkan host,
  tidak memvalidasi protokol. Ini defense-in-depth titik-terakhir saja
  (data sudah diverifikasi lebih dulu di hulu oleh
  `create-social-publish-jobs.ts`), bukan satu-satunya lapisan
  proteksi, tapi belum di-hardening ke pola exact-host yang sama —
  dicatat sebagai gap nyata, bukan sesuatu yang sudah setara Meta.
  **Gambar tidak esensial** — kegagalan APA PUN saat upload (tidak
  terpercaya, tidak ada, error jaringan) terdegradasi baik ke post
  link-share (`content.article`), tidak pernah memblokir publish yang
  sah.
- **Idempotensi**: `idempotencyKey` diteruskan sebagai header
  `X-Idempotency-Key` — **best-effort**, LinkedIn tidak
  mendokumentasikan mekanisme idempotency resmi untuk Posts API
  sejauh yang diketahui. Jaminan nyata tetap dari outbox (job
  `published` tidak pernah di-dispatch ulang).
- **Tidak ada endpoint verify HTTP khusus** — `verifyCredentials()`
  diimplementasikan penuh dan diuji unit test, tapi tidak digerbang ke
  endpoint HTTP baru (acceptance criteria issue #645 tidak
  memintanya) — hanya connect/disconnect generik yang tersedia lewat
  API.
- **Di luar cakupan**: publish sebagai member individu (bukan
  organization page), video native LinkedIn, artikel LinkedIn (native
  long-form), sinkronisasi metrik.

## 4. Telegram — channel

- **Permission bot yang wajib**: bot **harus** ditambahkan sebagai
  **administrator** channel target dengan izin **"Post Messages"**
  (`can_post_messages`). `verifyCredentials` memanggil `getMe` lalu
  `getChatMember` — gagal dengan `missing_channel_permission` bila
  status bukan administrator/creator, atau `missing_post_permission`
  bila administrator tapi `can_post_messages: false`.
- **Format pesan**: default plain text (tidak pernah kirim
  `parse_mode` sama sekali kecuali eksplisit diset) — title/excerpt
  user-authored yang mengandung karakter markdown-like tetap
  diperlakukan literal. Bila operator set `MarkdownV2`/`HTML`, setiap
  field yang diinterpolasi di-escape (single-pass regex, termasuk
  backslash dalam character class yang sama — lihat
  [`social-publishing-security-checklist.md`](social-publishing-security-checklist.md)
  §Lessons untuk detail kelas bug yang dihindari). **`Markdown` legacy
  (bukan `MarkdownV2`) sengaja tidak didukung.**
- **Tidak pernah membangun tautan inline Markdown dari data
  pengguna** — canonical URL selalu baris teks polos yang diescape,
  dibiarkan Telegram auto-link-detect sendiri.
- **Hashtag dari tag artikel** — fungsi ada (`buildTelegramHashtags`)
  dan diuji standalone, **tapi belum dipakai nyata** karena snapshot
  job outbox tidak punya kolom nama tag; `publish()` selalu memanggil
  dengan array hashtag kosong hari ini.
- **Gambar**: tidak mengirim `sendPhoto`/preview gambar R2 — scope
  awal hanya post teks/link via `sendMessage` (sesuai izin eksplisit
  di body issue #646).
- **Verifikasi bukan hard gate runtime** — mengaktifkan auto-publish
  tanpa verify dulu **tidak** diblokir API, tapi akan membuat `bun run
security:readiness` gagal (critical) karena
  `checkTelegramProviderReadiness` mendeteksi akun `connected` +
  `autoPublishEnabled=true` dengan `lastVerifiedAt IS NULL`.
- **Token di URL path** — Bot API menaruh token di path URL
  (`.../bot<TOKEN>/<method>`, satu-satunya transport dari Telegram
  sendiri). Mitigasi: token hanya pernah ada di satu scope lokal,
  `response.url` (yang merefleksikan URL akhir termasuk token) tidak
  pernah dibaca, parameter dikirim sebagai JSON body bukan query
  string.

## 5. Instagram — manual share (bukan auto posting)

Instagram **tidak punya** endpoint share-intent web resmi untuk
membagikan URL eksternal sembarang. Untuk **share manual** (fitur
berbeda dari auto posting, lihat [`social-sharing.md`](social-sharing.md)):

- Tidak ada tombol/URL "share ke Instagram" — hanya native share sheet
  (`navigator.share`, bila OS pembaca menampilkan Instagram sebagai
  target) atau copy-link.
- **Jangan** membangun URL web-feed-share Instagram buatan sendiri
  sebagai pengganti — tidak ada URL semacam itu yang didukung resmi,
  dan mengklaimnya akan menyesatkan pengguna.

Untuk **auto posting**, Instagram didukung penuh lewat provider
`meta_instagram` (§2 di atas) — hanya untuk akun Business/Professional,
bukan personal.

## 6. WhatsApp — share manual saja, TIDAK ADA auto posting

**WhatsApp bukan kanal auto-posting di epic ini, dan ini bukan
oversight.**

- **Share manual** (`https://wa.me/?text=...`) **didukung penuh** —
  lihat [`social-sharing.md`](social-sharing.md) §2. Ini adalah
  pembaca yang membagikan link dari browser mereka sendiri, bukan
  tindakan sistem.
- **Auto posting/broadcast WhatsApp TIDAK diimplementasikan dan TIDAK
  direncanakan** sebagai kanal `social_publishing` — tidak ada
  `provider_key` `whatsapp_*` yang terdaftar di
  `social-provider-registry.ts`, dan tidak ada rencana menambahkannya
  dalam bentuk ini.
- **Alasan**: memposting/broadcast pesan WhatsApp tanpa opt-in
  eksplisit penerima adalah **pesan tidak diminta** (unsolicited
  messaging) — berbeda fundamental dari posting ke feed publik
  (Facebook/Instagram/LinkedIn/Telegram channel, yang semuanya
  bersifat "pull", pengikut memilih mengikuti). WhatsApp Business API
  resmi mensyaratkan **template pesan pra-disetujui** dan **consent/
  opt-in** eksplisit per nomor penerima untuk pesan di luar jendela
  layanan 24 jam — model ini secara struktural berbeda dari "post
  sekali ke satu akun/channel publik" yang menjadi asumsi desain
  seluruh modul `social_publishing` (satu row akun = satu tujuan
  publish, satu job = satu post publik).
- **Jangan** mencoba memaksakan WhatsApp ke dalam mekanisme
  `social_publishing` yang ada (mis. mendaftarkan `provider_key`
  `whatsapp_broadcast` yang mem-broadcast artikel baru ke daftar
  kontak) — ini akan menjadi kanal notifikasi massal tanpa
  consent-tracking, bukan variasi dari fitur yang sudah ada.
- **Jalur yang benar bila dibutuhkan ke depan**: sebuah **use case
  WhatsApp Business messaging yang terpisah**, dirancang eksplisit
  dengan model consent/opt-in per penerima, template pesan
  pra-disetujui, dan jendela layanan — bukan perluasan modul
  `social_publishing` ini. Ini eksplisit di luar cakupan epic
  `social_publishing` (#643-#647) dan tidak dibahas lebih lanjut di
  dokumen ini.

## 7. Batasan lintas-provider (berlaku untuk semua adapter)

- **Tidak ada integrasi secret-manager nyata** — semua adapter hanya
  mendukung resolusi `token_reference`/secret-reference lewat skema
  `env:VAR_NAME`; prefix lain (`secretsmanager:`/`vault:`/`kms:`/
  `ssm:`) lolos validasi bentuk tapi dilaporkan tidak bisa diresolusi
  (`needs_reauth`).
- **Tidak ada auto-requeue** job `needs_reauth` setelah akun
  reconnect — retry manual wajib per job.
- **Tidak ada sinkronisasi metrik sosial** (likes/comments/reach) dari
  platform manapun ke aplikasi ini.
- **Tidak ada moderasi komentar sosial**.
- **`provider_key` bebas-format** — mendaftarkan provider baru tidak
  butuh migration, tapi juga berarti **tidak ada** validasi semantik
  di level DB bahwa sebuah `provider_key` benar-benar punya adapter
  terdaftar; job untuk `provider_key` tanpa adapter langsung `failed`
  terminal (`provider_not_registered`).

## 8. Dokumen terkait

- [`social-publishing-architecture.md`](social-publishing-architecture.md)
- [`social-publishing-sop.md`](social-publishing-sop.md)
- [`social-publishing-security-checklist.md`](social-publishing-security-checklist.md)
- [`social-sharing.md`](social-sharing.md)
