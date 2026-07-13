# News Portal — Social Publishing Security Checklist

Checklist keamanan dan incident response untuk auto posting sosial
(epic `social_publishing`, #643-#647). Melengkapi
[`social-publishing-architecture.md`](social-publishing-architecture.md)
(arsitektur) dan
[`social-publishing-sop.md`](social-publishing-sop.md) (operasional).
Semua nilai contoh di dokumen ini adalah **placeholder yang jelas
palsu** (mis. `"env:META_APP_SECRET_EXAMPLE"`) — jangan pernah
menempelkan kredensial nyata di dokumentasi, tiket, atau log.

## 1. Token storage — referensi, bukan token nyata

- [ ] `token_reference` (dan `META_APP_SECRET_REFERENCE`/
      `LINKEDIN_CLIENT_SECRET_REFERENCE`/
      `TELEGRAM_BOT_TOKEN_SECRET_REFERENCE`) **selalu** berupa
      referensi buram ke secret storage eksternal (mis.
      `"env:META_APP_SECRET_EXAMPLE"`,
      `"secretsmanager:social/fb-page-example"`) — **tidak pernah**
      kredensial mentah di kolom/env manapun.
- [ ] Repo ini **belum** punya integrasi secret-manager nyata — hanya
      skema `env:VAR_NAME` yang benar-benar bisa diresolusi tiap
      adapter (`resolveMetaTokenReference`,
      `resolveLinkedInSecretReference`, `resolveTelegramBotToken`).
      Prefix lain (`secretsmanager:`/`vault:`/`kms:`/`ssm:`) lolos
      validasi bentuk tapi **gagal resolve** — jangan mengasumsikan
      mereka benar-benar terhubung ke secret manager sungguhan sampai
      diimplementasikan.
- [ ] `token_reference` **tidak pernah** diselect kembali oleh query
      apa pun kecuali dua fungsi internal, masing-masing untuk satu
      keperluan sempit:
      `fetchSocialAccountTokenReferenceForDispatch` (dipanggil
      **hanya** dari dispatcher) dan
      `fetchSocialAccountCredentialsForVerification` (dipanggil
      **hanya** dari endpoint `POST .../accounts/{id}/verify`). Jaminan
      sebenarnya adalah **"tidak pernah dikembalikan dari
      `GET /accounts`"** (endpoint yang dibaca admin untuk daftar
      akun) — bukan "tidak pernah dari route HTTP apa pun", karena
      endpoint verify di atas memang sebuah route HTTP yang secara
      sengaja butuh nilai ini untuk memanggil provider.
- [ ] Disconnect akun membersihkan `token_reference` ke `NULL` — bukan
      sekadar flip status `connectionStatus`.
- [ ] Setiap penambahan var `*_TOKEN_REFERENCE`/`*_SECRET_REFERENCE`
      baru **wajib** divalidasi dengan `looksLikeRawSecretToken`
      (jangan buat heuristic baru, reuse fungsi yang sudah ada — lihat
      §2).

## 2. Heuristic penolakan token mentah — `looksLikeRawSecretToken`

`src/modules/social-publishing/domain/social-account-validation.ts`'s
`looksLikeRawSecretToken` adalah **best-effort, defense-in-depth**
(bukan jaminan sempurna, didokumentasikan eksplisit di komentar
fungsinya) yang menolak nilai `tokenReference`/`*_SECRET_REFERENCE`
yang **berbentuk** token bearer asli: JWT 3-segmen, prefix Meta
`EAA...`, Google `ya29.`/`1//`, GitHub `gh[a-z]_...`, token Bot API
Telegram (`<bot_id>:<35-char secret>`), atau blob base64/hex 64+
karakter tanpa prefix referensi dikenal.

### Perilaku saat ini (setelah 2 ronde perbaikan security-auditor, PR #731)

Mekanismenya adalah **strip-and-recheck loop**, bukan pengecualian
whole-string:

1. Cek nilai saat ini terhadap 5 pola bentuk token asli
   (`matchesKnownRawSecretShape`).
2. Bila cocok → **tolak** (`true`).
3. Bila tidak cocok, coba lepas **satu** prefix referensi dikenal
   (`secretsmanager:`/`env:`/`ref:`/`vault:`/`kms:`/`ssm:`, case-
   insensitive) dari **awal** sisa string.
4. Bila tidak ada prefix yang cocok → nilai adalah referensi pendek
   yang sah, **terima** (`false`).
5. Bila ada prefix yang dilepas → ulangi dari langkah 1 pada sisa
   string yang **lebih pendek**.
