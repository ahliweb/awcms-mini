# Email

Implementasi Issue #493-#500 (epic #492) — arsitektur modul email
reusable, skema/RLS/delivery queue (`sql/020`/`021`), adapter Mailketing
nyata + dispatcher, template management (CRUD, i18n, allowlist, preview),
flow forgot/reset password (`POST /api/v1/auth/password/forgot`/`reset`,
`src/modules/identity-access/README.md` §Password reset), announcement/
notification bulk workflow (`POST /api/v1/email/announcements[/preview]`,
lihat §Announcement/notification workflows di bawah), observability/
security/production-readiness hardening (#499), dan sinkronisasi
dokumentasi akhir (#500). **Epic #492 selesai seluruhnya** (lihat
§Roadmap).

## Kenapa modul ini ada — hubungan dengan historical issue #390

`.env.example`/doc 18 sebelumnya sempat mewariskan `MAILKETING_ENABLED`/
`STARSENDER_ENABLED`/`AI_ANALYST_ENABLED` dari contoh domain retail/POS —
flag itu dihapus dari `.env.example` base saat genericization
(`AUDIT_STANDAR_PENGEMBANGAN_2026-07-04.md`, `CHANGELOG.md`) karena terikat
kasus domain sempit "kirim struk via email/WA" (issue #390, closed _not
planned_). Epic #492 **bukan** kebangkitan #390 — ini infrastruktur generik
(password reset, system announcement, workflow notification) yang
dibutuhkan hampir semua aplikasi, analog dengan `sync_storage`'s object
storage: R2 adalah _satu_ adapter object storage, bukan alasan object
storage jadi fitur domain-spesifik. Email module di sini sama: Mailketing
adalah satu adapter (Issue #495), bukan alasan modul email jadi
domain-spesifik.

Untuk menghindari kebingungan dengan baris `MAILKETING_ENABLED`/
`MAILKETING_API_TOKEN` ilustratif di doc 18 §Provider CRM (opsional) (masih
contoh domain retail/POS, tidak berubah), setiap env var nyata modul ini
dinamai dengan prefix berbeda: `EMAIL_*`/`EMAIL_MAILKETING_*`.

## Batas referensi ke AWCMS-Micro

Boleh: memeriksa `ahliweb/awcms-micro` **hanya** untuk pola koneksi/config
Mailketing (nama field, bentuk request/response API). **Tidak boleh**:
menyalin arsitektur, struktur folder, asumsi Cloudflare/D1, atau kredensial
apa pun (committed maupun tidak) dari repo tersebut. Tidak ada kode di
modul ini yang berasal dari penyalinan langsung AWCMS-Micro.

## Kontrak provider — `domain/email-provider-contract.ts`

Port `EmailProvider` (`send`, `healthCheck`), DTO `EmailMessage`/
`EmailAddress`/`EmailAttachmentRef` (referensi objek, bukan attachment
bytes mentah), dan `EmailDeliveryResult` (`retryable` membedakan kegagalan
yang layak di-retry dispatcher vs. kegagalan permanen). Analog persis
dengan `sync-storage/infrastructure/object-storage-uploader.ts`'s
`ObjectUploader` — satu interface, adapter konkret (Mailketing, Issue
#495) di-resolve di satu titik, tidak pernah di-import langsung by name di
tempat lain.

**Ditegakkan sejak Issue #495** (ADR-0006, doc 16 §Transactional outbox):
pemanggilan provider (Mailketing) **tidak boleh** terjadi di dalam DB
transaction. Alur nyata: caller (Issue #496's password reset, #497's
announcements) menulis baris `awcms_mini_email_messages` (`sql/020`) di
dalam transaksi bisnisnya
sendiri; dispatcher terpisah (`application/email-dispatch.ts`, `bun run
email:dispatch`) meng-claim baris dalam transaksi pendek
(`FOR UPDATE SKIP LOCKED`, reuse `next_attempt_at` sebagai lease — pola
identik `object-dispatch.ts`), memanggil `EmailProvider.send` **di luar**
transaksi apa pun, lalu finalize (transaksi pendek kedua) ke
`sent`/`retry_wait`/`failed` + mencatat `awcms_mini_email_delivery_attempts`.

### Adapter Mailketing — `infrastructure/mailketing-provider.ts`

`POST {baseUrl}/api/v1/send`, form-urlencoded
`api_token`/`recipient`/`from_email`/`from_name`/`subject`/`content`,
respons JSON `{status, response, message_id?}`. Auth **hanya** via
`api_token` — Mailketing sendiri tidak punya konsep "account identifier"
terpisah; `EMAIL_MAILKETING_ACCOUNT_ID` karenanya **tidak pernah** dikirim
ke provider, murni label operator (multi-akun Mailketing di deployment
berbeda). Satu `send` = satu recipient (API-nya sendiri memang begitu) —
inilah alasan `email_messages` (`sql/020`) satu baris per recipient, bukan
fan-out. Kegagalan HTTP/network/timeout/5xx → `retryable: true`; respons
`status:"failed"` (validasi/bisnis, mis. token salah atau recipient
invalid) → `retryable: false` (retry tidak akan mengubah hasil). Timeout +
circuit breaker (`getProviderCircuitBreaker("email-mailketing")`) sama
persis pola `object-storage-uploader.ts`.

Provider `"log"` (`infrastructure/log-email-provider.ts`,
`EMAIL_PROVIDER=log`) — menulis log terstruktur (alamat di-mask, reuse
`profile-identity/domain/identifier.ts`, bukan implementasi masking baru)
alih-alih memanggil provider nyata; dipakai dev lokal tanpa kredensial
Mailketing dan test. **Beda** dari `EMAIL_ENABLED=false` (dispatcher sama
sekali tidak claim baris, tidak pernah sampai ke provider manapun).

### Template management — Issue #498

`sql/021` mengubah tiga kolom body `awcms_mini_email_templates`
(`subject_template`, `text_body_template`, `html_body_template`) dari
`text` menjadi `jsonb` per-locale (`{"en": "...", "id": "..."}`, doc 04
§Konten multi-bahasa "JSONB per-locale") — dipilih ketimbang tabel
translasi terpisah karena template jarang di-query per-locale (selalu
dibaca utuh satu baris). Kolom `restored_at`/`restored_by` juga
ditambahkan (berbeda dari `form_drafts`: template adalah master/config
data, restore-nya bermakna).

- **Kategori & allowlist variabel** — `domain/email-template-categories.ts`.
  `template_key` (format sama seperti constraint SQL) SEKALIGUS menjadi
  kategori: 5 kategori base fixed (`auth.password_reset`,
  `system.announcement`, `system.security_notice`,
  `workflow.task_assigned`, `workflow.decision_required`) plus
  `derived.transactional` sebagai contoh; masing-masing punya daftar nama
  variabel yang diizinkan. `derived.*` lain **harus** didaftarkan dulu via
  `registerDerivedEmailTemplateCategory(category, allowedVariables)`
  sebelum dipakai — kategori tak dikenal ditolak saat create (fail-closed),
  bukan diperlakukan "semua variabel diizinkan".
- **Rendering aman** — `domain/email-template-render.ts` (Issue #495's
  seam sempit, sekarang scope penuh): resolve locale (`resolveLocaleVariant`,
  fallback ke `en`), filter variabel pemanggil lewat allowlist kategori
  (variabel di luar daftar didiamkan/dibuang, tidak pernah disubstitusi),
  baru substitusi `{{key}}` — HTML-escaped untuk `htmlBody`. Dispatcher
  (`application/email-dispatch.ts`) merender pada locale
  `default_locale` tenant (`awcms_mini_tenants`, tanpa override per-pesan
  saat ini). Template tidak ditemukan/`is_active = false` → kegagalan
  non-retryable, langsung `failed`.
- **Validasi input** — `domain/email-template-validation.ts`: format
  `templateKey` + kategori dikenal, setiap `LocalizedTemplateText` wajib
  punya entri `en`, kode locale 2-huruf, dan `htmlBodyTemplate` ditolak
  bila mengandung `<script>`/`<iframe>`/inline event handler/`javascript:`
  (shell HTML yang ditulis admin — variabel yang disubstitusi ke dalamnya
  di-escape terpisah saat render, dua lapis perlindungan berbeda).
- **CRUD + restore + preview** — `application/email-template-directory.ts`
  (create/read/list/update/soft-delete/restore, pola sama
  `form-draft-directory.ts`) di balik
  `POST/GET/PATCH/DELETE /api/v1/email/templates[/{id}]` dan
  `POST /api/v1/email/templates/{id}/restore` (action `restore` khusus,
  pola sama `POST /profiles/{id}/restore`, bukan reuse `update`).
  `POST /api/v1/email/templates/{id}/preview` merender dengan data sampel
  sintetis (`domain/email-template-preview.ts` — tidak pernah alamat
  penerima nyata) dan **tidak pernah** menyentuh
  `awcms_mini_email_messages`/antrean — murni pratinjau.
- **Default templates** — `domain/email-default-templates.ts` (EN+ID
  untuk 5 kategori base) + `application/email-template-directory.ts`'s
  `seedDefaultEmailTemplates` (idempotent — skip key yang sudah aktif,
  tidak pernah menimpa kustomisasi tenant), dijalankan operator via
  `bun run email:templates:seed-defaults -- --tenant=<id> --actor=<tenantUserId>`
  (bukan migration — migration tidak bisa INSERT untuk tenant yang belum
  ada saat migration jalan).

### Retry/backoff — `domain/email-retry.ts`

Sama seperti `object-queue.ts`'s `evaluateObjectRetry` (exponential
`2^retryCount` menit, dibatasi `EMAIL_MAX_RETRY_DELAY_MINUTES=60`), tapi
batas jumlah retry (`maxRetries`) adalah parameter — dibaca dari
`EMAIL_SEND_MAX_RETRIES` (env, Issue #493), bukan konstanta hardcoded
seperti `OBJECT_SYNC_MAX_RETRIES`.

### Operasional — `bun run email:dispatch` / `bun run email:provider:health`

`scripts/email-dispatch.ts` — iterasi tiap tenant `active`, drain backlog
per tenant (pola identik `object-sync-dispatch.ts`); no-op bila
`EMAIL_ENABLED` bukan `"true"`. `scripts/email-provider-health.ts` —
resolve provider terkonfigurasi dan panggil `healthCheck()`; live network
check ke Mailketing nyata, sengaja **tidak** dijalankan sebagai bagian
`bun run check`/CI (tidak ada network egress di sana) — operator
menjalankannya manual atau sebagai smoke-test deployment.

## Batas konfigurasi — `domain/email-config.ts`

| Var                             | Wajib           | Default      | Sensitif | Fungsi                                                |
| ------------------------------- | --------------- | ------------ | -------- | ----------------------------------------------------- |
| `EMAIL_ENABLED`                 | –               | `false`      | –        | Aktifkan modul email                                  |
| `EMAIL_PROVIDER`                | bila aktif      | –            | –        | Adapter terpilih; hanya `"mailketing"` didukung kini  |
| `EMAIL_FROM_ADDRESS`            | bila aktif      | –            | –        | Alamat pengirim default                               |
| `EMAIL_FROM_NAME`               | –               | `AWCMS-Mini` | –        | Nama pengirim default                                 |
| `EMAIL_SEND_TIMEOUT_MS`         | –               | `10000`      | –        | Timeout satu percobaan kirim (dispatcher, Issue #495) |
| `EMAIL_SEND_MAX_RETRIES`        | –               | `5`          | –        | Batas percobaan retry sebelum `failed` final          |
| `EMAIL_MAILKETING_ACCOUNT_ID`   | bila mailketing | –            | Ya       | Identifier akun Mailketing                            |
| `EMAIL_MAILKETING_API_TOKEN`    | bila mailketing | –            | Ya       | Token/secret API Mailketing                           |
| `EMAIL_MAILKETING_API_BASE_URL` | bila mailketing | –            | –        | Base URL endpoint API Mailketing (host+port+scheme)   |

Semua nilai di atas hanya **placeholder** di `.env.example` — tidak pernah
nilai kredensial asli. `scripts/validate-env.ts` (`checkEmailConfig`)
memvalidasi kombinasi ini saat `bun run config:validate`: `EMAIL_ENABLED`
off → semua var lain diabaikan (tidak menghentikan boot); `EMAIL_ENABLED`
on tapi `EMAIL_FROM_ADDRESS`/`EMAIL_PROVIDER` hilang, atau
`EMAIL_PROVIDER` bukan provider yang dikenal, atau (bila `mailketing`)
salah satu `EMAIL_MAILKETING_*` hilang → gagal dengan pesan jelas yang
menyebut nama var, tanpa pernah mencetak nilainya (doc 18 §Validasi
konfigurasi saat boot).

## Perilaku disabled / offline-LAN

Sama seperti diagram feature-flag doc 18: `EMAIL_ENABLED=false` (default)
tidak boleh menghentikan aplikasi ataupun jalur bisnis apa pun. Pesan
tetap masuk outbox dan menunggu; dispatcher tidak mencoba memanggil
provider sama sekali selama `EMAIL_ENABLED=false` (`dispatchEmailQueue`
return awal, tidak claim baris apa pun) — bukan "coba lalu gagal", tapi
memang tidak mencoba. Deployment offline/LAN-first berjalan penuh tanpa
email terkirim; begitu online dan diaktifkan, pesan yang sudah antre
diproses dispatcher pada run berikutnya.

## Announcement/notification workflows (Issue #497)

`POST /api/v1/email/announcements` (bulk-capable enqueue) dan
`POST /api/v1/email/announcements/preview` (dry-run), di
`application/announcement-directory.ts` + `domain/announcement-validation.ts`.

- **Targeting** — `target: {type: "users", userIds}` (daftar eksplisit
  tenant_user, di-bind via `tx.array(ids, "uuid")` — bukan interpolasi
  array langsung, gotcha `Bun.SQL` yang sudah terdokumentasi), `{type:
"role", roleId}` (semua tenant_user aktif ber-role itu), atau `{type:
"tenant"}` (seluruh tenant). Setiap target di-resolve hanya identity
  **aktif** dan **tidak** ada di `awcms_mini_email_suppression_list`
  (Issue #494's suppression list, konsumen nyata pertama).
- **ABAC dua-tingkat** (acceptance criteria: "Bulk announcement should
  require stronger permission than ordinary notification enqueue") —
  `email.notification.create` wajib untuk **semua** request; `target.type
= "role"`/`"tenant"` (unbounded) **tambahan** wajib
  `email.announcement.create`. Role yang cuma punya permission dasar bisa
  mengirim ke user tertentu yang sudah diketahuinya, tapi tidak bisa
  membanjiri satu role/tenant penuh.
- **Idempotency wajib** — `Idempotency-Key` selalu diminta (bukan hanya
  saat bulk), reuse `_shared/idempotency.ts` (pola sama
  `workflows/tasks/{id}/decisions.ts`).
- **Preview aman** — resolve target yang SAMA seperti kirim nyata tapi
  hanya mengembalikan **jumlah** (`matchedCount`) + rendering sampel data
  sintetis (`buildSyntheticSampleVariables`, Issue #498) — tidak pernah
  daftar/alamat penerima nyata, dan **tidak menyentuh**
  `email_messages`/antrean sama sekali.
- **Satu baris `email_messages` per penerima**, berbagi `correlation_id`
  yang sama untuk satu request bulk — bukan fan-out (keputusan `sql/020`
  di Issue #494, dikonfirmasi ulang di sini sebagai konsumen bulk nyata
  pertamanya). Subjek dirender per-penerima (variabel `userName` = nama
  tampilan penerima) saat enqueue, bukan saat dispatch.
- **Audit satu baris per request** (bukan per penerima — hindari spam
  audit untuk bulk send): `action: "announcement_sent"`, `attributes`
  berisi `targetType`, `templateKey`, `recipientCount`, `correlationId`,
  `dispatchStatus: "queued"` — **tidak pernah** daftar penerima nyata.
- **Kategori baru** `system.maintenance` ditambahkan (allowlist:
  `userName`, `maintenanceWindow`, `expectedDuration`,
  `impactDescription`) plus default template EN/ID — kategori
  `system.security_notice`/`workflow.task_assigned`/
  `workflow.decision_required`/`derived.transactional` yang relevan sudah
  ada sejak Issue #498.
- **Event AsyncAPI** `awcms-mini.email.message.{queued,sent,failed}` —
  dokumentasi kontrak saja (pola sama `database.pool.saturated`, doc 05),
  produser nyatanya structured logger: `email.message.queued`
  (`announcement-directory.ts`), `email.dispatch.sent`/`.failed`
  (`email-dispatch.ts`, baris log baru ditambahkan issue ini — sebelumnya
  hanya `email.dispatch.claimed` yang ada sejak Issue #495).

## Keamanan

Tidak pernah mencatat (log) secret provider, isi lengkap `to`/subject/body,
atau raw token apa pun terkait email (token reset password di-hash saat
disimpan, Issue #496) — hanya alamat yang **di-mask** (log provider) dan
respons provider yang sudah **diredaksi**
(`domain/email-log-redaction.ts`, menutup pola email di teks bebas
sebelum disimpan ke `email_delivery_attempts`/dicatat log) yang pernah
tersimpan/tercatat. Selaras ISO/IEC 27001 Annex A (manajemen
secret/config) dan ISO/IEC 27002 (kontrol operasional). Announcement
(Issue #497) menegakkan data minimization UU PDP secara struktural:
preview tidak pernah mengembalikan daftar penerima, audit hanya mencatat
jumlah bukan daftar, dan targeting selalu memfilter suppression list.

## Observability, security tests, and production readiness (Issue #499)

### Structured logs (full lifecycle)

Every stage of a message's life is a structured JSON log line
(`src/lib/logging/logger.ts`), always carrying `correlationId`/`tenantId`/
`moduleKey`, never a raw recipient address (only masked, and only where
truly needed — most lines omit the recipient entirely):

| Stage                                        | Log line                         | Emitted from                                 |
| -------------------------------------------- | -------------------------------- | -------------------------------------------- |
| Enqueue (bulk)                               | `email.message.queued`           | `application/announcement-directory.ts`      |
| Claim (batch)                                | `email.dispatch.claimed`         | `application/email-dispatch.ts`              |
| Dispatch success                             | `email.dispatch.sent`            | `application/email-dispatch.ts`              |
| Dispatch retry scheduled                     | `email.dispatch.retry_scheduled` | `application/email-dispatch.ts`              |
| Dispatch final failure                       | `email.dispatch.failed`          | `application/email-dispatch.ts`              |
| Suppressed at dispatch time                  | `email.dispatch.suppressed`      | `application/email-dispatch.ts`              |
| Provider circuit breaker open (pass skipped) | `email.dispatch.breaker_open`    | `application/email-dispatch.ts`              |
| Cancelled by an operator                     | `email.message.cancelled`        | `pages/api/v1/email/messages/[id]/cancel.ts` |

The first 3 (`.queued`/`.sent`/`.failed`) plus the 2 new ones
(`.suppressed`/`.cancelled`) are also documented AsyncAPI channels
(`asyncapi/awcms-mini-domain-events.asyncapi.yaml`) — contract-only, same
"structured logger is the producer" convention as
`awcms-mini.database.pool.saturated` (no live pub/sub bus in this repo).

A recipient can land on the suppression list _after_ enqueue but _before_
dispatch (bounce/complaint arriving between the two) — the dispatcher
re-checks the suppression list right before calling the provider (not just
at enqueue time) and skips the send entirely if newly suppressed, moving
the message straight to `status = 'suppressed'` with no
`email_delivery_attempts` row (no provider call was ever attempted).

### Audit events (high-risk actions)

Every mutating admin/user action already records an
`awcms_mini_audit_events` row (`recordAuditEvent`): template CRUD/restore
(#498), password reset request/complete (#496), announcement send (#497),
and — new in #499 — `message_cancelled`, `suppression_created`,
`suppression_deleted`. Attributes never include a raw recipient address
(only category/reason/counts).

### Metrics / report views

- `GET /api/v1/email/messages` — tenant-wide queue diagnostics
  (`status`/`cursor` filterable), the failed-queue and retry-backlog
  visibility the issue's own "Observability requirements" calls for.
  Never selects `to_address`, only `to_address_masked`.
- `POST /api/v1/email/messages/{id}/cancel` — stop a still-queued message
  before it sends (`queued`/`retry_wait` only; anything past that is a
  `409`). The concrete technical mitigation behind the "accidental bulk
  send" incident note below.
- `GET /api/v1/email/suppressions` / `POST` / `DELETE /{id}` — manual
  suppression list management (the `suppression.{read,create,delete}`
  permissions seeded back in migration 020, unused until this issue).
- `GET /api/v1/reports/email-health` — queue health aggregate (queued/
  retry_wait/failed/suppressed counts, sent-last-24h, `isHealthy`),
  `reporting` module (`modules/reporting/application/email-health-report.ts`),
  same permission (`reporting.dashboard.read`) as `GET /reports/sync-health`.
- `bun run email:provider:health` (Issue #495) — manual/CLI provider
  health check; no HTTP endpoint (deliberate — a live network call
  against the real provider is not something a request handler should
  trigger synchronously).

### Readiness/preflight

`checkEmailConfig` (`scripts/validate-env.ts`, Issue #493) already blocks
`bun run config:validate` — and therefore `bun run production:preflight`,
which runs `config:validate` as its first stage — when `EMAIL_ENABLED=true`
but required vars (`EMAIL_FROM_ADDRESS`, `EMAIL_PROVIDER`, and
`EMAIL_MAILKETING_*` when `EMAIL_PROVIDER=mailketing`) are incomplete.
Issue #499 adds `checkEmailProviderConfigReady` to
`scripts/security-readiness.ts` (critical severity) — the same signal
surfaced a second time inside `bun run security:readiness`'s own
report/gate, for an operator who runs that command on its own rather than
the full preflight. See
[`../../../docs/awcms-mini/production-readiness.md`](../../../docs/awcms-mini/production-readiness.md).

### Security tests

Redaction (never a raw address in a log/audit/delivery-attempt row —
`tests/email-log-redaction.test.ts`, dispatcher integration tests), RLS
(`tests/integration/email-schema.integration.test.ts`, plus new tests on
the #499 endpoints in `tests/integration/email-messages.integration.test.ts`
/ `email-suppressions.integration.test.ts`), ABAC default-deny on every
new endpoint, and password-reset enumeration-safety
(`tests/integration/password-reset.integration.test.ts`, #496, still
green) are all covered live against a real PostgreSQL.

### Incident response

- **Provider outage** (Mailketing 5xx/timeout/unreachable): the
  per-provider circuit breaker (`lib/database/circuit-breaker.ts`,
  `email-mailketing` key) opens after 5 consecutive failures and stops the
  dispatcher from claiming anything for 30s (`email.dispatch.breaker_open`
  warning log) — no manual action needed to stop hammering a down
  provider. Messages already `queued`/`retry_wait` stay queued (nothing is
  lost); they drain automatically once the breaker closes. To force a
  faster recovery check: `bun run email:provider:health`. Local/critical
  transactions are never blocked by an email outage — the provider call
  happens strictly outside any DB transaction (ADR-0006), so a slow/down
  provider cannot hold a lock or fail an unrelated write.
- **Credential rotation** (`EMAIL_MAILKETING_API_TOKEN` compromised or
  scheduled rotation): update the env var and restart/redeploy the app and
  dispatcher process — no database change needed (the token is never
  persisted, only read from `process.env` at dispatch time). Run `bun run
email:provider:health` immediately after rotation to confirm the new
  token works before relying on it. Old messages in flight are unaffected
  (the provider call uses whatever token is current at send time).
- **Accidental bulk send** (wrong `target`, wrong template, fat-fingered
  tenant-wide announcement): `POST /api/v1/email/messages/{id}/cancel`
  stops any row still `queued`/`retry_wait` for that `correlation_id`
  before the dispatcher claims it — query
  `GET /api/v1/email/messages?status=queued` (or `retry_wait`) filtered by
  the announcement's `correlationId` (returned by
  `POST /api/v1/email/announcements`) to find and cancel every affected
  row. Rows already `sending`/`sent` cannot be recalled (no provider
  supports unsend) — the mitigation is prevention (two-tier ABAC, #497)
  plus fast cancellation of whatever hasn't gone out yet.

## Roadmap (epic #492)

- ~~**#494**~~ — migration tenant-aware, RLS FORCE, status transition. **Selesai.**
- ~~**#495**~~ — adapter Mailketing nyata + dispatcher Bun. **Selesai.**
- ~~**#498**~~ — template management + safe rendering penuh. **Selesai.**
- ~~**#496**~~ — flow forgot/reset password (caller pertama yang benar-benar
  meng-enqueue baris `email_messages`). **Selesai** — lihat
  `identity-access/README.md` §Password reset.
- ~~**#497**~~ — announcement/notification bulk workflow. **Selesai** —
  lihat §Announcement/notification workflows di atas.
- ~~**#499**~~ — observability, security test, production readiness gate.
  **Selesai** — lihat §Observability, security tests, and production
  readiness di atas. Automated purge job untuk
  `email_messages`/`_delivery_attempts` terminal-state tetap
  didokumentasikan di doc 04 tapi belum diimplementasikan (di luar cakupan
  #499's acceptance criteria, bukan sebuah observability/security/readiness
  gap).
- ~~**#500**~~ — sinkronisasi OpenAPI/AsyncAPI/ERD/SOP/threat model/changeset.
  **Selesai** — PR #508. Epic #492 fully closed as of 2026-07-07.
