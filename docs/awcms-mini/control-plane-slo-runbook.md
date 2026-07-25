# Control-plane SLO dan alert runbook

Issue #930, epic #868 (`saas-control-plane`), ADR-0022. Dokumen ini adalah
**tujuan `runbookPath`** setiap `ServiceLevelObjectiveDescriptor` yang
dideklarasikan modul control-plane di `module.ts`-nya sendiri. Gate
`bun run slo:registry:check` memverifikasi file ini ADA — tautan runbook
yang mati baru ketahuan jam 3 pagi justru lebih buruk daripada tidak ada
tautan sama sekali, karena responder sudah terlanjur mempercayainya.

## Kenapa control-plane butuh SLO sendiri

Control plane adalah satu-satunya subsistem yang kemacetannya **tidak
terlihat oleh siapa pun**: tenant yang masih menunggu provisioning tidak
bisa melihat antrean itu, dan tenant yang sudah ter-provision tidak
terpengaruh. Tidak ada laporan tenant-scoped yang akan menunjukkannya,
karena tenant-nya sendiri belum ada. Karena itu setiap objective di sini
diukur **fleet-wide**, bukan per tenant.

## Aturan kardinalitas (tidak bisa dilanggar secara struktural)

Setiap `metricName` pada descriptor WAJIB sudah terdaftar di
`METRIC_DEFINITIONS` (`src/lib/observability/metrics-port.ts`), dan setiap
`dimension` WAJIB salah satu dari `allowedLabelKeys` metrik itu sendiri.

Konsekuensinya: sebuah objective **tidak bisa memperkenalkan label baru**,
jadi tidak bisa memasukkan tenant id, referensi provider, atau resource id
sebagai dimensi alert. Registry metrik sudah membatasi himpunan itu lebih
dulu, dan `recordCounter`/`recordGauge` diam-diam membuang label apa pun di
luar itu. Ini yang membuat kriteria "SLO dan alert memakai dimensi
berkardinalitas rendah" benar **secara konstruksi**, bukan karena review.

Operator menemukan tenant spesifik lewat API baca yang ter-reauthorize,
**tidak pernah** lewat label metrik.

## Dari mana angkanya datang