6. Loop dibatasi `MAX_REFERENCE_PREFIX_STRIPS = 5` — menghabiskan
   budget tanpa pernah mencapai sisa yang bersih (baik bentuk token
   asli maupun bebas-prefix) **juga ditolak** (fail closed, bukan
   permisif).

**Kenapa desain ini, bukan yang lebih sederhana**: dua ronde
sebelumnya masing-masing ternyata bisa dilewati (histori lengkap ada
di komentar header fungsi ini dan
`.claude/skills/awcms-mini-social-publishing/SKILL.md` §643 Keputusan
kunci #3):

- **Ronde 1**: cek awal mengecualikan SETIAP string berisi titik dua
  dari deteksi blob — token Bot API Telegram asli (yang memang
  mengandung titik dua secara struktural) lolos.
- **Ronde 2**: perbaikan pertama mengecualikan **seluruh string**
  begitu ditemukan prefix dikenal di depan — karena semua pola bentuk
  (kecuali JWT) di-anchor `^`, menempelkan `env:` di depan token asli
  apa pun membuatnya tidak lagi "mulai dengan" bentuk yang dicek,
  sehingga **setiap** token asli yang diberi prefix `env:` lolos.
  Sebuah operator yang jujur mengikuti pesan error endpoint ini
  sendiri ("simpan kredensial di secret manager, isi referensinya di
  sini") justru bisa menghasilkan bypass ini tanpa niat jahat.
- **Ronde 3 (final)**: strip-and-recheck di atas — diverifikasi
  adversarial (batas `MAX_REFERENCE_PREFIX_STRIPS`, prefix regex
  yang selalu re-anchor ke sisa string saat ini, bukan string asli)
  sebelum di-PASS.

### Residual yang diterima (bukan bug, terdokumentasi)

Token pendek (di bawah ambang 64 karakter blob) yang tidak berbentuk
salah satu dari 5 pola provider spesifik **bisa lolos** — heuristic
ini best-effort untuk bentuk yang **dikenal**, bukan deteksi entropi
sempurna untuk semua kemungkinan bentuk secret. Ini residual yang
disadari dan diterima, bukan sesuatu yang perlu "diperbaiki lagi"
tanpa menemukan bentuk token nyata baru yang lolos.

### Pelajaran untuk kode baru (lihat juga §4)

- **Jangan** pernah membuat heuristic deteksi-secret baru untuk
  provider tambahan — reuse `looksLikeRawSecretToken` seperti yang
  sudah dilakukan LinkedIn (`resolveLinkedInSecretReference` memanggil
  fungsi ini verbatim, tidak menduplikasi logikanya).
- **Jangan** pernah mengecualikan **seluruh nilai** dari pengecekan
  hanya karena ia dimulai dengan prefix yang dikenal sah — selalu
  strip-lalu-recheck sisa string, dilakukan berulang dan dibatasi.
- **Jangan** menjalankan heuristic ini **lagi** terhadap nilai HASIL
  resolve (lihat §3 — kasus nyata yang pernah terjadi di adapter
  LinkedIn).

## 3. Jangan re-validasi nilai yang SUDAH diresolusi (bug nyata, sudah diperbaiki)

**Kasus nyata, PR #737 (LinkedIn adapter), Critical, sudah
diperbaiki**: `resolveLinkedInSecretReference` sempat mem-validasi
ulang nilai **hasil resolve** (kredensial asli, bukan referensinya)
terhadap `looksLikeRawSecretToken` yang sama. Ini bug fatal, bukan
sekadar redundan: token akses LinkedIn asli (150-1000+ karakter opaque)
persis berbentuk blob high-entropy 64+ karakter yang memang dirancang
ditolak heuristic itu — versi lama menolak **setiap** resolusi token
asli sebagai `"unresolvable"`, membuat publish/verify tidak pernah
bisa berhasil untuk akun yang benar-benar terkonfigurasi dengan benar.
Test suite sendiri tidak menangkap ini karena fixture token pengujian
sengaja pendek (di bawah ambang 64 karakter).

**Aturan yang benar** (diverifikasi di adapter Meta,
`resolveMetaTokenReference`, sebagai referensi implementasi yang
lolos review bersih): heuristic "apakah nilai ini terlihat seperti
secret mentah" hanya berlaku di batas di mana **pemanggil** mungkin
salah menempelkan secret asli ke field yang seharusnya berisi
referensi — yaitu memvalidasi **string referensi** (`"env:VAR_NAME"`)
**sebelum** diresolusi. Tidak pernah dijalankan lagi pada nilai yang
diperoleh **setelah** resolusi berhasil — karena tujuan resolusi
memang menghasilkan sesuatu yang secara sah terlihat seperti secret
asli.

## 4. Redaksi error — urutan wajib: redact dulu, baru truncate

**Kasus nyata, PR #737 (LinkedIn adapter), Critical, sudah
diperbaiki**: tiga titik panggilan di `linkedin-provider-adapter.ts`
sempat memanggil `redact(truncate(message, 500), token)` — urutan
**terbalik**. `redact()` hanya cocok pada kemunculan **lengkap** token
via `.split(token)`; bila token mentah terpotong tepat di titik 500
karakter oleh `truncate` yang berjalan lebih dulu, hanya **fragmen**
token yang tersisa di string (tidak sama dengan token penuh), sehingga
`.split()` gagal cocok dan fragmen itu (dikonfirmasi: belasan karakter
awal token asli) **tersimpan apa adanya** ke kolom admin-readable
(`awcms_mini_social_publish_jobs.last_error_message`/
`..._social_publish_attempts.error_message`).

**Perbaikan**: urutan **wajib** `truncate(redact(message, token),
500)` — redact **selalu** dijalankan pada string penuh sebelum
truncate memotongnya. Aturan ini berlaku untuk **setiap** titik kode
baru yang menggabungkan redaction dan truncation pada pesan error yang
mungkin mengandung secret — urutan yang salah membiarkan sebuah
fragmen secret straddling titik potong lolos ke storage yang bisa
dibaca admin.

**Verifikasi saat menambah kode serupa**: test regresi harus
memposisikan token secara eksplisit agar **benar-benar straddle**
batas truncation (bukan body pendek yang tidak pernah menyentuh titik
potong) — lihat `tests/unit/linkedin-provider-adapter.test.ts`'s test
"never leaks a partial token fragment when the token straddles the
truncation boundary" sebagai pola referensi (menghitung margin secara
eksplisit dan memverifikasi fixture-nya benar-benar akan gagal
terhadap urutan lama sebelum mengklaim fix-nya benar).

## 5. Escaping Markdown Telegram — single-pass, backslash termasuk dalam character class

`domain/telegram-message-formatting.ts`'s escaper MarkdownV2
(`escapeTelegramMarkdownV2`) menggunakan **satu pass regex tunggal**
atas string asli, dan memasukkan karakter **backslash itu sendiri** ke
dalam character class yang di-escape (bukan hanya
`_*[]()~\`>#+-=|{}.!`). Ini penting: sebuah escaper yang lupa
menyertakan backslash dalam kelas yang sama berisiko membiarkan
backslash **asli** dari input "mengunci" dengan backslash **baru**
yang disisipkan escaper, sehingga karakter sesudahnya lolos ter-escape
— kelas bug yang sudah muncul berulang di dokumen generator lain di
repo ini (escaper `|`-only tanpa urutan backslash-lebih-dulu). Escaper
Telegram di sini **sudah benar** (diverifikasi manual character-by-
character trace saat security review PR #736) — dicatat di sini
sebagai referensi pola yang benar, bukan sebagai bug yang masih ada.

**Pelajaran untuk kode escaping/sanitasi baru**: bila menulis escaper
berbasis regex untuk format markup apa pun (Markdown, HTML entity,
CSV, dll.), selalu masukkan karakter escape/delimiter itu sendiri ke
dalam himpunan karakter yang diproses **dalam satu pass**, jangan
memproses karakter escape secara terpisah dari karakter lain (mis.
beberapa `.replace()` berurutan) — urutan replace yang salah bisa
membuka celah yang sama meski setiap `.replace()` individu terlihat
benar sendiri-sendiri.

## 6. Least-privilege scope

- [ ] Meta: hanya minta `pages_manage_posts`, `pages_read_engagement`,
      dan `instagram_content_publish` (bila memakai Instagram) — tidak
      ada scope tambahan yang tidak dipakai adapter ini.
- [ ] LinkedIn: hanya minta `w_organization_social`,
      `r_organization_social`, `rw_organization_admin` — bukan scope
      member-level yang lebih luas.
- [ ] Telegram: bot **hanya** perlu jadi administrator channel dengan
      "Post Messages" — jangan berikan hak administrator penuh (mis.
      hak menghapus pesan orang lain, mengundang admin lain) bila
      tidak dibutuhkan.
- [ ] Jangan pernah menghubungkan token dengan hak akses lebih luas
      dari yang benar-benar dipakai adapter — token dengan scope
      berlebih memperbesar blast radius bila `token_reference` bocor.

## 7. Larangan scraping/otomasi browser

**Dilarang keras** menggunakan scraping atau otomasi browser (mis.
Puppeteer/Playwright yang meniru login manusia) sebagai pengganti API
resmi untuk platform apa pun di modul ini — baik untuk publish maupun
verify. Setiap adapter di repo ini **hanya** memanggil API resmi yang
didokumentasikan platform (Graph API, LinkedIn REST/Rest.li API, Bot
API Telegram) via `fetch`, tidak pernah menirukan sesi browser
pengguna. Alasan: scraping/otomasi browser melanggar Terms of Service
hampir semua platform sosial, rentan patah tanpa peringatan saat UI
platform berubah, dan tidak bisa diaudit/dipertanggungjawabkan sebagai
tindakan API resmi. Bila sebuah kapabilitas yang diinginkan tidak
tersedia lewat API resmi platform manapun (mis. auto posting ke
Instagram personal), **jangan** coba menyiasatinya dengan scraping —
dokumentasikan sebagai batasan platform (lihat
[`social-provider-limitations.md`](social-provider-limitations.md)),
bukan celah untuk ditutup dengan otomasi tidak resmi.

## 8. Incident response — token sosial bocor

Struktur mengikuti Detect → Contain → Eradicate → Recover →
Post-incident, konsisten dengan pola incident response R2 di
[`r2-incident-response.md`](r2-incident-response.md) dan doc 20.

### Detect

- `token_reference` atau kredensial nyata yang dirujuknya ter-log,
  ter-screenshot, atau ter-commit secara tidak sengaja (mis. dalam
  tiket support, chat internal, atau file konfigurasi yang salah
  di-commit).
- Aktivitas posting yang tidak dikenali redaksi muncul di akun sosial
  tenant (post yang tidak pernah dibuat lewat aplikasi ini).
- Alert dari platform sosial sendiri (Meta/LinkedIn/Telegram)
  tentang aktivitas mencurigakan pada App/Bot terkait.

### Contain

1. **Segera cabut/revoke** token di sisi platform (Meta App dashboard,
   LinkedIn Developer portal, atau `/revoke`/BotFather untuk Telegram
   — regenerasi bot token Telegram otomatis mencabut yang lama).
2. Disconnect akun yang terpengaruh lewat `POST
.../accounts/{id}/disconnect` (membersihkan `token_reference` ke
   `NULL` di database aplikasi ini) — **setelah** revoke di platform,
   bukan sebagai pengganti revoke.
3. Bila token dibagi lintas akun (mis. satu Meta App Secret dipakai
   banyak Page), pertimbangkan dampak ke **semua** akun yang
   bergantung pada credential yang sama, tidak hanya akun yang
   pertama terdeteksi.

### Eradicate

1. Rotasi credential di secret storage eksternal (env var/secret
   manager operator) — nilai baru, referensi (`token_reference`)
   **boleh** tetap sama namanya bila secret storage mendukung
   rotasi-in-place, atau buat referensi baru dan update
   `token_reference` lewat reconnect (§Reauthorization di
   [`social-publishing-sop.md`](social-publishing-sop.md)).
2. Audit `awcms_mini_social_publish_attempts`/
   `awcms_mini_social_publish_jobs` untuk periode sejak perkiraan waktu
   kebocoran — cari `externalPostId`/`externalPostUrl` yang tidak
   dikenali sebagai hasil job aplikasi ini sendiri (indikasi token
   dipakai pihak lain untuk posting di luar jalur normal).
3. Jangan asumsikan hanya satu token yang bocor — periksa apakah
   media/tempat kebocoran (mis. log yang sama) menyimpan
   `token_reference` provider lain juga.

### Recover

1. Reconnect akun dengan `tokenReference` yang menunjuk credential
   baru hasil rotasi.
2. Jalankan `POST .../accounts/{id}/verify` untuk konfirmasi koneksi
   baru valid sebelum menyalakan kembali `autoPublishEnabled`.
3. Retry manual job yang tertunda/gagal akibat insiden (`needs_reauth`)
   sesuai [`social-publishing-sop.md`](social-publishing-sop.md) §5.3.

### Post-incident

- Catat insiden sebagai audit event `critical` (skill
  `awcms-mini-audit-log`) dengan `correlationId` yang menghubungkan
  seluruh langkah containment/eradication/recovery.
- Tinjau bagaimana kebocoran terjadi (log yang tidak seharusnya
  mencatat nilai token, akses secret storage yang terlalu luas, dsb.)
  dan perbaiki akar penyebabnya, bukan hanya rotasi credential.

## 9. Incident response — post eksternal tidak sengaja/tidak sah

### Detect

- Redaksi melaporkan sebuah post muncul di akun sosial tenant yang
  tidak pernah mereka setujui/maksudkan.
- Job dengan `requires_approval` ternyata `published` tanpa approval
  tercatat (indikasi bug approval gate — laporkan ke tim implementasi
  segera, ini adalah kegagalan kontrol, bukan hanya insiden
  operasional).

### Contain

1. **Hapus/edit post secara manual langsung di platform target**
   (Meta Business Suite/LinkedIn/Telegram client) — aplikasi ini
   **tidak punya** mekanisme unpublish/edit post sosial otomatis
   (lihat [`social-publishing-sop.md`](social-publishing-sop.md) §7
   Takedown policy).
2. Bila artikel sumber juga perlu ditarik, unpublish artikel di
   `blog_content` **terpisah** dari langkah 1 — keduanya tidak
   otomatis saling mengikuti.
3. Bila post berasal dari rule yang salah konfigurasi (mis.
   `requires_approval=false` yang seharusnya `true`), **matikan**
   `autoPublishEnabled` akun terkait segera untuk mencegah post
   berikutnya sementara rule diperbaiki.

### Eradicate

- Perbaiki konfigurasi rule/template yang menyebabkan post tidak
  sah (approval gate, trigger event, template caption).
- Bila root cause adalah bug kode (bukan kesalahan konfigurasi),
  eskalasi ke tim implementasi — jangan hanya menutup gejalanya di
  level konfigurasi.

### Recover

- Nyalakan kembali `autoPublishEnabled` hanya setelah root cause
  diperbaiki dan diverifikasi (mis. lewat staging/dry-run bila
  tersedia).

### Post-incident

- Catat sebagai audit event, tinjau apakah rule/permission redaksi
  perlu diperketat (mis. siapa yang boleh mengubah
  `requires_approval`).

## 10. Catatan kepatuhan (bukan nasihat hukum)

Dokumen ini **tidak** memberikan nasihat hukum — konsultasikan dengan
penasihat hukum/kepatuhan tenant untuk kewajiban spesifik yurisdiksi.
Pertimbangan umum yang relevan untuk operasi media di Indonesia:

- **Privasi**: jangan memposting otomatis artikel yang memuat data
  pribadi (NIK, nomor telepon pribadi, dsb. — lihat skill
  `awcms-mini-sensitive-data`) ke platform publik tanpa proses redaksi
  editorial yang sudah menyaring data tersebut **sebelum** artikel
  dipublish (auto-posting terjadi setelah publish, tidak melakukan
  penyaringan tambahan sendiri).
- **Kepatuhan pers**: konten yang diposting otomatis tetap tunduk pada
  kode etik jurnalistik dan regulasi pers yang berlaku (mis. Kode Etik
  Jurnalistik Dewan Pers) sama seperti artikel yang dipublish manual —
  auto-posting hanya mempercepat distribusi, tidak mengubah tanggung
  jawab editorial atas kontennya.
- **Ketentuan layanan platform**: setiap adapter di modul ini dirancang
  memakai API resmi dengan scope minimal (§6) untuk mematuhi Terms of
  Service Meta/LinkedIn/Telegram masing-masing — perubahan kebijakan
  platform (mis. persyaratan App Review baru) berada di luar kendali
  kode aplikasi ini dan wajib dipantau operator secara berkala.
- **Retensi data**: `awcms_mini_social_publish_attempts` adalah audit
  trail append-only yang berisi hasil publish (termasuk pesan error
  yang sudah diredaksi) — kebijakan retensi/purge mengikuti kebijakan
  audit log umum repo ini (skill `awcms-mini-audit-log`, doc 03/10),
  tidak ada kebijakan retensi terpisah khusus modul ini.

## 11. Dokumen terkait

- [`social-publishing-architecture.md`](social-publishing-architecture.md)
- [`social-publishing-sop.md`](social-publishing-sop.md)
- [`social-provider-limitations.md`](social-provider-limitations.md)
- [`social-sharing.md`](social-sharing.md)
- [`r2-incident-response.md`](r2-incident-response.md) — pola incident
  response media R2 yang dijadikan referensi struktur dokumen ini.
