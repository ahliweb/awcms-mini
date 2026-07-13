# News Portal — Social Sharing (Manual)

Dokumen ini menjelaskan fitur **social sharing manual** (Issue #642,
epic `news_portal`) — tombol yang membiarkan **pembaca** membagikan satu
artikel ke platform sosial pilihan mereka sendiri. Ini **BUKAN** fitur
auto-posting: lihat
[`social-publishing-architecture.md`](social-publishing-architecture.md)
untuk sistem terpisah yang memposting artikel secara otomatis atas nama
tenant/redaksi.

## 1. Manual share vs auto posting — perbedaan mendasar

| Aspek                       | Social sharing (dokumen ini)                                                 | Social publishing / auto posting                                                                  |
| --------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Siapa yang memposting       | **Pembaca**, dari browser mereka sendiri                                     | **Aplikasi**, atas nama akun media sosial tenant                                                  |
| Kredensial/token            | Tidak ada — tombol hanya membuka URL share-intent publik atau share sheet OS | `token_reference` per akun, disimpan di `awcms_mini_social_accounts`                              |
| Panggilan API eksternal     | Tidak ada — browser pembaca yang membuka tab/aplikasi platform target        | Ya — server memanggil Graph API/LinkedIn API/Telegram Bot API atas nama tenant                    |
| Modul                       | `blog-content`/`news-portal` (domain `social-share-links.ts`,                | `social-publishing` (lihat `social-publishing-architecture.md`)                                   |
|                             | `news-share-config.ts`)                                                      |                                                                                                   |
| Butuh approval/audit outbox | Tidak — bukan tindakan sistem                                                | Ya — job outbox, approval opsional, audit trail per-attempt                                       |
| Data baru dipersist         | Tidak — murni rendering, tidak ada migration baru                            | Ya — 6 tabel (`awcms_mini_social_accounts`/`_rules`/`_templates`/`_jobs`/`_attempts`/`_settings`) |

Kedua fitur ini **independen satu sama lain**: sebuah tenant boleh
mengaktifkan tombol share manual tanpa pernah mengaktifkan auto-posting,
dan sebaliknya. Tidak ada dependency kode antara `social-share-links.ts`
dan modul `social-publishing`.

## 2. Target platform yang didukung

Widget share (`renderSocialShareButtonsHtml`,
`src/modules/blog-content/domain/social-share-links.ts`) merender
kombinasi berikut, masing-masing bisa dimatikan independen lewat env
`NEWS_SHARE_*` (lihat §4):

| Target           | Mekanisme                                                 | Butuh JS? |
| ---------------- | --------------------------------------------------------- | --------- |
| Native Web Share | `navigator.share()` (Web Share API browser/OS)            | Ya        |
| Copy link        | Clipboard API, fallback `document.execCommand`            | Ya        |
| WhatsApp         | `https://wa.me/?text=...` (share-intent resmi)            | Tidak     |
| Telegram         | `https://t.me/share/url?url=...&text=...`                 | Tidak     |
| Facebook         | `https://www.facebook.com/sharer/sharer.php?u=...`        | Tidak     |
| LinkedIn         | `https://www.linkedin.com/sharing/share-offsite/?url=...` | Tidak     |
| X (Twitter)      | `https://twitter.com/intent/tweet?url=...&text=...`       | Tidak     |
| Email            | `mailto:?subject=...&body=...`                            | Tidak     |

Enam target `<a href>` statis (WhatsApp/Telegram/Facebook/LinkedIn/X/
email) hidup di satu array allowlist tetap
(`STATIC_SHARE_LINK_BUILDERS`) — tidak ada mekanisme untuk menambah
platform lain tanpa mengubah kode ini, dan setiap nilai yang
diinterpolasi selalu lewat `encodeURIComponent`, tidak pernah
concatenation string mentah.

Native share dan copy-link dirender sebagai elemen `<button>` (bukan
`<a>`), diaktifkan lewat script client statis
`public/js/news-share.js` (dimuat `<script src="/js/news-share.js"
defer>`, **bukan** inline — lihat §5). Tombol native-share dirender
`hidden` di server dan hanya ditampilkan oleh script bila
`window.isSecureContext && navigator.share` benar-benar ada di browser
pembaca — tanpa JS, tombol itu tetap tersembunyi (tidak ada tombol mati
yang terlihat tapi tidak berfungsi).

## 3. Instagram — tidak ada tombol/URL share, native share/copy-link saja

