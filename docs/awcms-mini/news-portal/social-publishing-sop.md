# News Portal — Social Publishing SOP

SOP operasional untuk redaksi/admin tenant yang mengaktifkan auto
posting sosial (lihat
[`social-publishing-architecture.md`](social-publishing-architecture.md)
untuk arsitekturnya). Dokumen ini adalah panduan **operator/redaksi**,
bukan panduan implementasi kode.

## 1. Prasyarat sebelum mengaktifkan auto posting

- [ ] Deployment berjalan **full-online** dan
      `SOCIAL_PUBLISHING_ENABLED=true` +
      `SOCIAL_PUBLISHING_PROFILE=full_online` sudah diset operator
      platform (env-level, bukan sesuatu yang tenant ubah sendiri).
- [ ] `NEWS_MEDIA_R2_ENABLED=true` dan preset
      `news_portal_full_online_r2` sudah aktif untuk tenant (auto
      posting bergantung pada gambar R2 terverifikasi — lihat
      [`full-online-r2-architecture.md`](full-online-r2-architecture.md)).
- [ ] Tenant sudah punya domain utama **terverifikasi**
      (`is_primary = true AND status = 'active'` di
      `awcms_mini_tenant_domains`) — tanpa ini, job creation di-skip
      (`no_verified_domain`).
- [ ] Role yang akan mengoperasikan fitur ini punya permission yang
      sesuai (§6).

## 2. Checklist setup per provider

### 2.1 Meta — Facebook Page

- [ ] Buat/gunakan Meta App yang sudah lolos App Review untuk izin
      `pages_manage_posts`, `pages_read_engagement` (dan
      `instagram_content_publish` bila juga memakai Instagram, §2.2).
- [ ] Selesaikan alur OAuth Meta **di luar aplikasi ini** (tidak ada
      redirect OAuth built-in) untuk memperoleh Page Access Token
      jangka panjang.
- [ ] Simpan Page Access Token di secret storage operator, lalu
      isi form connect (`POST /api/v1/social-publishing/accounts`)
      dengan:
  - `providerKey`: `meta_facebook_page`
  - `providerAccountId`: Facebook Page ID
  - `providerAccountType`: `page`
  - `tokenReference`: referensi ke secret storage (mis.
    `"env:META_FB_PAGE_TOKEN_EXAMPLE"`), **bukan** token mentah.
- [ ] Set env operator: `META_PROVIDER_ENABLED=true`, `META_APP_ID`,
      `META_APP_SECRET_REFERENCE` (referensi, bukan secret asli),
      `META_GRAPH_API_VERSION`, `META_REQUIRED_SCOPES`.
- [ ] Jalankan `POST .../accounts/{id}/verify` untuk memastikan token
      valid dan benar-benar bisa akses Page target sebelum menyalakan
      `autoPublishEnabled`.

### 2.2 Meta — Instagram Business

- [ ] Akun Instagram **wajib** tipe **Business/Professional** yang
      terhubung ke Facebook Page yang sama — akun personal Instagram
      **ditolak** (ditegakkan di dispatcher DAN connect-time, lihat
      [`social-provider-limitations.md`](social-provider-limitations.md)
      §Meta).
- [ ] `providerAccountId` = Instagram Business Account ID (bukan
      username).
- [ ] Connect sebagai row **terpisah**: `providerKey`:
      `meta_instagram`, `providerAccountType`: `page` (IG Business
      tetap dipublish lewat Page access token, tidak ada tipe akun IG
      standalone di Meta API).
- [ ] Verify sebelum enable auto-publish (sama seperti §2.1).

### 2.3 LinkedIn — organization page

- [ ] Daftarkan LinkedIn App di LinkedIn Developer portal, lolos
      permintaan izin `w_organization_social`, `r_organization_social`,
      `rw_organization_admin`.
