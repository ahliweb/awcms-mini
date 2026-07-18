# News Portal — Social Publishing (Auto Posting) Architecture

Dokumen ini menjelaskan arsitektur **social publishing / auto posting**
(epic `social_publishing`, Issue #643-#647) — sistem yang memposting
artikel berita secara **otomatis** ke akun media sosial milik tenant,
berbeda total dari tombol share manual pembaca yang dibahas di
[`social-sharing.md`](social-sharing.md). Modul yang mengimplementasikan
ini: `src/modules/social-publishing/`.

## 1. Full-online-only — gerbang dua-flag deployment

Auto-posting **hanya** aktif pada deployment full-online yang
mengaktifkan **kedua** env berikut sekaligus (pola yang sama
`AUTH_ONLINE_SECURITY_ENABLED`/`_PROFILE` pakai, **bukan** reuse
`NEWS_PORTAL_ENABLED`/`_PROFILE` — tenant bisa full-online untuk
`news_portal` tanpa pernah mau auto-posting sosial, dan sebaliknya):

| Variabel                    | Nilai valid                                           | Default |
| --------------------------- | ----------------------------------------------------- | ------- |
| `SOCIAL_PUBLISHING_ENABLED` | `true`/`false`                                        | `false` |
| `SOCIAL_PUBLISHING_PROFILE` | `full_online` (satu-satunya nilai valid selain unset) | unset   |

Resolver: `src/modules/social-publishing/domain/social-publishing-config.ts`'s
`isSocialPublishingDeploymentActive(env)`. Ditegakkan `bun run
config:validate` (`checkSocialPublishingProfileConfig`) dan `bun run
security:readiness` (`checkSocialPublishingProviderReadiness`,
critical). Mengaktifkan flag ini **hanya** menyalakan
schema/outbox/queue/approval/retry — **tidak** ada satu pun panggilan
HTTP nyata ke platform sosial sampai adapter provider terkait juga
diaktifkan (§4).

Ini hanya setengah dari syarat "Auto-posting can be disabled globally
and per tenant": setengah lain adalah toggle per-tenant di
`awcms_mini_social_publishing_settings` (`GET/PATCH
/api/v1/social-publishing/settings`, permission `rules.configure`) —
tabel ini **sengaja tenant-writable** (preferensi bisnis biasa, bukan
kontrol keamanan), berbeda dari tabel status Issue #636 yang memang
harus zero-write-surface untuk tenant.

## 2. Model data — 6 tabel

Migration `sql/053_awcms_mini_social_publishing_schema.sql` (+
`sql/055_awcms_mini_social_publishing_verify_permission.sql` untuk
permission `accounts.verify`):

| Tabel                                   | Peran                                                                 |
| --------------------------------------- | --------------------------------------------------------------------- |
| `awcms_mini_social_accounts`            | Koneksi akun sosial per tenant (`token_reference`, bukan token nyata) |
| `awcms_mini_social_publish_rules`       | Aturan publish per akun/trigger event, gerbang approval opsional      |
| `awcms_mini_social_publish_templates`   | Template caption per rule                                             |
| `awcms_mini_social_publish_jobs`        | Outbox — satu baris per artikel/akun/aksi, idempoten                  |
| `awcms_mini_social_publish_attempts`    | Append-only, satu baris per percobaan dispatch (audit trail)          |
| `awcms_mini_social_publishing_settings` | Toggle auto-posting per-tenant (`tenant_id` PK)                       |

Semua tabel di-RLS tenant-isolated sesuai konvensi doc 16. Sepuluh
permission tetap (`social_publishing.accounts.{read,connect,disconnect,
verify}`, `.rules.{read,configure}`, `.jobs.{read,approve,cancel,
retry}`, `.logs.read`) — `accounts.connect`/`.disconnect` masuk
`HIGH_RISK_ACTIONS` (menyentuh kredensial), `accounts.verify` tidak
(hanya membaca/memvalidasi, lihat §7).

## 3. `token_reference` — referensi, bukan token nyata

`awcms_mini_social_accounts.token_reference` adalah string buram
(mis. `"env:META_APP_SECRET_EXAMPLE"`,
`"secretsmanager:social/fb-page-example"`) yang menunjuk ke secret
storage eksternal. **Repo ini belum punya integrasi secret-manager
nyata** — ini adalah residual/follow-up yang terdokumentasi, bukan
sesuatu yang diselesaikan epic ini. `token_reference` **tidak pernah**
diselect kembali oleh query mana pun kecuali dua fungsi internal,
masing-masing untuk satu keperluan sempit:
`fetchSocialAccountTokenReferenceForDispatch` (dipanggil **hanya** dari
dispatcher) dan `fetchSocialAccountCredentialsForVerification`
(dipanggil **hanya** dari endpoint `POST .../accounts/{id}/verify`,
lihat §7). Jaminan sebenarnya adalah **"tidak pernah dikembalikan dari
`GET /accounts`"** (endpoint yang dibaca admin untuk daftar akun) —
bukan "tidak pernah dari route HTTP apa pun", karena endpoint verify di
atas memang route HTTP yang sengaja butuh nilai ini untuk memanggil
provider — pola yang sama `tenant-domain-directory.ts`'s
`verification_token_hash` pakai untuk prinsip "hanya diselect oleh
fungsi yang benar-benar butuh nilainya". Disconnect membersihkan
`token_reference` ke `NULL`, bukan sekadar flip status.

Detail lengkap heuristic penolakan token mentah
(`looksLikeRawSecretToken`) dan resolusi `env:VAR_NAME` per-adapter ada
di [`social-publishing-security-checklist.md`](social-publishing-security-checklist.md)
§Token storage — dokumen ini fokus arsitektur, bukan mekanisme
keamanan detail.

## 4. Provider adapter — interface pluggable, 4 adapter terdaftar

`domain/social-provider-adapter.ts` mendefinisikan `SocialProviderAdapter`
(`providerKey`, `requiredEnvVars`, `supportedAccountTypes?`, `publish()`,
`verifyCredentials()`). `infrastructure/social-provider-registry.ts`
adalah singleton registry — setiap adapter mendaftar dari **composition
root miliknya sendiri** (side-effect import/fungsi
`registerXProviderAdapterIfEnabled`), tidak pernah dari dalam
`application`/`domain`.

| `provider_key`          | Platform                        | Gate aktivasi terpisah      |
| ----------------------- | ------------------------------- | --------------------------- |
| `meta_facebook_page`    | Facebook Page (link post)       | `META_PROVIDER_ENABLED`     |
| `meta_instagram`        | Instagram Business (image post) | `META_PROVIDER_ENABLED`     |
| `linkedin_organization` | LinkedIn organization page      | `LINKEDIN_PROVIDER_ENABLED` |
| `telegram_channel`      | Telegram channel (via bot)      | `TELEGRAM_PROVIDER_ENABLED` |

Setiap gate adapter **independen** dari `SOCIAL_PUBLISHING_ENABLED` —
deployment bisa menjalankan outbox untuk sebagian provider saja tanpa
menyalakan yang lain. `provider_key` divalidasi hanya secara **format**
(`^[a-z][a-z0-9_]{1,49}$`), bukan `CHECK` enum tetap — provider baru
tidak butuh migration schema baru. Job untuk provider tanpa adapter
terdaftar langsung `failed` terminal (errorCode
`provider_not_registered`), tidak pernah masuk siklus retry.

Detail per-provider (limitasi API, permission role yang dibutuhkan,
kapabilitas) ada di
[`social-provider-limitations.md`](social-provider-limitations.md).

## 5. Outbox — job creation di dalam transaksi, provider call di luar (ADR-0006)

`application/create-social-publish-jobs.ts`'s
`createSocialPublishJobsForArticle` **hanya** melakukan INSERT baris
job (tanpa panggilan eksternal apa pun) — dipanggil **di dalam**
transaksi yang sama dengan transisi post `blog_content` ke
`published`, lewat `SocialPublishingPort`
(`_shared/ports/social-publishing-port.ts`, dikonsumsi
`blog-content/application/blog-scheduled-publish.ts` dan
`pages/api/v1/blog/posts/[id]/publish.ts`). Ini pola outbox yang benar
(menulis baris outbox atomis dengan event bisnis yang memicunya) —
**bukan** pelanggaran ADR-0006, karena ADR-0006 melarang panggilan
_provider_ di dalam transaksi, bukan penulisan baris outbox.

Panggilan provider nyata **hanya** terjadi di
`application/social-publish-dispatch.ts`'s `dispatchSocialPublishQueue`
(`bun run social-publishing:dispatch`, direkomendasikan berjalan setiap
1-2 menit via cron/systemd timer) — 3-fase CLAIM/CALL/FINALIZE:

1. **CLAIM** (dalam transaksi) — kunci baris job due, ubah status ke
   `publishing`.
2. **CALL** (di luar transaksi) — panggil `adapter.publish()`, dibungkus
   `withTimeout` + circuit breaker per-provider
   (`getProviderCircuitBreaker("social-publishing:${providerKey}")`).
3. **FINALIZE** (dalam transaksi) — catat hasil, transisi status, tulis
   baris attempt audit.

Pola ini identik `sync-storage/application/object-dispatch.ts`.
Adapter baru **tidak perlu** menambah circuit breaker sendiri — sudah
generik di dispatcher.

## 6. Siklus hidup job & retry/backoff

Status: `pending` → (opsional `requires_approval` snapshot →
`approved`) → `publishing` → `published` (terminal sukses) atau salah
satu jalur gagal:

- **Retryable gagal, budget tersisa**: kembali ke `pending`/`approved`
  dengan `next_attempt_at` backoff (`evaluateSocialPublishRetry`,
  formula `2^attemptCount` menit, capped
  `SOCIAL_PUBLISH_MAX_RETRY_DELAY_MINUTES=240` — sama formula
  `sync-storage/domain/object-queue.ts`'s `evaluateObjectRetry`, TIDAK
  reuse langsung karena konstanta beda per-baris vs per-modul).
- **Retry budget habis**: `failed` (terminal, `retrySocialPublishJob`
  menolak `attempt_count >= max_attempts`).
- **`rate_limited`**: backoff dari `retryAfterSeconds` provider (tidak
  pernah lebih pendek dari lantai eksponensial — mencegah provider
  memaksa retry loop rapat), tetap bisa habis budget → `failed`.
- **`needs_reauth`**: TIDAK auto-retry; `awcms_mini_social_accounts`
  milik job ikut di-flip ke `needs_reauth`
  (`markSocialAccountNeedsReauth`). Satu-satunya jalur reauthorization
  adalah reconnect via `POST .../accounts` (upsert) — tidak ada
  endpoint "reauthorize" terpisah. Lihat
  [`social-publishing-sop.md`](social-publishing-sop.md) §Reauthorization.
- **Provider tidak terdaftar**: `failed` terminal segera, tidak pernah
  masuk siklus retry.

Idempotensi job **di level baris DB**, bukan hanya disiplin aplikasi:
unique index `(tenant_id, idempotency_key)` +
`INSERT ... ON CONFLICT DO NOTHING`, `idempotency_key` dihitung
deterministik dari `(tenantId, articleId, socialAccountId, providerKey,
action)` (`domain/social-publish-idempotency.ts`). Ini terpisah dari
`Idempotency-Key` HTTP generik (dipakai endpoint
connect/disconnect/approve/cancel/retry/verify) — job creation dipicu
event internal, bukan request client.

## 7. Verifikasi akun — endpoint generik, tidak pernah gate runtime keras

`POST /api/v1/social-publishing/accounts/{id}/verify` (permission
`accounts.verify`, wajib `Idempotency-Key`, 3-fase yang sama dengan
dispatcher: transaksi → panggilan provider di luar transaksi →
transaksi) memanggil `adapter.verifyCredentials(tokenReference,
providerAccountId, scopesJson, env?)` — provider-neutral, bukan route
khusus satu provider. Kegagalan verifikasi tetap `200 { valid: false,
reason }` (informational), **tidak pernah** mengubah
`connectionStatus`/`autoPublishEnabled` job/akun — hanya percobaan
publish nyata via dispatcher yang bisa memicu `needs_reauth`.
Verifikasi **tidak** di-hardgate ke connect/enable-auto-publish;
ditegakkan sebagai _readiness signal_ operasional
(`security:readiness`'s check per-provider) — operator diharapkan
verify manual sebelum go-live per provider, bukan gate API yang
memblokir.

## 8. Gambar — R2-only, defense-in-depth di setiap adapter

`social_publishing` mengonsumsi kapabilitas `news_media` milik
`news_portal` (via `NewsMediaPort`, parameter opsional pada
`createSocialPublishingPortAdapter`, **bukan** import langsung modul
lain — pola port Issue #681) untuk resolusi gambar terverifikasi.
`content.imageUrl` pada snapshot job **sudah dijamin** berasal dari
objek R2 `verified`/`attached` milik tenant yang sama oleh
`create-social-publish-jobs.ts` — setiap adapter yang benar-benar
mengunggah/mereferensikan gambar (Meta, LinkedIn) melakukan
**pengecekan ulang** sebagai jaring pengaman titik-terakhir sebelum
panggilan eksternal, tapi **kekuatan pengecekan berbeda per adapter**
(bukan satu implementasi seragam — koreksi dari draf sebelumnya
dokumen ini, yang keliru mengklaim keduanya identik):

- **Meta** (`isAcceptableProviderMediaUrl`,
  `domain/meta-publish-content.ts`) melakukan pengecekan **host
  persis**: parse `new URL(url)`, wajib `protocol === "https:"`, lalu
  `target.host === base.host` terhadap
  `NEWS_MEDIA_R2_PUBLIC_BASE_URL` — bukan substring/prefix check,
  pelajaran trailing-dot FQDN Issue #635.
- **LinkedIn** (`isTrustedR2MediaUrl`,
  `infrastructure/linkedin-provider-adapter.ts`) hanya melakukan
  `url.startsWith(publicBaseUrl)` — **prefix/substring check biasa**,
  **tidak** melakukan `new URL()` parse, **tidak** membandingkan host,
  **tidak** memvalidasi protokol. Ini justru persis kelas pengecekan
  lemah yang pelajaran Issue #635 hindari untuk Meta — belum
  di-hardening ke pola `URL.host` yang sama (dicatat sebagai gap nyata,
  bukan diklaim sudah setara). **Issue #859 (epic #818)**: `publicBaseUrl`
  sekarang di-resolve lewat `NewsMediaPort.resolveMediaPublicBaseUrl`
  (di-inject di composition root `scripts/social-publish-dispatch.ts`),
  **bukan** lagi lewat import statis
  `news-portal/domain/news-media-r2-config.ts`'s `resolveNewsMediaR2Config`.
  Import statis itulah satu-satunya penyebab `social_publishing` dulu harus
  mendeklarasikan `news_portal` sebagai dependency HARD — yang bertentangan
  dengan `capabilities.consumes` (`news_media`, `optional: true`) modul ini
  sendiri. Setelah inversi port, penghapusan edge itu adalah perubahan
  **lifecycle**: sebuah tenant kini boleh men-disable `news_portal` selagi
  `social_publishing` tetap aktif TANPA blok reverse-dependency, dan social
  publishing tetap berjalan. **Kepercayaan/upload gambar bersifat
  DEPLOYMENT-WIDE, bukan per-tenant** — bucket R2 dan
  `NEWS_MEDIA_R2_PUBLIC_BASE_URL` adalah satu config level-deployment, jadi
  dispatcher (`scripts/social-publish-dispatch.ts`) menyuntikkan port
  process-wide dan gambar R2 yang sudah `verified` tetap diunggah tanpa
  memandang status `news_portal` per tenant mana pun (identik dengan
  perilaku pra-#859 yang membaca env deployment yang sama; #859 tidak
  mengubah tenant-awareness jalur gambar sama sekali). Degradasi ke
  link-share terjadi bila port tidak di-inject (mis. proses SSR verify yang
  tak pernah publish) atau `NEWS_MEDIA_R2_PUBLIC_BASE_URL` kosong sehingga
  `publicBaseUrl` menjadi string kosong → semua gambar dianggap tak
  terpercaya — **bukan** karena sebuah tenant mematikan `news_portal`.

Kedua pengecekan tetap murni **defense-in-depth** (bukan mekanisme
enforcement baru — data sudah diverifikasi lebih dulu oleh
`create-social-publish-jobs.ts`), jadi eksploitasi butuh sumber
`content.imageUrl` yang sudah lolos gerbang verifikasi R2 di hulu
terlebih dahulu. Kegagalan apa pun pada gambar (tidak terpercaya,
tidak ada, upload gagal) terdegradasi baik ke post teks/link-share —
gambar tidak pernah memblokir publish yang sah. Lihat
[`social-provider-limitations.md`](social-provider-limitations.md) §3
untuk detail per-provider.

## 9. Canonical URL — dari domain tenant terverifikasi

Job creation bisa dipicu worker terjadwal tanpa request HTTP masuk
sama sekali, jadi `url.origin` tidak tersedia.
`application/article-canonical-url.ts`'s
`resolvePrimaryVerifiedDomainHostname` query langsung ke
`awcms_mini_tenant_domains` (`is_primary = true AND status = 'active'`)
— pola yang sama `public-news-tenant-resolution.ts` pakai. Bila tenant
belum punya domain utama terverifikasi, job creation **skip** dengan
alasan terdokumentasi (`no_verified_domain`) — tidak pernah menebak
URL.

## 10. Events (AsyncAPI)

`asyncapi/awcms-mini-domain-events.asyncapi.yaml`, channel
`awcms-mini.social-publishing.*`: `account.{connected,disconnected,
needs-reauth,verified,verification-failed}`, `rule.{created,updated,
deleted}`, `job.{created,approved,cancelled,retry-requested,published,
publish-failed,publish-failed-terminal,rate-limited,needs-reauth}`.

## 11. Yang belum ada (residual terdokumentasi)

- Integrasi secret-manager nyata untuk resolusi `token_reference` —
  hari ini murni konvensi `env:VAR_NAME` per-adapter, bukan panggilan
  ke secret storage sungguhan.
- Auto-requeue job `needs_reauth` begitu akun reconnect — harus
  di-retry manual setelah reconnect.
- Route OAuth authorization-code exchange interaktif untuk provider
  apa pun — semua koneksi dibuat manual lewat form connect generik
  setelah operator menyelesaikan alur OAuth/app-review di luar
  aplikasi ini.
- Full keyset pagination untuk `GET /jobs` — hari ini `LIMIT`
  sederhana (maks 200).
- Auto-posting WhatsApp — **tidak diimplementasikan dan tidak
  direncanakan** sebagai kanal social-posting; lihat
  [`social-provider-limitations.md`](social-provider-limitations.md)
  §WhatsApp.

## 12. Referensi kode

- `src/modules/social-publishing/` — seluruh modul (domain/
  application/infrastructure/module.ts).
- `src/modules/_shared/ports/social-publishing-port.ts` — port yang
  dikonsumsi `blog_content`.
- `scripts/social-publish-dispatch.ts` — `bun run
social-publishing:dispatch`.
- `openapi/modules/social-publishing.openapi.yaml`,
  `asyncapi/awcms-mini-domain-events.asyncapi.yaml`.
- `.claude/skills/awcms-mini-social-publishing/SKILL.md` — rasional
  desain lengkap per issue (§643-§646), termasuk riwayat review
  keamanan.

## 13. Dokumen terkait

- [`social-sharing.md`](social-sharing.md) — fitur share manual
  (berbeda, independen).
- [`social-publishing-sop.md`](social-publishing-sop.md) — checklist
  setup per provider, SOP operasional.
- [`social-provider-limitations.md`](social-provider-limitations.md) —
  batasan per platform.
- [`social-publishing-security-checklist.md`](social-publishing-security-checklist.md) —
  kontrol keamanan, incident response.
