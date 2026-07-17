---
name: awcms-mini-domain-event-runtime
description: Kerjakan bagian mana pun dari modul domain_event_runtime AWCMS-Mini (Issue #742, epic platform-evolution #738 Wave 1, ADR-0013 §1/§6). Gunakan saat memanggil appendDomainEvent sebagai producer dari modul lain, saat mendaftarkan consumer baru di consumer-registry.ts, saat mengubah dispatcher/ordering/retry/dead-letter/replay, atau saat menambah event type ke DOMAIN_EVENT_TYPE_REGISTRY. Merangkum model eksekusi 1-transaksi yang sengaja beda dari outbox lain, invariant ordering, dan cycle import yang MASIH HIDUP (#826).
---

# AWCMS-Mini — Domain Event Runtime Module

`domain_event_runtime` (`src/modules/domain-event-runtime`, Issue #742, epic
`platform-evolution` #738 Wave 1) adalah **System Foundation** (`type: "system"`,
ADR-0013 §1/§6) — outbox domain-event transaksional & versioned plus
dispatcher-nya. Fan-in tertinggi kedua di repo (←7 modul), setelah `logging`
(←13).

Baca `src/modules/domain-event-runtime/README.md` untuk peta tabel/endpoint.
Skill ini merangkum yang **tidak jelas dari membaca satu file**: kenapa model
eksekusinya sengaja berbeda dari setiap outbox lain di repo, invariant ordering
head-of-line, dan satu cycle import yang masih hidup hari ini.

## Kapan pakai skill ini vs skill generik

Melengkapi (bukan menggantikan) `awcms-mini-new-event` (cara menambah event +
AsyncAPI), `awcms-mini-idempotency`, `awcms-mini-abac-guard`,
`awcms-mini-integration`. Pakai skill ini untuk konteks runtime-nya:
bagaimana event dipersist, di-fan-out, di-dispatch, di-retry, dan di-replay.

## Kenapa modul ini ada (dan tidak menggantikan outbox lain)

Repo ini sudah punya TIGA preseden outbox/queue single-purpose nyata yang
sengaja diikuti BENTUK-nya, bukan digantikan:

- `sync-storage` — `awcms_mini_object_sync_queue` + `dispatchObjectSyncQueue`
- `email` — `awcms_mini_email_messages` + `dispatchEmailQueue`
- `social-publishing` — `awcms_mini_social_publish_jobs` + `dispatchSocialPublishQueue`

Masing-masing adalah queue single-purpose milik SATU modul, dengan tepat satu
"consumer" implisit (dispatcher-nya sendiri memanggil satu provider eksternal).
Modul ini adalah padanan **generik, provider-neutral, multi-consumer**: satu
event bisa fan-out ke BANYAK consumer terdaftar, dengan ordering eksplisit
per-aggregate/order-key — **tidak pernah** total order global lintas aggregate
yang tak berhubungan.

## Mekanisme inti

1. **Producer** — kode transaksional modul mana pun memanggil
   `application/append-domain-event.ts`'s `appendDomainEvent(tx, tenantId, input)`
   **di dalam transaksi bisnisnya sendiri** (callback `withTenant`). Hanya
   plain DB write (tanpa panggilan network/provider, ADR-0006): baris event
   (`awcms_mini_domain_events`) + satu baris delivery per consumer yang cocok
   (`awcms_mini_domain_event_deliveries`) ditulis atomik bersama perubahan state
   sumbernya. Kalau transaksi caller rollback, tidak ada yang persist.
2. **Static consumer registry** — `infrastructure/consumer-registry.ts`'s
   `DOMAIN_EVENT_CONSUMERS` adalah array source-code polos yang direview
   (**bukan** panggilan registrasi runtime). Fan-out diputuskan **saat publish**
   dari registry ini, bukan saat dispatch.
3. **Dispatcher** — `application/dispatch-domain-events.ts`'s
   `dispatchDomainEventsForTenant` (dijalankan `bun run domain-events:dispatch`,
   di atas shared worker runner `src/lib/jobs/job-runner.ts`) meng-claim,
   mengeksekusi, dan memfinalisasi delivery yang jatuh tempo per consumer.
4. **Efek samping idempotent** — `application/consumer-effect.ts`'s
   `applyConsumerEffectOnce` memberi handler consumer mana pun idempotency
   ber-key event-ID (`awcms_mini_domain_event_consumer_effects`), sehingga event
   yang dikirim ulang (crash/restart atau replay eksplisit) tidak bisa
   menduplikasi efek samping.
5. **Dead-letter + replay** — delivery yang menghabiskan retry budget (atau kena
   error non-retryable) pindah ke `dead_letter`. Replay
   (`application/delivery-replay.ts`) adalah aksi admin yang permission-gated,
   wajib-alasan (1-500 char), idempotent, dan diaudit — membuat baris delivery
   **BARU** yang mereferensikan aslinya, dan **menolak (409)** bila consumer
   terdaftar sudah tidak mendukung `eventVersion` delivery itu.
6. **Pause/resume** — `application/consumer-state-directory.ts` memungkinkan
   operator mem-pause pasangan (tenant, consumer) tertentu; dispatcher berhenti
   meng-claim delivery untuknya sampai di-resume.

## CRITICAL — kenapa BUKAN 3-fase CLAIM/CALL/FINALIZE seperti dispatcher lain

Setiap dispatcher outbox lain di repo ini memakai bentuk 3-fase berbasis lease
(CLAIM di transaksi pendek → CALL **di luar** transaksi apa pun → FINALIZE di
transaksi pendek kedua) karena fase CALL-nya melakukan panggilan network
eksternal nyata (upload, SMTP, provider API), yang ADR-0006 larang dijalankan di
dalam transaksi DB.

Consumer di modul ini adalah handler **same-process, DB-only, tanpa I/O
eksternal**. `dispatch-domain-events.ts` karena itu menjalankan claim-check +
handler + finalize-on-success dalam **SATU** transaksi: crash di tengah handler
me-rollback seluruh transaksi otomatis, mengembalikan baris delivery ke
`pending` tanpa state lease/stale-claim yang pernah teramati durabel. Inilah
yang membuat recovery crash/restart **benar secara konstruksi**, bukan
berbasis lease-timeout — dan kenapa
`awcms_mini_domain_event_deliveries.status` tidak punya nilai transient
"claimed".

**Jangan** mengubah ini menjadi 3-fase "supaya konsisten dengan dispatcher
lain", dan **jangan** menambah consumer yang melakukan I/O eksternal ke jalur
ini. Consumer **out-of-transaction / broker-backed** (lihat
`infrastructure/broker-adapter-port.ts`) memang butuh bentuk lease itu kembali —
tapi jalur dispatch-nya belum dibangun (sengaja tidak spekulatif). Kalau butuh
provider eksternal per event, itu pekerjaan `integration_hub`'s outbound
subscription, bukan handler di sini.

## Ordering — invariant head-of-line

`order_key` default-nya `aggregateType:aggregateId` (`domain/envelope.ts`'s
`deriveOrderKey`), boleh di-override producer. Query head-of-line dispatcher:

```sql
SELECT DISTINCT ON (order_key) ... ORDER BY order_key, event_sequence
```

memilih, per `order_key`, hanya satu delivery pending tertua untuk consumer
tertentu — dihitung **SEBELUM** difilter backoff (`next_attempt_at`). Ini
disengaja: baris head-of-line yang sedang di-backoff dengan benar men-stall
`order_key`-nya sendiri tanpa membiarkan event berikutnya untuk key yang sama
menyalip, sementara `order_key` lain tetap maju setiap pass. **Jangan** pindahkan
filter `next_attempt_at` ke sebelum `DISTINCT ON` — itu diam-diam merusak
ordering per-aggregate.

## AsyncAPI parity — mekanisme, bukan dokumentasi

`appendDomainEvent` **menolak** (melempar `UnregisteredDomainEventTypeError`)
mempersist event yang `(eventType, eventVersion)`-nya tidak terdaftar di
`domain/event-type-registry.ts`'s `DOMAIN_EVENT_TYPE_REGISTRY`. Inilah mekanisme
di balik "event type/version tidak bisa drift diam-diam".

`tests/unit/domain-event-registry-parity.test.ts` mengecek silang registry ini
terhadap `asyncapi/awcms-mini-domain-events.asyncapi.yaml` **dua arah** (entri
registry tanpa channel = gagal; event type yang di-subscribe consumer terdaftar
tanpa entri registry = gagal), dan `events.publishes` di `module.ts` dicek
terhadap AsyncAPI oleh `checkModuleEventChannels` (`scripts/api-spec-check.ts`,
bagian `bun run check`).

Menambah producer: tambahkan type/version ke `DOMAIN_EVENT_TYPE_REGISTRY` +
channel AsyncAPI yang cocok DULU, baru panggil `appendDomainEvent` di transaksi
modulmu. Menambah consumer: tambahkan entri ke `DOMAIN_EVENT_CONSUMERS` yang
event type/version-nya sudah ada di registry.

## Dua consumer referensi

Keduanya terdaftar terhadap satu event referensi self-contained,
`awcms-mini.domain-event-runtime.sample.recorded` — sengaja tidak terikat logika
bisnis modul lain di foundation issue ini (preseden "foundation issue ships zero
real business integrations").

- **`logging.sample_event_audit_projector`** — consumer **lintas-modul**
  same-process: memanggil `recordAuditEvent` publik milik `logging` (panggilan
  lintas-modul yang sama yang sudah dilakukan ~10 modul lain langsung — audit
  logging adalah infra fondasional, bukan capability domain di balik port
  ADR-0011).
- **`domain_event_runtime.activity_rollup_projector`** — consumer **proyeksi
  read-model**: memelihara tabel rollup denormalisasinya sendiri,
  `awcms_mini_domain_event_activity_daily`, **tanpa** menyentuh tabel modul
  `reporting` (no shared-table write, ADR-0013 §6).

Consumer NYATA (non-referensi) pertama datang dari luar: `reporting`'s
`reporting.event_activity_projector` (Issue #753) dan `integration_hub`'s
outbound fanout consumer (Issue #754) — keduanya didaftarkan DI SINI, di
`consumer-registry.ts`. Lihat §Cycle di bawah: arah registrasi itulah akar
masalah arsitektural yang masih terbuka.

## KNOWN DEFECT — cycle import yang MASIH HIDUP (Issue #826, OPEN)

Ada **cycle import tingkat modul yang hidup hari ini**, dan **kedua gate yang
seharusnya menangkapnya lolos hijau**:

```
domain-event-runtime/infrastructure/consumer-registry.ts
  -> integration-hub/application/outbound-fanout-consumer
integration-hub/application/outbound-fanout-consumer.ts
  -> domain-event-runtime/application/consumer-effect
```

Kenapa kedua gate buta:

1. `tests/unit/module-boundary-cycles.test.ts` hanya memindai `application/` +
   `domain/` sebagai direktori sumber. Sisi keluar cycle ini ada di
   **`infrastructure/`**, jadi `aImportsB` terbaca false.
2. `bun run modules:dag:check` memercayai deklarasi `dependencies` di
   `module.ts` — dan `module.ts` modul ini mendeklarasikan
   `["tenant_admin", "identity_access", "logging"]` saja, padahal
   `consumer-registry.ts` nyata-nyata mengimpor **`integration_hub`** DAN
   **`reporting`**. Edge-nya tidak dideklarasikan → graf yang dicek tidak punya
   edge itu → tidak ada yang bisa ditemukan.

Satu gate memindai direktori yang salah; gate satunya memercayai deklarasi yang
tidak sinkron dengan kode. **Akar sesungguhnya: deklarasi `dependencies` bisa
bohong tanpa ada yang protes.**

Kalau kamu mengerjakan #826: memperluas direktori yang dipindai cycles-test ke
`infrastructure/` + `api/` **akan langsung merah — itu justru tujuannya**.
Pemutusan cycle-nya kemungkinan lewat port di `_shared/ports/` (pola yang sudah
dipakai 12 port lain) atau dengan **membalik arah registrasi consumer**
(integration-hub mendaftarkan dirinya sendiri, bukan runtime yang mengimpornya).

Sampai #826 ditutup: **jangan tambah import baru dari `consumer-registry.ts` ke
`application/` modul lain** — setiap tambahan memperdalam cycle yang sama dan
tetap tidak akan ditangkap gate mana pun.

## Security

- **Tenant isolation**: setiap tabel tenant-scoped dengan `ENABLE`+`FORCE ROW
LEVEL SECURITY` dan policy standar `tenant_id = current_setting(...)::uuid`
  (migration 056); setiap query aplikasi juga memfilter `tenant_id` eksplisit
  (defense in depth).
- **Payload hygiene**: `domain/envelope.ts`'s `validateDomainEventPayload`
  **hard-reject** (tidak pernah persist) payload dengan nama key berbentuk
  credential (`password`/`token`/`apiKey`/`secret`/`credential`/`authorization`
  — sengaja LEBIH SEMPIT dari `REDACTION_KEYS` penuh di `_shared/redaction.ts`,
  yang juga memuat PII biasa seperti `email`/`phone` yang mungkin memang
  dibutuhkan consumer sah) ATAU nilai berbentuk credential terlepas dari nama
  key-nya (memakai ulang `findSecretShapedValues` dari `_shared/redaction.ts`
  tanpa modifikasi — JWT/PEM/AWS key/Bearer header/connection string). Cap
  payload 64 KiB di kode aplikasi DAN sebagai backstop `CHECK` di DB.
- **Read-time masking**: `domain/payload-redaction.ts` menerapkan
  `redactSensitiveAttributes` penuh (termasuk PII) ke setiap payload yang keluar
  lewat fungsi baca admin/API di `application/domain-event-directory.ts`.
  Payload mentah yang diterima `handler` consumer secara internal **tidak pernah**
  di-redact (ia butuh data aslinya) — jangan tukar dua jalur ini.
- **Replay**: permission-gated (`domain_event_runtime.deliveries.replay`),
  wajib-alasan, `Idempotency-Key`, diaudit.
- **Tanpa broker eksternal**: `infrastructure/broker-adapter-port.ts` mendefinisikan
  port opsional; tidak ada adapter terdaftar secara default. Setiap deployment,
  termasuk offline/LAN, men-dispatch murni lewat PostgreSQL + registry
  in-process.

## Tabel

| Tabel                                      | Fungsi                                                      |
| ------------------------------------------ | ----------------------------------------------------------- |
| `awcms_mini_domain_events`                 | Outbox-nya sendiri — append-only.                           |
| `awcms_mini_domain_event_deliveries`       | State delivery/retry/dead-letter per (event, consumer).     |
| `awcms_mini_domain_event_consumer_effects` | Marker idempotency efek samping ber-key event-ID, reusable. |
| `awcms_mini_domain_event_consumer_state`   | Flag pause/resume per (tenant, consumer).                   |
| `awcms_mini_domain_event_replays`          | Jejak audit replay, append-only.                            |
| `awcms_mini_domain_event_activity_daily`   | Tabel rollup milik consumer proyeksi referensi.             |

## API & job

`GET/POST /api/v1/domain-events/{events,deliveries,consumers}` —
`openapi/modules/domain-event-runtime.openapi.yaml`. API admin read-mostly;
satu-satunya mutasi adalah replay dan pause/resume. **Consumer tidak pernah
dibuat/diedit lewat API** — mereka registry source-code statik yang direview.

`bun run domain-events:dispatch` (`scripts/domain-events-dispatch.ts`) —
disarankan tiap 30-60 detik via cron/systemd timer. Murni PostgreSQL/in-process,
aman di deployment offline/LAN.

## Pitfall umum

1. Jangan panggil `appendDomainEvent` di luar transaksi bisnis caller.
2. Jangan daftarkan event type baru hanya di AsyncAPI atau hanya di registry —
   parity test dua arah akan gagal, dan `appendDomainEvent` akan melempar.
3. Jangan tambah consumer ber-I/O eksternal ke jalur dispatch 1-transaksi.
4. Jangan pindahkan filter backoff ke sebelum `DISTINCT ON (order_key)`.
5. Jangan tambah import baru dari `consumer-registry.ts` ke `application/` modul
   lain selama #826 masih terbuka.
6. Jangan redact payload yang diterima handler consumer.

## Out of scope (issue #742)

Wiring producer/consumer modul nyata yang sudah ada (sebagian sudah menyusul
lewat #747/#749/#753/#754); jalur dispatch broker-backed; retensi/purge tabel
event (didelegasikan ke `data_lifecycle`, lihat `awcms-mini-data-lifecycle`);
materialized view milik modul `reporting` di atas aktivitas event.

## Verifikasi

`tests/unit/domain-event-{registry-parity,runtime-consumer-registry,runtime-envelope,runtime-retry}.test.ts`
dan `tests/integration/domain-event-runtime.integration.test.ts`. Jalankan
`bun test` dengan `DATABASE_URL` — tanpa itu seluruh test integration dilewati
diam-diam.
