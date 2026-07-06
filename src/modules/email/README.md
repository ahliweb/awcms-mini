# Email

Implementasi Issue #493-#495 (epic #492) — arsitektur modul email reusable,
skema/RLS/delivery queue (`sql/020`), dan adapter Mailketing nyata +
dispatcher. **Belum ada** endpoint publik (password reset, announcement)
atau admin UI — itu Issue #496/#497/#499 (lihat §Roadmap).

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
transaction. Alur nyata: caller (Issue #496/#497, belum ada) menulis baris
`awcms_mini_email_messages` (`sql/020`) di dalam transaksi bisnisnya
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

### Rendering minimal — `domain/email-template-render.ts`

Dispatcher me-render body dari `template_key`+`variables` (bukan
menyimpan rendered body — `sql/020`) via substitusi `{{key}}` sederhana,
HTML-escaped untuk `html_body_template`. Ini **bukan** scope penuh "safe
rendering" Issue #498 (allowlist variabel per kategori, preview/dry-run,
default templates) — sengaja seam sempit yang akan digantikan/diperluas
#498, bukan implementasi bersaing. Template tidak ditemukan/`is_active =
false` → kegagalan non-retryable (retry tidak akan menemukan template
yang sama), langsung `failed`.

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

## Keamanan

Tidak pernah mencatat (log) secret provider, isi lengkap `to`/subject/body,
atau raw token apa pun terkait email (mis. token reset password, Issue
#496, belum ada) — hanya alamat yang **di-mask** (log provider) dan respons
provider yang sudah **diredaksi** (`domain/email-log-redaction.ts`,
menutup pola email di teks bebas sebelum disimpan ke
`email_delivery_attempts`/dicatat log) yang pernah tersimpan/tercatat.
Selaras ISO/IEC 27001 Annex A (manajemen secret/config) dan ISO/IEC 27002
(kontrol operasional).

## Roadmap (epic #492)

- ~~**#494**~~ — migration tenant-aware, RLS FORCE, status transition. **Selesai.**
- ~~**#495**~~ — adapter Mailketing nyata + dispatcher Bun. **Selesai.**
- **#498** — template management + safe rendering penuh (kategori
  `auth.password_reset`, `system.announcement`, dst — menggantikan
  rendering minimal `domain/email-template-render.ts` di atas).
- **#496** — flow forgot/reset password (caller pertama yang benar-benar
  meng-enqueue baris `email_messages`).
- **#497** — announcement/notification workflow.
- **#499** — observability, security test, production readiness gate
  (termasuk automated purge job untuk `email_messages`/`_delivery_attempts`
  terminal-state, didokumentasikan di doc 04 tapi belum diimplementasikan).
- **#500** — sinkronisasi OpenAPI/AsyncAPI/ERD/SOP/threat model/changeset.