- [ ] Peran operator yang menghasilkan token **wajib** admin/anggota
      organisasi dengan hak posting — role ini dicek **live** pada
      setiap percobaan publish (tidak disimpan sebagai snapshot),
      karena role LinkedIn seorang member bisa dicabut kapan saja di
      sisi LinkedIn tanpa notifikasi ke aplikasi ini.
- [ ] `providerAccountId` **wajib** sudah berbentuk full URN
      (`urn:li:organization:{id}`) — adapter tidak mem-parsing/
      membangun URN sendiri.
- [ ] Set env operator: `LINKEDIN_PROVIDER_ENABLED=true`,
      `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET_REFERENCE`
      (referensi), `LINKEDIN_API_VERSION` (format `"YYYYMM"`),
      `LINKEDIN_OAUTH_REDIRECT_URI` (deskriptif untuk pendaftaran App
      saja — tidak ada redirect nyata di kode ini),
      `LINKEDIN_REQUIRED_SCOPES`.
- [ ] Connect manual lewat form generik (tidak ada endpoint
      "verify connection" HTTP terpisah untuk LinkedIn — `verifyCredentials()`
      diuji unit test, tapi acceptance criteria LinkedIn tidak meminta
      trigger manual via API).

### 2.4 Telegram — channel

- [ ] Buat bot lewat [@BotFather](https://core.telegram.org/bots)
      (di luar aplikasi ini), catat bot token.
- [ ] Tambahkan bot sebagai **administrator** channel target dengan
      izin **"Post Messages"** (`can_post_messages`) — tanpa ini,
      verify akan gagal dengan `missing_channel_permission`/
      `missing_post_permission`.
- [ ] Simpan bot token di secret storage operator, isi
      `TELEGRAM_BOT_TOKEN_SECRET_REFERENCE=env:MY_TELEGRAM_BOT_TOKEN_EXAMPLE`
      (referensi, bukan token asli).
- [ ] Set `TELEGRAM_PROVIDER_ENABLED=true`,
      `TELEGRAM_DEFAULT_PARSE_MODE` (unset = plain text/paling aman,
      atau `MarkdownV2`/`HTML` — **jangan** `Markdown` legacy, tidak
      didukung), `TELEGRAM_REQUEST_TIMEOUT_MS`.
- [ ] Connect: `providerKey`: `telegram_channel`, `providerAccountId`:
      chat ID/username channel.
- [ ] **Wajib** `POST .../accounts/{id}/verify` sebelum enable
      auto-publish — ini bukan hard gate API, tapi ditegakkan sebagai
      _readiness signal critical_ (`checkTelegramProviderReadiness`):
      akun `connected` dengan `autoPublishEnabled=true` tapi
      `lastVerifiedAt IS NULL` akan membuat `bun run security:readiness`
      gagal.

## 3. Menyalakan auto posting untuk sebuah artikel

1. Editor menyiapkan `awcms_mini_social_publish_rules` (per akun +
   trigger event, mis. `article_published`) dan opsional
   `awcms_mini_social_publish_templates` (caption).
2. Aktifkan `autoPublishEnabled` pada akun target (`PATCH
/api/v1/social-publishing/accounts/{id}`, permission
   `rules.configure` — **cukup** untuk toggle ini, tidak butuh
   `accounts.connect`/`.disconnect`, lihat §6).
3. Saat artikel publik dipublish (status `published`, visibility
   `public`/`unlisted`, tidak draft/private/archived/review/soft-deleted),
   job outbox dibuat otomatis untuk setiap rule yang cocok — **di
   dalam** transaksi publish yang sama (lihat arsitektur §5).
4. Bila rule mensyaratkan approval (`requires_approval`), job berhenti
   di status `pending`/`approved` snapshot menunggu editor menyetujui
   lewat `POST .../jobs/{id}/approve` (permission `jobs.approve`).
5. Dispatcher (`bun run social-publishing:dispatch`, dijadwalkan
   setiap 1-2 menit) memproses job due dan benar-benar memanggil
   provider.

## 4. Editorial approval workflow

- Rule dengan `requires_approval=true` **wajib** disetujui manusia
  sebelum dispatcher pernah memanggil provider untuk job itu —
  approval adalah gate di level DB (kolom status job), bukan
  konvensi UI yang bisa dilewati.
- Approval **tidak pernah** perlu diulang untuk retry — job yang gagal
  retryable kembali ke status snapshot semula (`pending`/`approved`),
  tidak pernah balik ke `requires_approval`.
- Setiap approval/cancel adalah endpoint bergerbang ABAC
  (`jobs.approve`/`jobs.cancel`) dan **wajib** `Idempotency-Key`
  (mutation high-risk).
- Redaksi yang ingin memposting artikel yang **sudah lama** publish
  (bukan reaksi otomatis ke event publish) harus memakai jalur
  `manual_editor_action` yang **sudah dimodelkan** di skema
  (`awcms_mini_social_publish_rules.trigger_event`) tapi **belum ada
  tombol UI "Post to X now"** di editor artikel hari ini — lihat
  [`social-publishing-architecture.md`](social-publishing-architecture.md)
  §11.

## 5. Retry & reauthorization SOP

### 5.1 Job gagal retryable (masih ada budget)

Tidak perlu tindakan operator — dispatcher otomatis mencoba lagi
sesuai jadwal backoff eksponensial. Pantau
`GET /api/v1/social-publishing/jobs?status=pending` untuk melihat job
yang sedang menunggu retry.

### 5.2 Job `failed` terminal (budget habis)

`retrySocialPublishJob` menolak retry manual bila
`attempt_count >= max_attempts`. Diagnosis penyebab (lihat
`awcms_mini_social_publish_attempts` untuk pesan error per percobaan —
sudah diredaksi, lihat
[`social-publishing-security-checklist.md`](social-publishing-security-checklist.md)),
perbaiki akar masalah (mis. rotasi token, perbaiki permission
channel), lalu buat job baru lewat trigger event asli atau eskalasi ke
tim implementasi bila diperlukan mekanisme requeue manual.

### 5.3 Akun `needs_reauth`

1. Akun otomatis flip ke `needs_reauth` ketika sebuah job dispatch
   gagal dengan sinyal token/kredensial tidak valid dari provider.
2. **Satu-satunya** jalur reauthorization: `POST
/api/v1/social-publishing/accounts` lagi dengan `providerKey` +
   `providerAccountId` yang sama (upsert) dan `tokenReference` baru
   yang valid — tidak ada endpoint "reauthorize" terpisah.
3. Jalankan `POST .../accounts/{id}/verify` untuk konfirmasi token
   baru benar-benar valid sebelum mengandalkan auto-posting lagi.
4. Job yang sudah `needs_reauth` **tidak** auto-requeue setelah
   reconnect — retry manual lewat `POST .../jobs/{id}/retry` untuk
   setiap job yang masih relevan (artikel masih ingin diposting).

## 6. Peran & permission (RBAC)

| Permission                              | Kemampuan                                                                                                             |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `social_publishing.accounts.read`       | Lihat daftar akun terhubung (tanpa token)                                                                             |
| `social_publishing.accounts.connect`    | Connect/reconnect akun — high-risk, menyentuh kredensial                                                              |
| `social_publishing.accounts.disconnect` | Disconnect akun (membersihkan `token_reference`) — high-risk                                                          |
| `social_publishing.accounts.verify`     | Trigger verifikasi kredensial akun (tidak menyentuh token)                                                            |
| `social_publishing.rules.read`          | Lihat rule dan template                                                                                               |
| `social_publishing.rules.configure`     | Buat/ubah/hapus rule dan template; **juga** menggerbang toggle `autoPublishEnabled` per akun (lihat catatan di bawah) |
| `social_publishing.jobs.read`           | Lihat job dan attempt                                                                                                 |
| `social_publishing.jobs.approve`        | Setujui job yang menunggu approval                                                                                    |
| `social_publishing.jobs.cancel`         | Batalkan job                                                                                                          |
| `social_publishing.jobs.retry`          | Retry manual job gagal/rate-limited/needs-reauth                                                                      |
| `social_publishing.logs.read`           | Lihat audit/attempt log                                                                                               |

**Catatan desain sengaja**: `PATCH /accounts/{id}` (toggle
`autoPublishEnabled`) digerbang `rules.configure`, bukan permission
`accounts.*` baru — role yang punya `rules.configure` bisa
menyalakan/mematikan auto-publish akun yang bukan ia hubungkan sendiri,
tapi **tidak pernah** menyentuh kredensial (`connect`/`disconnect`
tetap terpisah). Ini tradeoff yang disadari (reuse 10 permission tetap
issue #643, bukan menambah permission ke-11 hanya untuk satu field
boolean) — pertimbangkan ini saat menetapkan role redaksi vs admin.

## 7. Takedown/unpublish policy setelah posting sosial

Aplikasi ini **tidak pernah** mencoba menghapus/mengedit post yang
sudah terlanjur dipublikasikan ke platform sosial secara otomatis —
tidak ada mekanisme "unpublish dari Facebook/LinkedIn/Telegram" di
kode ini. Bila artikel sumber ditarik (unpublish/takedown) di
`blog_content` **setelah** job sosial sudah `published`:

1. Post di platform sosial **tetap ada** sampai dihapus manual oleh
   admin akun sosial tersebut, langsung di platform target
   (Meta Business Suite, LinkedIn, Telegram client) — di luar cakupan
   aplikasi ini.
2. `externalPostId`/`externalPostUrl` yang tersimpan di job (lihat
   `awcms_mini_social_publish_jobs`) adalah referensi yang dipakai
   admin untuk **menemukan** post tersebut secara manual, bukan untuk
   menghapusnya secara otomatis.
3. Redaksi **wajib** mendokumentasikan takedown lintas-platform sebagai
   bagian dari proses editorial takedown internal (bukan hanya
   menandai artikel sumber sebagai unpublished) — canonical URL yang
   sudah terlanjur tersebar di post sosial akan tetap mengarah ke
   artikel yang sekarang 404/unlisted sampai post sosialnya sendiri
   ditangani.
4. Jangan mengandalkan penghapusan job (`jobs.cancel`) sebagai bentuk
   takedown — `cancel` hanya mencegah job yang **belum** dispatch,
   tidak berpengaruh pada job yang sudah `published`.

## 8. Kapan TIDAK menggunakan fitur ini

- **WhatsApp** — jangan mencoba mengonfigurasi WhatsApp sebagai kanal
  auto posting/broadcast lewat mekanisme ini. Tidak ada adapter
  WhatsApp di modul `social_publishing`, dan ini **bukan** oversight —
  lihat
  [`social-provider-limitations.md`](social-provider-limitations.md)
  §WhatsApp untuk alasan lengkap.
- **Platform di luar 4 adapter terdaftar** (§2) — jangan mencoba
  memaksa `provider_key` bebas-format untuk platform yang belum punya
  adapter nyata; job akan langsung `failed` terminal
  (`provider_not_registered`).
- **Scraping/otomasi browser** — dilarang keras sebagai pengganti API
  resmi untuk platform apa pun (lihat
  [`social-publishing-security-checklist.md`](social-publishing-security-checklist.md)).

## 9. Dokumen terkait

- [`social-publishing-architecture.md`](social-publishing-architecture.md)
- [`social-provider-limitations.md`](social-provider-limitations.md)
- [`social-publishing-security-checklist.md`](social-publishing-security-checklist.md)
- [`social-sharing.md`](social-sharing.md)
