# Email

Implementasi Issue #493 (epic #492) — arsitektur modul email reusable dan
batas konfigurasi Mailketing, sebelum implementasi nyata (schema, adapter,
endpoint) di Issue #494-#500. Issue ini murni kontrak/tipe/konfigurasi;
**tidak ada** migration, adapter pengiriman nyata, endpoint password reset,
atau admin UI di sini (lihat §Roadmap).

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

**Aturan yang sudah berlaku sejak sekarang** (ADR-0006, doc 16 §Transactional
outbox): pemanggilan provider (Mailketing) **tidak boleh** terjadi di
dalam DB transaction. Alur nyatanya (Issue #494/#495): endpoint menulis ke
outbox _di dalam_ `withTenant`/`sql.begin`, dispatcher terpisah membaca
outbox dan memanggil `EmailProvider.send` _di luar_ transaction — pola yang
sama seperti `object-sync-dispatch.ts`.

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
tidak boleh menghentikan aplikasi ataupun jalur bisnis apa pun. Sejak
Issue #494, ini berarti pesan tetap masuk outbox dan menunggu; dispatcher
(Issue #495) tidak mencoba memanggil provider sama sekali selama
`EMAIL_ENABLED=false` — bukan "coba lalu gagal", tapi memang tidak
mencoba. Deployment offline/LAN-first berjalan penuh tanpa email
terkirim; begitu online dan diaktifkan, pesan yang sudah antre dapat
diproses dispatcher (subjek retensi/expiry Issue #494's schema design).

## Keamanan

Jangan pernah mencatat (log) secret provider, isi lengkap `to`/subject/body,
atau raw token apa pun terkait email (mis. token reset password, Issue
#496) — hanya alamat yang **di-mask** bila perlu ditampilkan di
log/diagnostik admin. Selaras ISO/IEC 27001 Annex A (manajemen
secret/config) dan ISO/IEC 27002 (kontrol operasional). Ini adalah prinsip
desain untuk seluruh modul, ditegakkan penuh mulai Issue #494 (skema
menyimpan hash, bukan token mentah) dan #495 (dispatcher me-redact log).

## Roadmap (epic #492)

- **#494** — migration tenant-aware (`email_templates`, `email_messages`/
  outbox, `email_recipients`, `email_delivery_attempts`, opsional
  suppression list), RLS FORCE, status transition
  `queued → sending → sent | failed → retry_wait → cancelled | suppressed`.
- **#495** — adapter Mailketing nyata (implementasi `EmailProvider` di
  atas) + dispatcher Bun (bounded-batch claim, backoff, circuit breaker,
  provider fake/logging untuk dev/test).
- **#498** — template management + safe rendering (kategori
  `auth.password_reset`, `system.announcement`, dst).
- **#496** — flow forgot/reset password.
- **#497** — announcement/notification workflow.
- **#499** — observability, security test, production readiness gate.
- **#500** — sinkronisasi OpenAPI/AsyncAPI/ERD/SOP/threat model/changeset.

`status` di `module.ts` tetap `"experimental"` sampai #494 memberi modul
ini skema nyata.