`bun run control-plane:fleet-sweep` (`scripts/control-plane-fleet-sweep.ts`,
jadwal disarankan tiap 5 menit). Inilah **cross-tenant read model** yang
dulu ditandai sebagai utang di `tenant-provisioning:reconcile` ("a
fleet-wide batch would need a purpose-built cross-tenant read-model,
ADR-0022 §6b"). Bentuknya adalah intinya:

1. Enumerasi tenant dari direktori tenant GLOBAL.
2. Untuk tiap tenant, masuk ke konteks RLS tenant itu dan baca **hanya
   baris miliknya**.
3. Agregasi ke total fleet di memori aplikasi.

Tidak ada satu query pun yang melihat baris dua tenant sekaligus, dan tidak
ada yang butuh `BYPASSRLS` maupun platform-claim di predikat policy —
persis yang dijaga `bun run rls:platform-claim:check`.

Sweep ini **READ-ONLY**. Ia tidak pernah merekonsiliasi, mencabut,
me-retry, atau memajukan apa pun. Job yang sekaligus mengamati DAN
memutasi membuat "metriknya bergerak" jadi ambigu antara "fleet-nya
berubah" dan "sweep-nya yang mengubah". Remediasi tetap di engine
per-tenant lewat entry point-nya sendiri yang teraudit.

Dua perilaku yang sengaja dipilih dan mudah salah:

- **Setiap gauge diemit walau nilainya NOL.** Gauge yang berhenti dilaporkan
  tidak bisa dibedakan dari kolektor yang mati di time-series backend mana
  pun — "no data" biasanya tampil sebagai celah, bukan alarm. Menulis 0
  secara eksplisit itulah yang membuat operator bisa membedakan "tidak ada
  masalah" dari "tidak ada yang mengawasi".
- **Sweep yang dibatalkan di tengah TIDAK mempublikasikan apa pun.** Total
  fleet dari sebagian tenant terbaca sebagai PENURUNAN fleet-wide — persis
  bentuk sebuah pemulihan — dan akan diam-diam memadamkan alert yang
  seharusnya masih menyala.

Job berjalan sebagai `awcms_mini_worker` dengan grant SELECT dari migration
`103`. Catatan untuk debugging: `DATABASE_URL` developer biasanya superuser,
dan superuser **melewati grant DAN RLS** — jadi sweep bisa tampak jalan
sempurna secara lokal padahal grant-nya kurang (gagal di tenant pertama saat
deploy) sekaligus diam-diam membaca semua tenant sekaligus. Integration test
kolektor karena itu berjalan sebagai role worker sungguhan.

## Apa yang boleh muncul di permukaan status

`GET /api/v1/logs/observability/slo` mengembalikan **status aman saja**:
kunci objective, judul, severity tertinggi yang sedang breach, dan tautan
runbook. Endpoint itu TIDAK pernah mengembalikan nilai konfigurasi
(ambang, ukuran pool, host, kredensial provider), dan tidak pernah nilai
metrik mentah per tenant.

---

## tenant-provisioning-backlog

**Objective** `tenant_provisioning.provisioning_backlog_drains` — antrean
provisioning fleet-wide terus terkuras.

Antrean yang berhenti terkuras berarti tenant baru diam-diam tidak pernah
selesai onboarding.

1. Cek apakah worker-nya memang jalan: `bun run tenant-provisioning:reconcile`
   punya lease per tenant — lease yang tidak pernah dilepas menahan seluruh
   antrean. Lihat `awcms_mini_tenant_provisioning_job_leases`.
2. Bedakan **stuck** dari **menunggu**: attempt berstatus `waiting` memang
   sedang menunggu keputusan manusia (lihat
   [manual intervention](#control-plane-manual-intervention)), bukan macet.
3. Attempt `failed` yang menumpuk = langkah provisioning yang gagal
   berulang. Baca `last_error` attempt itu lewat API operator, jangan dari
   metrik.
4. Kalau seluruh antrean berhenti sekaligus, curigai saturasi pool database
   (`GET /api/v1/database/pool/health`) sebelum menyalahkan modulnya.

## tenant-provisioning-age

**Objective** `tenant_provisioning.provisioning_attempt_age` — usia attempt
non-terminal tertua tetap di bawah ambang.

Kedalaman antrean saja tidak bisa membedakan antrean sehat yang sesaat
dalam dari antrean macet yang permanen dangkal; **usia** bisa. Objective ini
sengaja ada berdampingan dengan backlog di atas justru karena itu.

Kalau usia naik terus sementara kedalaman stabil: ada satu attempt yang
tidak pernah maju, bukan beban tinggi. Cari attempt tertua dan periksa
langkah mana yang tidak selesai.

## tenant-entitlement-expiry-sweep

**Objective** `tenant_entitlement.expired_entitlements_swept` — assignment yang
jendela validitasnya sudah lewat dipindahkan ke status `expired` dalam satu
interval sweep. Konsumennya: `bun run tenant-entitlement:expiry-sweep`.

> **Koreksi (Issue #930 Wave 3).** Versi pertama halaman ini menyatakan backlog
> ini berarti tenant "masih memegang akses yang seharusnya sudah dicabut" dan
> memperlakukannya sebagai insiden access-control. **Itu keliru.**
> `assignmentActive()` di `domain/resolution.ts` sudah mengembalikan null begitu
> `now >= effectiveTo`, jadi assignment kedaluwarsa **tidak memberi grant apa
> pun** terlepas sweep sudah jalan atau belum — tidak ada akses yang tertahan.
> Re-subscribe juga tidak terhalang, karena `assignOffer` men-supersede baris
> incumbent di transaksinya sendiri.
>
> Severity diturunkan (`info`/`warning`, bukan `warning`/`critical`) mengikuti
> koreksi itu. Severity palsu bukan sekadar melebih-lebihkan: ia menaruh
> pembukuan rutin di antrean yang sama dengan pelanggaran nyata, dan itulah cara
> alert sungguhan mulai diabaikan.

Yang sebenarnya diukur: **drift pembukuan**. Listing operator, laporan
komersial, dan projection entitlement semuanya membaca `status`, sehingga
kumpulan baris `active` yang jendelanya sudah lama tutup membuat catatan
komersial tidak sesuai kenyataan. Penegakan entitlement tidak terpengaruh.

1. Cek `tenant-entitlement:expiry-sweep` terjadwal dan run terakhirnya sukses
   (telemetri job). Kegagalan sweep tidak boleh ditelan diam-diam.
2. Kalau sweep jalan tapi angkanya tidak turun: cek grant `UPDATE` untuk role
   `awcms_mini_worker` pada `awcms_mini_tenant_entitlement_assignments`
   (migration 104). Tanpa grant itu sweep gagal per-tenant, dan kegagalan
   per-tenant memang sengaja tidak menghentikan seluruh armada.
3. **Jangan** "perbaiki" dengan UPDATE massal manual. Tidak ada akses yang
   berisiko, jadi tidak ada alasan mendesak untuk melewati jalur yang mengaudit.

## subscription-billing-dunning

**Objective** `subscription_billing.overdue_invoices_advance` — invoice
lewat jatuh tempo bergerak maju melalui tahapan dunning.

Tahapan yang berhenti bergerak menandakan **sweep dunning tidak jalan**,
bukan bahwa pelanggan tiba-tiba membayar. Itu perbedaan yang mahal: yang
pertama butuh operator, yang kedua tidak.

1. Cek `bun run subscription-billing:run-dunning` dan
   `:run-renewal` — keduanya per-tenant lease.
2. Distribusi yang menumpuk di satu `dunningStage` = transisi keluar dari
   tahap itu yang gagal, bukan beban masuk.

## payment-gateway-dlq

**Objective** `payment_gateway.dead_letter_queue_drained` — DLQ outbox
pembayaran tetap kosong.

Setiap baris di DLQ adalah pekerjaan provider yang **sudah kehabisan retry
dan tidak akan pernah dicoba lagi tanpa tindakan operator**. DLQ yang tidak
kosong bukan backlog — itu kehilangan permanen sampai seseorang bertindak.

1. Baca alasan kegagalan lewat API operator (ter-mask), bukan dari payload
   provider mentah.
2. Sebelum requeue massal, pastikan penyebabnya sudah hilang — requeue ke
   provider yang masih down hanya memindahkan masalah.
3. Circuit breaker provider yang terbuka (`provider_circuit_state`) sering
   jadi penyebab hulu; perbaiki itu dulu.

## payment-gateway-webhook-backlog

**Objective** `payment_gateway.webhook_backlog_absorbed` — envelope webhook
yang diterima ternormalisasi.

Event provider yang **lolos verifikasi tanda tangan** tapi tidak pernah
diserap tidak terlihat sama sekali dari state payment intent — persis titik
buta yang juga jadi alasan modul ini punya reporting projection sendiri.

Backlog naik sementara `provider_call_total` normal = masalah ada di sisi
normalisasi kita, bukan di provider.

## reporting-projection-freshness

**Objective** `reporting.projection_freshness` — jumlah projection dalam
keadaan `stale`/`failed` tetap nol.

Projection yang diam-diam berhenti update melaporkan **angka yang salah
dengan percaya diri**, bukan tidak melaporkan angka — dan itu kegagalan yang
lebih berbahaya, karena operator mengambil keputusan di atasnya.

1. `bun run reporting:projections:refresh`.
2. `failed` (kegagalan beruntun) berbeda dari `stale` (hanya tertinggal):
   yang pertama hampir selalu kesalahan kode/permission, yang kedua beban.
3. Jangan rebuild sebelum tahu penyebabnya — rebuild menghapus bukti
   sebab-akibatnya.

## control-plane-manual-intervention

**Objective** `tenant_provisioning.manual_intervention_bounded` — jumlah
alur control-plane yang parkir menunggu keputusan manusia tetap terbatas.

Objective ini sengaja **bukan** alert "sistem rusak". Ia membedakan "sistem
macet" dari "sistem benar-benar sedang menunggu operator yang belum
melihat". Yang kedua tetap butuh SLA, karena tenant di ujungnya tetap
menunggu.

Naik terus = tidak ada yang memproses antrean keputusan. Eskalasi ke pemilik
proses, bukan ke on-call teknis.
