---
name: awcms-mini-social-publishing
description: Kerjakan bagian mana pun dari epic social_publishing AWCMS-Mini (Issue #643-#647). Gunakan saat menambah/mengubah account connector, publish rule/template, outbox job/attempt, approval, retry/backoff, dispatcher, atau provider adapter (Meta/LinkedIn/Telegram) untuk auto-posting berita ke platform sosial. Merangkum keputusan arsitektur yang sudah dibuat di Issue #643 (fondasi) supaya issue adapter lanjutan (#644-#646) dan issue dokumentasi (#647) tidak mengulang/kontradiksi.
---

# AWCMS-Mini — Social Publishing (auto-posting outbox foundation)

Epic `social_publishing` (#643-#647) menambah lapisan auto-posting
provider-neutral di atas `blog_content` (base module, sudah `active`) dan
`news_portal` (epic `news_portal` #631-#642/#649, sumber gambar R2
terverifikasi) — khusus deployment **full-online** yang mengaktifkan flag
`SOCIAL_PUBLISHING_ENABLED`/`SOCIAL_PUBLISHING_PROFILE`. Issue #643
(fondasi) selesai lebih dulu; #644 (Meta/Facebook+Instagram), #645
(LinkedIn), #646 (Telegram) masing-masing menambah SATU provider adapter
NYATA di atas fondasi ini; #647 (dokumentasi/SOP) butuh semua issue
sebelumnya sudah ada.

## Kapan pakai skill ini vs skill generik

Skill ini melengkapi (bukan menggantikan) `awcms-mini-new-endpoint`,
`awcms-mini-new-migration`, `awcms-mini-integration` (pola outbox/circuit
breaker eksternal, ADR-0006), `awcms-mini-idempotency` (mutation
connect/disconnect/approve/cancel/retry), `awcms-mini-abac-guard`,
`awcms-mini-audit-log`, dan `awcms-mini-sensitive-data` (token
reference). Skill ini menyediakan konteks **cross-cutting epic
spesifik** — terutama keputusan "provider-neutral foundation dulu, tidak
ada adapter nyata sampai #644/#645/#646" yang wajib dipertahankan setiap
issue lanjutan.

## Status per issue (jangan bangun ulang yang sudah ada)

| Issue | Scope                                                                                                                         | Status                            |
| ----- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| #643  | Fondasi: schema 6 tabel, outbox/dispatcher, approval, retry/backoff, provider-adapter interface (kosong), admin UI, readiness | **Selesai** — lihat §643 di bawah |
| #644  | Adapter Meta (Facebook Page + Instagram Business)                                                                             | **Selesai** — lihat §644 di bawah |
| #645  | Adapter LinkedIn (organization page)                                                                                          | Belum dikerjakan                  |
| #646  | Adapter Telegram (channel, bot token)                                                                                         | Belum dikerjakan                  |
| #647  | Dokumentasi/SOP lintas provider, butuh #643-#646 semua ada                                                                    | Belum dikerjakan                  |

Urutan dependency (dari objective masing-masing issue): 643 -> {644, 645,
646 independen satu sama lain, masing-masing hanya butuh #643} -> 647
(butuh semuanya).

## §643 — Fondasi outbox/connector (Selesai)

### Keputusan kunci #1 — full-online-only lewat gate DUA-flag env, BUKAN reuse `NEWS_PORTAL_ENABLED`

`SOCIAL_PUBLISHING_ENABLED` (master switch) + `SOCIAL_PUBLISHING_PROFILE`
(wajib `"full_online"` bila enabled) — persis pola
`AUTH_ONLINE_SECURITY_ENABLED`/`_PROFILE`
(`src/lib/auth/online-security-config.ts`), BUKAN reuse
`NEWS_PORTAL_ENABLED`/`_PROFILE` milik epic `news_portal` (fitur
berbeda, keputusan deployment berbeda — tenant bisa full-online
news_portal tanpa pernah mau auto-posting sosial). Resolver:
`src/modules/social-publishing/domain/social-publishing-config.ts`'s
`isSocialPublishingDeploymentActive(env)`. Ditegakkan
`config:validate` (`checkSocialPublishingProfileConfig`,
`scripts/validate-env.ts`) dan `security:readiness`
(`checkSocialPublishingProviderReadiness`, critical,
`scripts/security-readiness.ts`).

Ini HANYA setengah dari acceptance criterion "Auto-posting can be
disabled globally and per tenant" — setengah lain (per-tenant) adalah
`awcms_mini_social_publishing_settings` (Keputusan kunci #2 di bawah).

### Keputusan kunci #2 — tabel settings per-tenant BOLEH tenant-writable (BUKAN pengulangan anti-pattern #636)

`awcms_mini_social_publishing_settings` (`tenant_id` PK,
`auto_publishing_enabled`) adalah tabel keenam, di luar 5 "Core entities"
literal body issue #643. Sengaja **tenant-writable** lewat endpoint
ABAC-gated (`GET/PATCH /api/v1/social-publishing/settings`, permission
`rules.configure`) — ini **BUKAN** pengulangan anti-pattern Issue #636
(`.claude/skills/awcms-mini-news-portal/SKILL.md` §636): #636 butuh
sinyal yang TIDAK BOLEH tenant defeat sendiri (enforcement keamanan R2-
only). Toggle auto-posting per-tenant di sini justru MEMANG dimaksudkan
bisa diubah tenant sendiri (preferensi bisnis biasa, bukan kontrol
keamanan) — jadi tabel dedicated + RLS + ABAC endpoint biasa sudah
cukup, TIDAK perlu pola "zero generic write surface" #636. Jangan
disalahartikan sebagai kemunduran keamanan bila membaca kode ini setelah
membaca §636 — keduanya sengaja berbeda karena ancaman modelnya berbeda.

### Keputusan kunci #3 — `token_reference` adalah REFERENSI, bukan token nyata; ada heuristic penolakan

`awcms_mini_social_accounts.token_reference` adalah string buram (mis.
`"secretsmanager:social/fb-page-42"`, `"env:SOCIAL_TOKEN_X"`) yang
menunjuk ke secret storage eksternal — repo ini **belum** punya integrasi
secret-manager nyata (dicatat sebagai residual/follow-up, bukan
diselesaikan issue ini). `social-account-validation.ts`'s
`looksLikeRawSecretToken` menolak (400) nilai yang BERBENTUK token asli
(JWT 3-segmen, prefix `EAA`/`ya29.`/`1//`/`ghp_`, token Bot API Telegram
`<bot_id>:<35-char secret>`, blob base64/hex panjang tanpa
prefix-referensi dikenal) — best-effort, BUKAN jaminan sempurna
(didokumentasikan eksplisit di komentar fungsi). `token_reference`
**tidak pernah** diselect kembali oleh query mana pun kecuali SATU fungsi
`fetchSocialAccountTokenReferenceForDispatch` (INTERNAL ONLY, dipanggil
dispatcher, tidak pernah dari route HTTP) — sama pola
`tenant-domain-directory.ts`'s `verification_token_hash`. Disconnect
membersihkan `token_reference` ke `NULL` (bukan sekadar flip status).

**Temuan security-auditor round 1 (PR #731, High, DITUTUP)**: cek
awal hanya punya 4 pola (JWT/EAA/ya29./gh[a-z]_) plus satu catch-all blob
64+ karakter yang mengecualikan SEMUA string berisi titik dua — token Bot
API Telegram asli (`110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw`, ~44
karakter) lolos: terlalu pendek untuk catch-all, dan bentuknya tidak cocok
4 pola lain. Ini gap nyata untuk provider BERIKUTNYA di epic ini (#646),
bukan hipotetis. Diperbaiki dengan (1) pola penolakan eksplisit
`^\d{6,10}:[A-Za-z0-9_-]{30,45}$` sebelum pengecualian referensi, DAN (2)
`KNOWN_SECRET_REFERENCE_PREFIX_PATTERN` (allow-list prefix
`secretsmanager`/`env`/`ref`/`vault`/`kms`/`ssm`) menggantikan "string
apa pun berisi titik dua dikecualikan" — charset catch-all blob juga
diperluas mencakup `:` supaya pengecualian prefix ini benar-benar
teruji/reachable, bukan dead code. **Wajib untuk #644/#645/#646**: bila
provider kalian punya bentuk token yang juga bisa lolos dari 5 pola yang
ada sekarang, tambah pola penolakan eksplisit baru — jangan andalkan
catch-all blob generik saja untuk token yang PENDEK.

**Wajib untuk #644/#645/#646**: adapter nyata TIDAK boleh menyimpan
token/secret client-nya sendiri di kolom lain manapun — resolusi
`tokenReference` -> kredensial nyata adalah tanggung jawab adapter
sendiri (mis. baca env var bernama sesuai reference, atau panggil secret
manager beneran), bukan tanggung jawab fondasi ini.

### Keputusan kunci #4 — provider-adapter interface, registry KOSONG, `provider_key` BUKAN enum tetap

`domain/social-provider-adapter.ts` mendefinisikan `SocialProviderAdapter`
(providerKey, requiredEnvVars, `publish()`, `verifyCredentials()`).
`infrastructure/social-provider-registry.ts` adalah singleton Map yang
KOSONG di issue ini — TIDAK ADA satu pun panggilan HTTP nyata ke Meta/
LinkedIn/Telegram di seluruh modul ini. `provider_key` (kolom
`awcms_mini_social_accounts`/`..._social_publish_jobs`) sengaja HANYA
divalidasi FORMAT (`^[a-z][a-z0-9_]{1,49}$`), bukan `CHECK` enum tetap
seperti `awcms_mini_news_portal_ad_placements.placement_key` — supaya
#644/#645/#646 bisa mendaftarkan provider key baru tanpa migration baru.

**Wajib untuk #644/#645/#646**: panggil
`registerSocialProviderAdapter(adapter)` dari COMPOSITION ROOT milik
adapter itu sendiri (mis. sebuah file/script/module-init baru, BUKAN
dari dalam `social-publishing/application`/`domain`) — sama pola
`setLogSink`/`setAuditExportHook`'s "registration adalah composition-
root concern". Gunakan `providerKey` yang konsisten dengan nama yang
tersirat body issue kalian sendiri (mis. `facebook_page`,
`instagram_business`, `linkedin_organization`, `telegram_channel`) —
tidak ada daftar resmi yang mengikat, tapi jaga konsistensi lintas ketiga
issue itu sendiri.

### Keputusan kunci #5 — outbox: job CREATION di dalam transaksi, provider CALL di luar (ADR-0006)

`application/create-social-publish-jobs.ts`'s
`createSocialPublishJobsForArticle` HANYA melakukan INSERT baris job
(plain DB write, tanpa panggilan eksternal apa pun) — dipanggil DI DALAM
transaksi yang sama dengan transisi `blog_content` post ke `published`
(via `SocialPublishingPort`, lihat Keputusan kunci #6). Ini BENAR sesuai
pola outbox (menulis event/outbox row atomis dengan business event yang
memicunya) — bukan pelanggaran ADR-0006, karena ADR-0006 melarang
panggilan PROVIDER (bukan penulisan baris outbox) di dalam transaksi.
Panggilan provider NYATA hanya terjadi di
`application/social-publish-dispatch.ts`'s `dispatchSocialPublishQueue`
(dipanggil `bun run social-publishing:dispatch`,
`scripts/social-publish-dispatch.ts`), 3-fase CLAIM/CALL/FINALIZE persis
`sync-storage/application/object-dispatch.ts`.

**Wajib untuk #644/#645/#646**: JANGAN pernah memanggil `adapter.publish()`
dari dalam kode yang juga menulis ke `awcms_mini_blog_posts` atau berjalan
di dalam transaksi manapun — hanya dispatcher yang boleh memanggilnya,
dan HARUS dibungkus `withTimeout` + circuit breaker per-provider
(`getProviderCircuitBreaker(`social-publishing:${providerKey}`)`), sudah
disiapkan generik di `social-publish-dispatch.ts` — adapter baru TIDAK
perlu menambah circuit breaker sendiri.

### Keputusan kunci #6 — dua port lintas modul: `SocialPublishingPort` (blog_content konsumsi) dan `NewsMediaPort` (social_publishing konsumsi)

Sama pola Issue #681 (`_shared/ports/`, `news_media`/`public_content`):
`_shared/ports/social-publishing-port.ts` (BARU, issue ini) adalah
capability yang `blog_content` KONSUMSI dari `social_publishing`
(`onArticlePublished`, dipanggil dari `pages/api/v1/blog/posts/[id]/
publish.ts` dan `blog-content/application/blog-scheduled-publish.ts` via
parameter `socialPublishingPort` opsional, diwire di
`scripts/blog-scheduled-publish.ts`). `social_publishing` sendiri
KONSUMSI `news_portal`'s `news_media` capability (untuk resolusi URL
gambar R2 terverifikasi) — TIDAK mengimpor `news-portal/application/
news-media-port-adapter.ts` secara langsung dari dalam
`social-publishing/application` (itu justru anti-pattern yang sama
persis #681 perbaiki); factory
`social-publishing-port-adapter.ts`'s `createSocialPublishingPortAdapter(mediaPort)`
menerima `NewsMediaPort` sebagai PARAMETER, hanya composition root
(route/script) yang mengimpor kedua adapter konkret dan merangkainya.

**Catatan khusus**: `social-publishing-port-adapter.ts` JUGA mengimpor
`blog-content/application/public-route-settings.ts`'s
`fetchEffectivePublicRouteSettings` secara langsung (untuk
`publicBasePath`) — ini BUKAN pelanggaran boundary yang sama:
`tests/unit/module-boundary.test.ts` (Issue #681) HANYA mengatur pasangan
`blog_content`<->`news_portal`, tidak ada boundary setara antara
`social_publishing` dan `blog_content` hari ini. Arah ini jauh lebih
rendah risiko (satu fungsi getter read-only, bukan re-impor seluruh
domain modul lain) — didokumentasikan sengaja, bukan kelalaian.

### Keputusan kunci #7 — canonical URL dari domain tenant terverifikasi, BUKAN `url.origin`

Setiap konstruksi canonical URL lain di repo ini (`/news/[slug].ts`,
`sitemap-news.xml.ts`) memakai `url.origin` dari REQUEST langsung — tidak
tersedia di sini karena job creation bisa dipicu dari worker terjadwal
tanpa request masuk sama sekali. `application/article-canonical-url.ts`'s
`resolvePrimaryVerifiedDomainHostname` query LANGSUNG (raw SQL, tanpa
import TS) ke `awcms_mini_tenant_domains` (`is_primary = true AND status
= 'active'`) — pola yang SAMA `blog-content/application/public-news-
tenant-resolution.ts` sudah pakai untuk tabel yang sama, jadi bukan
pelanggaran boundary baru. Bila tenant belum punya domain utama
terverifikasi, job creation SKIP dengan alasan terdokumentasi
(`no_verified_domain`) — TIDAK pernah menebak/fallback ke URL yang salah.

### Keputusan kunci #8 — idempotensi job: unique index DB, bukan hanya disiplin aplikasi

`awcms_mini_social_publish_jobs_idempotency_key` (UNIQUE
`(tenant_id, idempotency_key)`) + `INSERT ... ON CONFLICT DO NOTHING` —
`idempotency_key` dihitung deterministik dari
`(tenantId, articleId, socialAccountId, providerKey, action)` via
`domain/social-publish-idempotency.ts`'s
`buildSocialPublishIdempotencyKey`. Ini terpisah dari `_shared/
idempotency.ts`'s tabel HTTP `Idempotency-Key` generik (dipakai endpoint
connect/disconnect/approve/cancel/retry) — job creation dipicu event
internal, bukan request HTTP client, jadi butuh mekanisme idempotensi
sendiri di level baris DB.

### Keputusan kunci #9 — `PATCH /accounts/{id}` (toggle auto-publish) digerbang `rules.configure`, BUKAN permission `accounts.*` baru

DISENGAJA (temuan security-auditor M2, PR #731 review round 1): role yang
punya `rules.configure` tapi TIDAK punya `accounts.connect`/`.disconnect`
tetap bisa mengubah `autoPublishEnabled` sebuah akun yang bukan ia
hubungkan sendiri. Ini reuse dari 10 permission tetap yang sudah
disarankan issue #643 sendiri (lihat header migration 050) — bukan
menambah permission ke-11 (`accounts.configure` misalnya) hanya untuk satu
field boolean. Blast radius dibatasi pada "boleh menyalakan/mematikan
auto-publish akun yang SUDAH terhubung", tidak pernah menyentuh
kredensial/token (itu tetap di belakang `accounts.connect`/`.disconnect`).
Dicatat di sini SUPAYA terbaca sebagai tradeoff yang disadari, bukan
kelalaian, bila ditinjau ulang nanti — lihat juga komentar header
`pages/api/v1/social-publishing/accounts/[id].ts`'s `PATCH` handler.

### Retry/backoff — `evaluateSocialPublishRetry`/`evaluateSocialPublishRateLimitRetry`

Formula sama `sync-storage/domain/object-queue.ts`'s
`evaluateObjectRetry` (`2^attemptCount` menit, capped
`SOCIAL_PUBLISH_MAX_RETRY_DELAY_MINUTES=240`), TIDAK di-reuse langsung
(constants beda: job punya `max_attempts` per-baris, bukan konstanta
modul tetap). Rate-limit retry mempertimbangkan
`retryAfterSeconds` dari provider, tidak pernah lebih pendek dari lantai
eksponensial (mencegah provider memaksa retry loop rapat).

### Status job pasca-dispatch

- `published`: sukses, `externalPostId`/`externalPostUrl` terisi.
- retryable gagal & budget tersisa: kembali ke `pending`/`approved`
  (tergantung `requires_approval` snapshot) dengan `next_attempt_at`
  backoff — TIDAK pernah balik ke `requires_approval` (approval tidak
  perlu diulang).
- retry budget habis: `failed` (terminal, TIDAK bisa retry manual lagi —
  `retrySocialPublishJob` menolak `attempt_count >= max_attempts`).
- `rate_limited`: backoff dari `retryAfterSeconds`, tetap bisa habis
  budget -> `failed` terminal juga.
- `needs_reauth`: TIDAK auto-retry, DAN `awcms_mini_social_accounts`
  milik job itu ikut di-flip ke `needs_reauth`
  (`markSocialAccountNeedsReauth`) — reconnect via `POST .../accounts`
  (upsert) adalah SATU-SATUNYA jalur reauthorization, tidak ada endpoint
  "reauthorize" terpisah.
- Provider tanpa adapter terdaftar (`getSocialProviderAdapter` return
  `undefined`): `failed` terminal SEGERA (errorCode
  `provider_not_registered`, `retryable: false`) — tidak masuk siklus
  retry sama sekali (menambah adapter tidak akan pernah membuat retry
  otomatis berhasil sebelum ada yang mem-retry manual).

### File yang dibuat/diubah (referensi cepat)

- `sql/053_awcms_mini_social_publishing_schema.sql` (6 tabel + 10
  permission seed).
- `src/modules/identity-access/domain/access-control.ts` (`connect`/
  `disconnect` ditambah ke `AccessAction` + `HIGH_RISK_ACTIONS`).
- `src/modules/social-publishing/domain/`: `social-publishing-config.ts`,
  `social-provider-adapter.ts`, `social-publish-retry.ts`,
  `social-publish-idempotency.ts`, `social-account-validation.ts`,
  `social-publish-rule-validation.ts`,
  `social-publish-template-validation.ts`.
- `src/modules/social-publishing/application/`:
  `article-canonical-url.ts`, `social-account-directory.ts`,
  `social-publish-rule-directory.ts`,
  `social-publish-template-directory.ts`,
  `social-publishing-settings-directory.ts`,
  `create-social-publish-jobs.ts`, `social-publish-job-directory.ts`,
  `social-publish-dispatch.ts`, `social-publishing-port-adapter.ts`.
- `src/modules/social-publishing/infrastructure/social-provider-registry.ts`.
- `src/modules/social-publishing/module.ts`; registered in
  `src/modules/index.ts`.
- `src/modules/_shared/ports/social-publishing-port.ts` (baru);
  `src/modules/blog-content/module.ts` (`capabilities.consumes` +
  `social_publishing`, optional).
- `src/modules/blog-content/application/blog-scheduled-publish.ts`
  (parameter `socialPublishingPort` opsional).
- `src/pages/api/v1/blog/posts/[id]/publish.ts` (composition root,
  memanggil `socialPublishingPort.onArticlePublished`).
- `scripts/blog-scheduled-publish.ts` (composition root, wiring port).
- `src/pages/api/v1/social-publishing/{accounts,rules,templates,jobs,settings}/**`.
- `scripts/social-publish-dispatch.ts`
  (`bun run social-publishing:dispatch`).
- `src/pages/admin/social-publishing/{accounts,rules,jobs}.astro`.
- `openapi/modules/social-publishing.openapi.yaml`.
- `asyncapi/awcms-mini-domain-events.asyncapi.yaml` (15 channel/operation
  baru, `awcms-mini.social-publishing.*`).
- `scripts/validate-env.ts` (`checkSocialPublishingProfileConfig`),
  `scripts/security-readiness.ts`
  (`checkSocialPublishingProviderReadiness`), `src/lib/config/registry.ts`,
  `.env.example`, `18_configuration_env_reference.md`.
- `i18n/en.po`, `i18n/id.po`, `i18n/messages.pot` (69 key baru,
  `admin.social_publishing.*`/`admin.layout.nav_social_publishing_*`).
- Test: `tests/unit/social-publishing-config.test.ts`,
  `tests/unit/social-publish-retry.test.ts`,
  `tests/unit/social-publish-idempotency.test.ts`,
  `tests/unit/social-account-validation.test.ts`,
  `tests/unit/social-publish-template-validation.test.ts`,
  `tests/modules/social-publishing-module.test.ts`,
  `tests/integration/social-publishing.integration.test.ts`; diperbarui:
  `tests/foundation.test.ts` (migration list 050).
- Changeset: `.changeset/social-publishing-outbox-foundation-issue-643.md`.

### Belum/di luar cakupan issue ini (untuk #644/#645/#646/#647)

- Provider adapter nyata Meta/Instagram (#644), LinkedIn (#645), Telegram
  (#646) — nol panggilan HTTP eksternal hari ini.
- Integrasi secret-manager nyata untuk resolusi `token_reference` ->
  kredensial — hari ini murni konvensi/heuristic, bukan kode yang benar-
  benar memanggil secret storage.
- Endpoint/UI "manual editor action" nyata untuk trigger
  `manual_editor_action` (dimodelkan penuh di `awcms_mini_social_publish_rules.trigger_event`,
  tapi belum ada tombol "Post to X now" di editor artikel) — issue
  lanjutan yang menambah UI itu harus tetap memakai
  `createSocialPublishJobsForArticle`/`SocialPublishingPort` yang sudah
  ada, bukan jalur baru.
- Auto-requeue job `needs_reauth` begitu akun reconnect — hari ini job
  yang sudah `needs_reauth` harus di-retry manual via `POST
.../jobs/{id}/retry` setelah akun reconnect, tidak otomatis.
- Admin UI khusus untuk `awcms_mini_social_publish_templates` sebagai
  halaman terpisah — digabung ke halaman rules (`/admin/social-
publishing/rules`), bukan halaman sendiri (sama pola "cukup di satu
  halaman config" beberapa modul lain di repo ini).
- Full keyset pagination untuk `GET /api/v1/social-publishing/jobs` —
  hari ini bounded `LIMIT` sederhana (maks 200), didokumentasikan sebagai
  follow-up bila volume job jadi besar.

## §644 — Adapter Meta: Facebook Page + Instagram Business (Selesai)

Adapter provider NYATA pertama di epic ini. Registrasi TIDAK BERSYARAT
(selalu dipanggil saat `social-provider-registry.ts` di-import — lihat
Keputusan kunci di bawah), independen dari `META_PROVIDER_ENABLED` (yang
hanya menggerbang PERILAKU adapter saat dipanggil, bukan apakah ia
terdaftar).

### Keputusan kunci #644-1 — DUA provider key terpisah, satu row akun = satu tujuan publish

`meta_facebook_page` (Facebook Page, link post ke `/{page-id}/feed`) dan
`meta_instagram` (Instagram Business, 2-call media container -> publish
ke `/{ig-user-id}/media` lalu `.../media_publish`) adalah DUA adapter
terpisah, masing-masing `providerKey` sendiri. TIDAK ada satu row
`awcms_mini_social_accounts` yang mewakili "koneksi Meta" gabungan —
tenant menghubungkan SATU row per tujuan publish (satu untuk Page, satu
lagi untuk IG bila keduanya diinginkan), `providerAccountId` untuk
`meta_facebook_page` adalah Facebook Page ID, untuk `meta_instagram`
adalah Instagram Business Account ID. **Sengaja TIDAK menambah migration
baru** untuk field metadata "account.metadata" yang disebut body issue
(`facebook_page_id`, `facebook_page_name`, `instagram_business_account_id`,
`instagram_username`, `permissions_json`, `token_expires_at`,
`last_verified_at`) — SEMUA field itu sudah punya padanan 1:1 di kolom
generik #643 (`provider_account_id`/`_name` untuk dua field pertama tiap
providerKey, `scopes_json` untuk `permissions_json`, `expires_at`/
`last_verified_at` untuk dua field terakhir). Jangan menambah kolom
metadata baru untuk ini kecuali benar-benar menemukan kebutuhan yang
TIDAK bisa dipetakan ke skema #643 yang sudah ada.

`provider_account_type` untuk KEDUA provider key ini selalu `"page"` —
lihat `SocialProviderAdapter.supportedAccountTypes` di bawah untuk
alasannya (IG Business tetap dipublish lewat Page access token, tidak
ada tipe akun IG standalone di real Meta API).

### Keputusan kunci #644-2 — `SocialProviderAdapter.supportedAccountTypes` (field BARU, opsional, additive)

Interface `domain/social-provider-adapter.ts` (foundation #643) tidak
punya cara bagi pemanggil untuk tahu tipe akun apa yang didukung suatu
adapter. Ditambah field opsional `supportedAccountTypes?:
readonly SocialAccountType[]` — `undefined` berarti "tidak ada
pembatasan tipe" (bukan "tidak ada tipe yang didukung"). Field ini
DIBACA oleh dua tempat: `application/social-account-verification.ts`
(endpoint verify) dan `scripts/security-readiness.ts`'s
`checkMetaSocialPublishingAccountReadiness`. **Bila #645/#646 juga
menambah field yang sama** (kemungkinan besar, karena LinkedIn/Telegram
punya batasan tipe akun serupa) — ini penambahan ADDITIVE murni di file
yang sama, seharusnya trivial di-merge (bukan konflik nyata, hanya
tumpang tindih lokasi insersi).

### Keputusan kunci #644-3 — resolusi `token_reference` LOKAL per-adapter, skema `env:VAR_NAME` SATU-SATUNYA yang diimplementasikan

`infrastructure/meta/meta-token-reference-resolver.ts`'s
`resolveMetaTokenReference` HANYA mendukung skema `env:VAR_NAME` (baca
`process.env[VAR_NAME]`) — skema lain yang lolos validasi FORMAT di
`looksLikeRawSecretToken` (`secretsmanager:`, `vault:`, `kms:`, `ssm:`)
diterima sebagai bentuk REFERENSI yang sah tapi TIDAK bisa diresolusi
deployment ini (return `null`, fail closed -> `needs_reauth`, bukan
throw). Ini SENGAJA tidak dipromosikan ke file bersama meskipun logikanya
generik — Keputusan kunci #3 §643 eksplisit bilang resolusi token adalah
tanggung jawab MASING-MASING adapter. **Wajib untuk #645/#646**: bila
kalian butuh resolusi serupa, salin pola ini (fungsi lokal per-modul),
JANGAN mengimpor fungsi ini dari modul Meta — itu akan membuat
`social_publishing` bergantung pada implementasi provider tertentu.

Fungsi yang SAMA dipakai untuk `META_APP_SECRET_REFERENCE` (dibutuhkan
untuk membangun app access token `{appId}|{appSecret}` saat memanggil
`debug_token`).

### Keputusan kunci #644-4 — `verifyCredentials` dipanggil dari route HTTP, TAPI tetap di luar transaksi DB

`domain/social-provider-adapter.ts`'s `verifyCredentials` docstring
(#643) sudah eksplisit menyebut ini dipanggil dari "readiness gate atau
manual verify connection admin action" — BEDA dari `publish()` yang
HANYA boleh dipanggil dispatcher. Endpoint baru `POST
/api/v1/social-publishing/accounts/{id}/verify`
(`application/social-account-verification.ts`'s
`verifySocialAccountConnection`) tetap memakai disiplin 3-fase yang sama
persis dispatcher (fetch dalam transaksi pendek -> panggil provider DI
LUAR transaksi manapun -> persist hasil dalam transaksi pendek kedua) —
BUKAN pola `module-management/application/health-registry.ts`'s
`providerHealthCheckSignal` (yang memanggil `resolveEmailProvider().healthCheck()`
DI DALAM `tx` yang sama dengan pemanggilnya). Precedent itu ada dan
sudah pernah lolos review, tapi epic social-publishing ini sudah
melewati 3 ronde security-auditor pada isu terkait — pilih disiplin
yang lebih ketat untuk kode BARU di modul ini, jangan ikuti precedent
yang lebih longgar dari modul lain.

Konsekuensi: `social-account-directory.ts` sekarang punya DUA
pengecualian pada aturan "`token_reference` tidak pernah di-select" —
`fetchSocialAccountTokenReferenceForDispatch` (dispatcher, sudah ada) dan
`fetchSocialAccountTokenReferenceForVerification` (BARU, endpoint verify
saja). **Wajib untuk #645/#646**: JANGAN menambah pengecualian ketiga
tanpa alasan setara — reuse salah satu dari dua ini bila memungkinkan.

### Keputusan kunci #644-5 — Graph API client injectable, mirror pola `mailketing-provider.ts`

`infrastructure/meta/meta-graph-client.ts`'s `createMetaGraphClient`
menerima `fetchImpl`/`baseUrl` opsional (default `fetch` global +
`https://graph.facebook.com`) — TEPAT pola yang sudah ada
`email/infrastructure/mailketing-provider.ts`'s `MailketingProviderConfig`
pakai (bukan pola baru). Kedua adapter (`meta-facebook-page-adapter.ts`,
`meta-instagram-adapter.ts`) menerima `graphClientFactory` opsional di
constructor-nya sendiri (`createMetaFacebookPageAdapter(options)`) —
test mengganti factory ini dengan fake yang mengimplementasikan
`MetaGraphClient.call()`, TIDAK PERNAH melakukan panggilan `fetch` asli.
**Wajib untuk #645/#646**: pakai pola yang SAMA (client/provider object
injectable via constructor option adapter kalian sendiri) — jangan
memanggil `fetch`/library HTTP langsung dari dalam `publish()`/
`verifyCredentials()` tanpa lapisan yang bisa diganti saat test.

### Keputusan kunci #644-6 — normalisasi error TIDAK PERNAH meneruskan teks/fbtrace_id asli dari Meta

`domain/meta-error-normalization.ts`'s `normalizeMetaGraphApiError`
memetakan `error.code`/`error.type` Meta ke katalog TETAP pesan aman
(`meta_oauth_exception_190`, `meta_permission_error_10`,
`meta_rate_limited_32`, dst.) — `error.message`/`fbtrace_id` Meta yang
asli TIDAK PERNAH masuk ke `errorMessage`/log/response manapun, walau
teks itu biasanya aman (issue security notes eksplisit minta "jangan log
identifier pengguna/halaman di luar yang dibutuhkan"). **Wajib untuk
#645/#646**: bila platform kalian juga mengembalikan pesan error
berformat bebas, JANGAN meneruskannya verbatim — buat katalog pesan
tetap sendiri seperti ini.

### Keputusan kunci #644-7 — R2 image re-validation di titik penggunaan (defense-in-depth, bukan re-implementasi enforcement #636)

`domain/meta-publish-content.ts`'s `isAcceptableProviderMediaUrl`
membandingkan `new URL(url).host` PERSIS terhadap
`new URL(env.NEWS_MEDIA_R2_PUBLIC_BASE_URL).host` — BUKAN
substring/prefix check (pelajaran Issue #635: trailing-dot FQDN bisa
membypass prefix check). Ini murni defense-in-depth: `content.imageUrl`
pada job SUDAH dijamin verified oleh `create-social-publish-jobs.ts`
(foundation #643) via `NewsMediaPort.resolveMediaReferences` — adapter
ini TIDAK pernah menerima URL gambar dari sumber lain (caption custom
editor hanya berupa TEKS, bukan URL). Re-check ini hanya jaring pengaman
titik-terakhir sebelum panggilan eksternal, bukan mekanisme enforcement
baru — jangan disalahartikan sebagai pengulangan pola tenant-state Issue
#636 (itu soal SIAPA yang boleh menulis sinyal keamanan; ini soal
validasi ulang nilai yang sudah dipercaya sebelum keluar sistem).

### Keputusan kunci #644-8 — idempotensi: tanggung jawab adapter berhenti di meneruskan `idempotencyKey`, dedup NYATA tetap di dispatcher

Meta Graph API TIDAK punya parameter idempotency-key nyata untuk
`/feed`/`/media`/`/media_publish` — adapter ini TIDAK mengimplementasikan
dedup sendiri. Dicatat eksplisit di test
(`tests/unit/meta-instagram-adapter.test.ts`'s "idempotency" describe
block): memanggil `publish()` dua kali dengan `idempotencyKey` yang sama
tetap menghasilkan dua panggilan Graph API independen — pencegahan
duplikat NYATA adalah transisi status job (`pending`/`approved` ->
`publishing` -> `published`, tidak pernah diklaim ulang) yang SUDAH ada
di `social-publish-dispatch.ts` (foundation #643, teruji di
`tests/integration/social-publishing.integration.test.ts` dan
`tests/unit/social-publish-idempotency.test.ts`). **Wajib untuk
#645/#646**: jangan berpura-pura mengimplementasikan idempotency-level-
adapter kalau platform kalian juga tidak punya mekanisme itu — dokumentasikan
residual ini secara jujur seperti di sini.

### Alur koneksi (tidak ada route OAuth baru)

Endpoint connect/disconnect generik #643 (`POST/POST .../accounts`,
`.../accounts/{id}/disconnect`) dipakai APA ADANYA untuk Meta — tidak
ada endpoint/redirect OAuth baru di issue ini. Operator menyelesaikan
alur OAuth Meta di luar aplikasi (atau proses operasional lain yang
menghasilkan Page Access Token jangka panjang), lalu mengisi form
connect manual dengan `providerAccountId`/`Name`/`tokenReference`.
`META_OAUTH_REDIRECT_URI` didokumentasikan untuk keperluan pendaftaran
app review/dashboard Meta saja — BUKAN endpoint yang benar-benar ada di
repo ini. `POST .../accounts/{id}/verify` (BARU, endpoint provider-
netral tapi baru benar-benar melakukan sesuatu untuk Meta hari ini)
memanggil `debug_token` secara live untuk memeriksa validitas/scope/
kedaluwarsa.

### File yang dibuat/diubah (referensi cepat)

- `src/modules/social-publishing/domain/`: `meta-provider-config.ts`,
  `meta-publish-content.ts`, `meta-error-normalization.ts`;
  `social-provider-adapter.ts` (+`supportedAccountTypes` opsional).
- `src/modules/social-publishing/infrastructure/meta/`:
  `meta-graph-client.ts`, `meta-token-reference-resolver.ts`,
  `meta-credential-verification.ts`, `meta-facebook-page-adapter.ts`,
  `meta-instagram-adapter.ts`.
- `src/modules/social-publishing/infrastructure/social-provider-registry.ts`
  (blok registrasi additive di akhir file — lihat komentar di sana untuk
  konvensi merge multi-adapter).
- `src/modules/social-publishing/application/social-account-directory.ts`
  (+`fetchSocialAccountTokenReferenceForVerification`,
  `+recordSocialAccountVerificationSuccess`),
  `social-account-verification.ts` (BARU).
- `src/pages/api/v1/social-publishing/accounts/[id]/verify.ts` (BARU).
- `src/pages/admin/social-publishing/accounts.astro` (tombol "Verify
  connection").
- `scripts/validate-env.ts` (`checkMetaSocialPublishingProviderConfig`),
  `scripts/security-readiness.ts`
  (`checkMetaSocialPublishingAccountReadiness`),
  `src/lib/config/registry.ts`, `.env.example`,
  `18_configuration_env_reference.md`.
- `src/lib/i18n/error-messages.ts` (+`SOCIAL_ACCOUNT_NEEDS_REAUTH`,
  `SOCIAL_ACCOUNT_UNSUPPORTED_TYPE`, `PROVIDER_NOT_REGISTERED`).
- `openapi/modules/social-publishing.openapi.yaml` (+`.../verify`),
  `asyncapi/awcms-mini-domain-events.asyncapi.yaml`
  (+`account.verified`), `module.ts` (+event, deskripsi diperbarui).
- `i18n/en.po`, `i18n/id.po`, `i18n/messages.pot` (5 key baru).
- Test: `tests/unit/meta-provider-config.test.ts`,
  `tests/unit/meta-publish-content.test.ts`,
  `tests/unit/meta-error-normalization.test.ts`,
  `tests/unit/meta-token-reference-resolver.test.ts`,
  `tests/unit/meta-facebook-page-adapter.test.ts`,
  `tests/unit/meta-instagram-adapter.test.ts`,
  `tests/integration/social-publishing-meta-adapter.integration.test.ts`;
  diperbarui: `tests/modules/social-publishing-module.test.ts` (16 event).
- Changeset: `.changeset/social-publishing-meta-adapter-issue-644.md`.
- TIDAK ada migration baru — lihat Keputusan kunci #644-1.

### Belum/di luar cakupan issue ini (untuk #645/#646/#647)

- Route OAuth authorization-code exchange nyata untuk Meta — akun
  dihubungkan manual lewat form generik #643 hari ini.
- Integrasi secret-manager nyata — `env:VAR_NAME` tetap satu-satunya
  skema `token_reference`/`META_APP_SECRET_REFERENCE` yang benar-benar
  bisa diresolusi.
- Stories/Reels, WhatsApp auto posting, sinkronisasi metrik sosial,
  moderasi komentar sosial — eksplisit di luar cakupan body issue #644.
- Auto-requeue job `needs_reauth` setelah reconnect — masih warisan
  #643, belum berubah.
