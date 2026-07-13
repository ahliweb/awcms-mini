# Social Publishing

Epic `social_publishing` (Issue #643-#647) — provider-neutral social
auto-posting outbox dan connector foundation di atas `blog_content`.
Modul ini (`key: social_publishing`, `type: "domain"`, `status: "active"`)
memungkinkan sebuah artikel blog yang published otomatis diteruskan (via
outbox job, bukan panggilan sinkron) ke akun media sosial tenant yang
terhubung. Lihat `.claude/skills/awcms-mini-social-publishing/SKILL.md`
untuk konteks lintas-issue lengkap dan keputusan desain.

`dependencies: ["tenant_admin", "identity_access"]` — **sengaja tidak**
menyertakan `blog_content` sebagai dependency lifecycle walau relasi
konseptual "menerima event dari blog_content" nyata; hubungan itu
dimodelkan lewat `capabilities` (lihat di bawah), bukan `dependencies`,
mengikuti preseden yang sama seperti `news_portal`/`blog_content` (ADR-0011).

## Kenapa full-online-only

Fitur ini **hanya aktif saat deployment full-online**, tidak pernah di
profil offline/LAN. `domain/social-publishing-config.ts`'s
`isSocialPublishingDeploymentActive(env)` adalah satu-satunya boolean yang
dicek oleh setiap jalur kode (job creation, dispatcher, readiness) —
`true` hanya bila **keduanya** benar:

- `SOCIAL_PUBLISHING_ENABLED=true`
- `SOCIAL_PUBLISHING_PROFILE=full_online`

Mirip persis pola `AUTH_ONLINE_SECURITY_ENABLED`/`_PROFILE`
(`src/lib/auth/online-security-config.ts`) dan sengaja **bukan** reuse
`NEWS_PORTAL_ENABLED`/`_PROFILE` — tenant bisa saja menjalankan
`news_portal` full-online tanpa pernah mau auto-posting sosial, dua
keputusan deployment yang independen. Deployment offline/LAN (kedua var
ini unset, default) selalu mendapat `false` — tidak pernah membuat job,
tidak pernah memanggil provider, tabelnya tetap ada (migration
unconditional) tapi tidak pernah diisi oleh kode aplikasi.

Selain gate deployment-level ini, ada **master switch per-tenant**
(`awcms_mini_social_publishing_settings.auto_publishing_enabled`, default
`true`) — preferensi tenant biasa, digerbangi permission `rules.configure`
biasa (bukan endpoint generic `module_settings` PATCH, yang epic #679
temukan bisa dieksploitasi untuk flag keamanan-sensitif).

## Scope per issue (epic #643-#647)

- **#643 (fondasi)** — schema 6 tabel, outbox/dispatcher (claim/call/finalize),
  approval gate, retry/backoff, interface provider-adapter (kosong, tanpa
  adapter nyata), admin UI dasar, readiness check. Nol panggilan HTTP ke
  platform sosial mana pun.
- **#644** — adapter Meta: `meta_facebook_page` (Facebook Page link post)
  dan `meta_instagram` (Instagram Business image post), gated
  `META_PROVIDER_ENABLED` (independen dari gate deployment-wide di atas).
- **#645** — adapter LinkedIn: `linkedin_organization`, gated
  `LINKEDIN_PROVIDER_ENABLED`.
- **#646** — adapter Telegram: `telegram_channel` (bot token), gated
  `TELEGRAM_PROVIDER_ENABLED`.
- **#647** — dokumentasi/SOP lintas-provider, butuh #643-#646 semua ada.
  Belum dikerjakan — README ini adalah referensi modul umum, bukan
  pengganti SOP formal yang akan dihasilkan issue tersebut.

## Tables (migration `053_awcms_mini_social_publishing_schema.sql`)

Enam tabel, semuanya tenant-scoped dengan `ENABLE`+`FORCE ROW LEVEL
SECURITY` dan policy `tenant_isolation` standar:

- **`awcms_mini_social_accounts`** — satu baris per (tenant, provider,
  akun eksternal); `token_reference` adalah pointer opaque ke secret
  storage eksternal, **bukan** OAuth token mentah (tidak pernah di-SELECT
  balik oleh query manapun, sama seperti `tenant_domain`'s
  `verification_token_hash`). `connection_status`:
  `pending|connected|disconnected|needs_reauth|error`.
  `provider_account_type`: `page|profile|channel|group|organization`.
  Unique per `(tenant_id, provider_key, provider_account_id)` — membuat
  `connect` idempoten (reconnect/reauthorize meng-upsert baris yang sama,
  tidak pernah duplikat).
- **`awcms_mini_social_publish_rules`** — satu rule per (account,
  `trigger_event`); `trigger_event`:
  `post_published|scheduled_published|manual_editor_action`.
  `requires_approval` default `true` (opt-in eksplisit untuk unattended
  posting). Soft delete standar.
- **`awcms_mini_social_publish_templates`** — caption template opsional
  per tenant (referensi polymorphic dari `rules.template_id`, tanpa FK —
  sama alasan `awcms_mini_news_media_objects.owner_resource_id`, supaya
  template bisa soft-delete tanpa pelanggaran FK; render-time fallback ke
  caption default). Soft delete standar.
- **`awcms_mini_social_publish_jobs`** — outbox-nya sendiri. `article_id`
  adalah FK **nyata** ke `awcms_mini_blog_posts` (`blog_content` selalu
  ada, bukan dependency opsional seperti R2 media). Setiap field konten
  (`title`, `excerpt_or_caption`, `canonical_url`, `image_url`) adalah
  **snapshot** saat job dibuat, bukan live join — pola outbox wajib
  (ADR-0006): dispatcher yang jalan di luar transaksi DB tidak boleh
  bergantung pada state artikel yang mungkin sudah berubah/terhapus.
  `idempotency_key` (unique per tenant) dihitung deterministik dari
  `(tenantId, articleId, socialAccountId, action)` — mencegah event publish
  yang ter-retrigger membuat job duplikat. `status`:
  `pending|requires_approval|approved|scheduled|publishing|published|failed|cancelled|skipped|rate_limited|needs_reauth`.
- **`awcms_mini_social_publish_attempts`** — append-only, satu baris per
  percobaan dispatcher apa pun hasilnya (`outcome`:
  `success|failed|rate_limited|needs_reauth|skipped`) — tidak pernah
  di-UPDATE/DELETE oleh kode aplikasi manapun.
- **`awcms_mini_social_publishing_settings`** — master switch per-tenant
  (`auto_publishing_enabled`, PK `tenant_id`).

## Permission seed (migration `053_awcms_mini_social_publishing_schema.sql`, `055_awcms_mini_social_publishing_verify_permission.sql`)

11 permission, `module_key = 'social_publishing'`, seluruhnya
dideklarasikan di `module.ts`'s `permissions` array:

- `accounts.{read,connect,disconnect}` (migration 053) + `accounts.verify`
  (migration 055, Issue #646 — permission terpisah untuk aksi "verify
  connection" manual, mereuse action `verify` yang sudah ada di
  `AccessAction` union sejak `tenant_domain.domains.verify`, bukan
  menambah action baru).
- `rules.{read,configure}` — juga menggerbangi CRUD template (tidak ada
  permission `templates.*` terpisah, deliberate — persis daftar
  "Suggested permissions" issue #643 sendiri).
- `jobs.{read,approve,cancel,retry}`.
- `logs.read` — dideklarasikan di katalog permission tapi **belum**
  punya route konsumen khusus; riwayat attempt saat ini terekspos lewat
  `GET /api/v1/social-publishing/jobs/{id}` (digerbangi `jobs.read`, bukan
  `logs.read`) yang menyertakan attempt history-nya secara embedded.

**Klasifikasi risiko** (`identity-access/domain/access-control.ts`): hanya
`connect`/`disconnect` masuk `HIGH_RISK_ACTIONS` (mengubah state
credential-bearing) — lihat `identity-access/README.md` §Vocabulary
`AccessAction` diperluas untuk penjelasan lengkap tiap action.

## `module.ts`'s own descriptor

- **`capabilities.provides: ["social_publishing"]`** — kapabilitas yang
  `blog_content` konsumsi (`optional: true` di sisi `blog_content`; sebuah
  deployment yang tidak pernah mengaktifkan `social_publishing` tetap
  publish artikel seperti biasa, panggilan port-nya jadi no-op terdokumentasi
  `{ jobsCreated: 0 }`). Lihat `_shared/README.md` §Capability Ports dan
  `_shared/ports/social-publishing-port.ts`.
- **`capabilities.consumes`** — kapabilitas `news_media` milik
  `news_portal` (`optional: true`, dipakai adapter port ini sendiri untuk
  resolve URL gambar R2 terverifikasi buat snapshot job; lihat
  `_shared/ports/news-media-port.ts`).
- **`navigation`** — 3 entri: `/admin/social-publishing/accounts` (order
  90), `/admin/social-publishing/rules` (order 91),
  `/admin/social-publishing/jobs` (order 92) — masing-masing digerbangi
  `accounts.read`/`rules.read`/`jobs.read`.
- **`api.basePath: "/api/v1/social-publishing"`**.
- **`jobs`** — satu entri, `social-publishing:dispatch` (lihat §Outbox
  dispatcher).
- **`events`** — 17 domain event dipublish (lihat §Domain events).
- Belum mendeklarasikan `settings`/`health` — belum ada per-tenant setting
  descriptor-level atau health check khusus modul ini (preferensi
  auto-posting per-tenant sudah ada tapi lewat tabel/endpoint sendiri, bukan
  `ModuleDescriptor.settings.defaults`).

## API (`/api/v1/social-publishing/**`)

```txt
GET    /api/v1/social-publishing/accounts               list akun terhubung
POST   /api/v1/social-publishing/accounts               connect/reconnect akun (accounts.connect)
GET    /api/v1/social-publishing/accounts/{id}           detail akun
PATCH  /api/v1/social-publishing/accounts/{id}           update akun
POST   /api/v1/social-publishing/accounts/{id}/disconnect  disconnect akun
POST   /api/v1/social-publishing/accounts/{id}/verify       verify credential/koneksi (Issue #646)
GET    /api/v1/social-publishing/rules                  list rule (rules.read)
POST   /api/v1/social-publishing/rules                  buat rule (rules.configure)
PATCH  /api/v1/social-publishing/rules/{id}              update rule (rules.configure)
DELETE /api/v1/social-publishing/rules/{id}              soft delete rule (rules.configure)
GET    /api/v1/social-publishing/templates               list caption template (rules.read)
POST   /api/v1/social-publishing/templates               buat template (rules.configure)
PATCH  /api/v1/social-publishing/templates/{id}           update template (rules.configure)
DELETE /api/v1/social-publishing/templates/{id}           soft delete template (rules.configure)
GET    /api/v1/social-publishing/jobs                    list job (outbox), keyset-paginated
GET    /api/v1/social-publishing/jobs/{id}                detail job + attempt history embedded
POST   /api/v1/social-publishing/jobs/{id}/approve         approve job requires_approval
POST   /api/v1/social-publishing/jobs/{id}/cancel          cancel job
POST   /api/v1/social-publishing/jobs/{id}/retry            retry job failed/rate_limited/needs_reauth
GET    /api/v1/social-publishing/settings                 baca master switch auto-posting tenant
PATCH  /api/v1/social-publishing/settings                 ubah master switch (rules.configure)
```

Setiap route: thin orchestration (`src/pages/api/v1/social-publishing/**`)
di atas `application/social-account-directory.ts`,
`social-publish-rule-directory.ts`, `social-publish-template-directory.ts`,
`social-publish-job-directory.ts`, `social-publishing-settings-directory.ts`
— pola yang sama seperti modul lain (`authorizeInTransaction` di dalam
`withTenant`, RLS `FORCE` sebagai defense-in-depth di bawah setiap filter
`tenant_id` eksplisit).

**Admin UI**: `src/pages/admin/social-publishing/{accounts,rules,jobs}.astro`
— 3 halaman (rules.astro juga meng-cover CRUD template; belum ada halaman
admin khusus untuk `settings`, saat ini API-only).

## Job creation — `application/create-social-publish-jobs.ts`

Dipanggil oleh `blog_content`'s publish route/scheduled-publish worker
lewat `SocialPublishingPort.onArticlePublished(...)` (bukan import
langsung — lihat `_shared/ports/social-publishing-port.ts`) tepat setelah
sebuah artikel ELIGIBLE (public + published, bukan
draft/private/archived/review/soft-deleted) publish. Membuat satu outbox
row per (rule aktif × account) yang cocok dengan `trigger_event` —
murni tulis DB di dalam transaksi CALLER yang sama (ADR-0006 compliant:
tidak ada panggilan eksternal di sini). `INSERT ... ON CONFLICT DO NOTHING`
pada `idempotency_key` membuat panggilan berulang (mis. scheduled-publish
worker retry setelah crash) tidak pernah membuat job kedua untuk
artikel/account/action yang sama.

## Outbox dispatcher — `application/social-publish-dispatch.ts` (`bun run social-publishing:dispatch`)

Pola 3-fase CLAIM/CALL/FINALIZE yang sama seperti
`sync-storage/application/object-dispatch.ts` (ADR-0006):

1. **CLAIM** — satu transaksi pendek membalik baris `pending`/`approved`
   yang eligible ke `publishing` (`FOR UPDATE SKIP LOCKED`, reuse
   `next_attempt_at` sebagai lease expiry) lalu commit segera — belum ada
   panggilan provider di sini.
2. **CALL** — untuk tiap baris yang di-claim, resolve adapter dari
   `infrastructure/social-provider-registry.ts`; job dengan `provider_key`
   yang belum punya adapter terdaftar berakhir `failed` terminal
   (`errorCode: "provider_not_registered"`, tidak retryable). Bila circuit
   breaker provider itu (`getProviderCircuitBreaker`) mengizinkan,
   `adapter.publish()` dipanggil **di luar** transaksi apa pun, dibungkus
   `withTimeout`.
3. **FINALIZE** — satu transaksi pendek per baris menerapkan hasil:
   sukses → `published`; gagal retryable dengan budget tersisa → kembali
   ke `pending` dengan backoff (`domain/social-publish-retry.ts`); gagal
   tidak retryable atau budget habis → `failed` terminal; `needs_reauth` →
   menandai akun `needs_reauth` (`markSocialAccountNeedsReauth`) dan job
   `needs_reauth`, tidak retry otomatis (butuh reconnect manual);
   `rate_limited` → backoff memakai `retryAfterSeconds` provider bila ada.
   Setiap attempt (apa pun hasilnya) menulis satu baris append-only ke
   `awcms_mini_social_publish_attempts`.

Job ini `safeInOfflineLan: false` — no-op saat `SOCIAL_PUBLISHING_ENABLED`
bukan `"true"` atau `SOCIAL_PUBLISHING_PROFILE` bukan `"full_online"`.
Jadwal yang direkomendasikan: setiap 1-2 menit via cron/systemd timer.

## Provider adapters (`domain/social-provider-adapter.ts`'s `SocialProviderAdapter` interface)

Interface provider-neutral — tidak berasumsi OAuth vs bot-token, tidak
berasumsi dukungan gambar, tidak berasumsi batas karakter; setiap adapter
menangani itu secara internal. Dispatcher hanya pernah bergantung pada
interface ini, tidak pernah SDK/API spesifik satu provider. Tiga adapter
nyata terdaftar (`infrastructure/social-provider-registry.ts`, dimulai
kosong di Issue #643):

- **Meta** (`infrastructure/meta/`, Issue #644) — dua adapter:
  `meta-facebook-page-adapter.ts` (`providerKey: "meta_facebook_page"`,
  Facebook Page link post) dan `meta-instagram-adapter.ts`
  (`providerKey: "meta_instagram"`, Instagram Business image post).
  Gated adapter-level oleh `META_PROVIDER_ENABLED` (independen dari gate
  deployment-wide `SOCIAL_PUBLISHING_*`).
- **LinkedIn** (`infrastructure/linkedin-provider-adapter.ts`, Issue #645)
  — `providerKey: "linkedin_organization"`, publish ke LinkedIn
  organization page. Gated `LINKEDIN_PROVIDER_ENABLED`.
- **Telegram** (`infrastructure/telegram-provider-adapter.ts`, Issue #646)
  — `providerKey: "telegram_channel"`, publish via bot token ke channel.
  Gated `TELEGRAM_PROVIDER_ENABLED`. Adapter pertama yang mengimplementasi
  `verifyCredentials` dengan `providerAccountId` sebagai parameter wajib
  (dipakai endpoint `POST .../accounts/{id}/verify`).

Setiap adapter: `publish()` tidak pernah throw untuk outcome provider yang
wajar (rate limit, token expired, content policy) — itu semua nilai
`SocialProviderPublishResult` biasa; throw direservasi untuk kondisi
sungguh tak terduga (network error, bug), yang dispatcher tangkap sebagai
`failed` retryable. `verifyCredentials()` tidak pernah throw, selalu
mengembalikan `{valid: false, reason}` saat gagal. `requiredEnvVars` tiap
adapter dikonsumsi readiness check
(`scripts/security-readiness.ts`'s `checkSocialPublishingProviderReadiness`),
bukan dipaksakan oleh file adapter itu sendiri.

## Domain events (`asyncapi/awcms-mini-domain-events.asyncapi.yaml`)

17 event dipublish, channel `awcms-mini.social-publishing.*`:

- **Account**: `.account.connected`, `.account.disconnected`,
  `.account.needs-reauth`, `.account.verified`,
  `.account.verification-failed`.
- **Rule**: `.rule.created`, `.rule.updated`, `.rule.deleted`.
- **Job**: `.job.created`, `.job.approved`, `.job.cancelled`,
  `.job.retry-requested`, `.job.published`, `.job.publish-failed`,
  `.job.publish-failed-terminal`, `.job.rate-limited`, `.job.needs-reauth`.

Kontrak-dokumentasi-saja, konvensi structured-logger-producer yang sama
seperti event modul lain (bukan message broker sungguhan).

## Keamanan

- `token_reference` tidak pernah menyimpan token OAuth mentah — hanya
  pointer opaque ke secret storage eksternal
  (`social-account-validation.ts`'s `looksLikeRawSecretToken` menolak best-effort
  nilai yang terlihat seperti bearer token/JWT asli).
- Tidak ada query manapun yang men-SELECT `token_reference` balik ke
  response (`social-account-directory.ts`).
- Error dari provider disanitasi (`errorCode`/`errorMessage` aman untuk
  log/audit) sebelum masuk `awcms_mini_social_publish_attempts` atau
  response API — tidak pernah raw provider error body yang bisa membawa
  token.
- `connect`/`disconnect` wajib `Idempotency-Key` dan diklasifikasikan
  `HIGH_RISK_ACTIONS` (lihat §Permission seed di atas).
- Setiap mutation (`connect`/`disconnect`/`verify`/rule
  create-update-delete/job approve-cancel-retry) menulis
  `recordAuditEvent` eksplisit di dalam transaksi yang sama.

## Belum tersedia

- Dokumentasi/SOP formal lintas-provider (Issue #647) — README ini adalah
  referensi modul umum, bukan penggantinya.
- Halaman admin khusus untuk `settings` (master switch auto-posting) —
  saat ini hanya lewat API.
- Provider tambahan di luar Meta/LinkedIn/Telegram — registry
  (`social-provider-registry.ts`) dirancang untuk menerima adapter baru
  tanpa mengubah dispatcher, tapi belum ada issue yang menambah provider
  keempat.

## Referensi

- `.claude/skills/awcms-mini-social-publishing/SKILL.md` — status penuh
  epic + keputusan arsitektur per issue.
- `docs/adr/0006-offline-first-sync-outbox.md` (ADR outbox/provider
  eksternal di luar transaksi) — lihat `docs/adr/README.md` untuk indeks
  lengkap.
- `docs/adr/0011-capability-ports-for-cross-module-collaboration.md` —
  rasional `capabilities.provides`/`consumes`.
- `src/modules/_shared/README.md` §Capability Ports.
- `src/modules/blog-content/README.md` — sisi konsumen `SocialPublishingPort`.
- `src/modules/news-portal/README.md` — sisi penyedia kapabilitas `news_media`
  yang dikonsumsi modul ini.