**Tidak ada** URL web-share resmi Instagram untuk membagikan artikel
dari sumber eksternal sembarang — berbeda dari WhatsApp/Telegram/
Facebook/LinkedIn/X yang semuanya punya endpoint share-intent
terdokumentasi. Karena itu:

- `STATIC_SHARE_LINK_BUILDERS` **tidak pernah** punya entry Instagram —
  tidak ada `instagram.com/...` link yang dibangun di mana pun dalam
  fitur ini.
- Instagram dibagikan **hanya** lewat native share sheet (bila OS
  pembaca menampilkan Instagram sebagai target `navigator.share`, di
  luar kendali aplikasi ini) atau **copy-link** — keduanya sudah
  dirender untuk alasan lain, tidak ada mekanisme khusus Instagram baru.
- `NEWS_SHARE_INSTAGRAM_NATIVE_ONLY` (default `true`) hanya menggerbang
  **catatan teks statis** di dekat tombol share ("Instagram: use the
  Share button above, or Copy link.") — bukan tombol/URL apa pun.
- Test `tests/unit/social-share-links.test.ts` menegakkan ini secara
  eksplisit: tidak boleh ada string `instagram.com` atau
  `news-share__link--instagram` di output manapun.

**Jangan pernah** menambahkan URL "share ke Instagram" buatan sendiri
(mis. deep link `instagram://` yang tidak dijamin bekerja lintas
versi app/OS) sebagai pengganti — ini akan melanggar acceptance
criterion issue #642 dan mengklaim kemampuan yang tidak benar-benar
ada.

## 4. Konfigurasi (`NEWS_SHARE_*`)

Semua flag dimiliki modul `news-portal` (`resolveNewsShareConfig()`,
`src/modules/news-portal/domain/news-share-config.ts`) dan **default
`true`** — deviasi sengaja dari kebiasaan "default off" repo ini karena
fitur ini tidak mengumpulkan data pembaca apa pun dan tidak memuat
script pihak ketiga apa pun (lihat header comment file tersebut untuk
alasan lengkap).

| Variabel                           | Default | Efek                                                                    |
| ---------------------------------- | ------- | ----------------------------------------------------------------------- |
| `NEWS_SHARE_BUTTONS_ENABLED`       | `true`  | Master switch — `false` membuat widget tidak dirender sama sekali       |
| `NEWS_SHARE_NATIVE_ENABLED`        | `true`  | Tombol native Web Share                                                 |
| `NEWS_SHARE_WHATSAPP_ENABLED`      | `true`  | Link WhatsApp                                                           |
| `NEWS_SHARE_TELEGRAM_ENABLED`      | `true`  | Link Telegram                                                           |
| `NEWS_SHARE_FACEBOOK_ENABLED`      | `true`  | Link Facebook                                                           |
| `NEWS_SHARE_LINKEDIN_ENABLED`      | `true`  | Link LinkedIn                                                           |
| `NEWS_SHARE_X_ENABLED`             | `true`  | Link X (Twitter)                                                        |
| `NEWS_SHARE_EMAIL_ENABLED`         | `true`  | Link email (`mailto:`)                                                  |
| `NEWS_SHARE_INSTAGRAM_NATIVE_ONLY` | `true`  | Tampilkan catatan teks Instagram (§3) — tidak pernah membuat tombol/URL |

Tidak ada flag terpisah untuk copy-link — selalu tersedia begitu
`NEWS_SHARE_BUTTONS_ENABLED=true` (fallback universal yang seharusnya
selalu ada).

## 5. Canonical URL — dijamin struktural, bukan filter

Setiap link/atribut `data-share-url` dibangun **hanya** dari
`canonicalUrl` yang sudah diresolusi server-side
(`resolveCanonicalUrl`, dari `url.origin` + slug post) — **tidak
pernah** dari `request.url`/`Astro.url` mentah. Karena `canonicalUrl`
server-generated tidak pernah membawa querystring/tracking
parameter/session id, syarat "do not leak admin preview URLs, draft
URLs, session IDs, or private query parameters" terpenuhi **secara
struktural** (nilai itu memang tidak pernah ada di sana), bukan oleh
sebuah filter yang bisa lupa memfilter sesuatu. Test integrasi
membuktikan ini dengan memanggil route dengan
`?utm_source=newsletter&session_id=abc123` di URL request dan
menegaskan tidak satupun string itu muncul di respons.

## 6. Script client — file statis same-origin, bukan inline

`public/js/news-share.js` dimuat via `<script src="/js/news-share.js"
defer>` — **bukan** `<script>` inline. Ini sengaja menghindari
kerumitan CSP hash/nonce Astro (`security.csp` Astro hanya meng-hash
script yang **ia proses sendiri**; halaman berita dirender lewat rute
`.ts` API route seperti `/news/[slug].ts`, bukan komponen `.astro`,
sehingga tidak pernah lewat pipeline hashing Astro — sebuah `<script>`
inline di sini berisiko diblokir CSP browser nyata tanpa tooling
headless-Chrome untuk mendeteksinya). `script-src 'self'` (default
Astro) sudah cukup untuk file statis same-origin ini — nol entri hash
CSP baru diperlukan. Tidak ada dependency eksternal, tidak ada
`fetch`/`import` ke origin manapun selain halaman itu sendiri.

## 7. Metadata Open Graph/Twitter yang wajib ada

Fitur ini juga memperluas `renderPublicPageShell`
(`src/modules/blog-content/domain/public-page-rendering.ts`) supaya
metadata pratinjau share selalu lengkap:

- `og:title`, `og:description`, `og:url`, `og:site_name` — **selalu**
  dirender (diturunkan dari `title`/`description`/`canonicalUrl`/nama
  tenant yang sudah ada di konteks render, satu sumber kebenaran per
  field).
- `twitter:title`, `twitter:description` — selalu dirender.
- `twitter:card` — **selalu** dirender (`summary` tanpa gambar,
  `summary_large_image` dengan gambar) — sebelum Issue #642, tag ini
  di-omit sama sekali ketika tidak ada gambar.
- `og:image`/`twitter:image`/`og:image:alt` — **tidak berubah** oleh
  fitur share manual ini, tetap tunduk pada gerbang R2-only Issue #636
  (lihat §8 di bawah dan
  [`social-publishing-architecture.md`](social-publishing-architecture.md)
  §Gambar untuk detail lengkap prioritas sumber gambar dan gerbang
  verifikasi R2).

## 8. `og:image` R2-only — tidak ada gambar eksternal/lokal

`og:image`/`twitter:image` hanya pernah dirender dari objek media R2
yang **`verified`/`attached`** milik tenant yang sama
(`resolveOgImageUrl`, `seo-rendering.ts`) — tidak pernah dari URL
gambar eksternal, path filesystem lokal, atau gambar yang belum
selesai proses verifikasi. Bila tidak ada gambar yang lolos gerbang
ini, tag `og:image`/`twitter:image` **diomit sepenuhnya** (degradasi
aman, bukan fallback ke gambar tak terpercaya). Prioritas sumber gambar
lengkap (SEO image override → featured image → gambar gallery pertama
yang terverifikasi → fallback tenant) didokumentasikan penuh di Issue
#649 (lihat `.claude/skills/awcms-mini-news-portal/SKILL.md` §649) —
tidak diulang di sini karena tidak spesifik ke fitur share manual.

## 9. Tidak ada data yang dipersist

Fitur share manual ini murni rendering + client-side script — **tidak
ada migration baru**, tidak ada tabel/kolom baru, tidak ada log
klik/analytics yang dikirim ke server aplikasi ini (klik share pembaca
sepenuhnya terjadi di browser mereka, tidak ada callback ke aplikasi).
Bila ke depan dibutuhkan metrik "berapa kali tombol share diklik",
itu adalah fitur analytics terpisah — tidak dibangun oleh Issue #642
dan tidak dibahas lebih lanjut di dokumen ini.

## 10. Referensi kode

- `src/modules/blog-content/domain/social-share-links.ts` — link
  builder + renderer HTML.
- `src/modules/news-portal/domain/news-share-config.ts` — resolver env
  `NEWS_SHARE_*`.
- `public/js/news-share.js` — script client (native share + copy-link).
- `src/modules/blog-content/domain/public-page-rendering.ts` —
  perluasan OG/Twitter meta tags.
- `src/pages/news/[slug].ts`, `src/pages/blog/[tenantCode]/[slug].ts` —
  composition root yang memanggil kedua fungsi di atas.

## 11. Dokumen terkait

- [`social-publishing-architecture.md`](social-publishing-architecture.md) —
  sistem auto-posting terpisah (bukan fitur ini).
- [`social-provider-limitations.md`](social-provider-limitations.md) —
  batasan per platform, termasuk kenapa WhatsApp **tidak** punya jalur
  auto-posting di repo ini (share manual WhatsApp di atas tetap
  berlaku penuh).
- [`full-online-r2-architecture.md`](full-online-r2-architecture.md) —
  gerbang R2-only yang mengatur `og:image`.
