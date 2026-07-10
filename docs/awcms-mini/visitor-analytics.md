# Visitor Analytics — panduan operasional dan kepatuhan

Dokumen ini melengkapi epic visitor analytics (Issue #617-#624) dengan
panduan operasional level-praktis: mode deployment, privacy-first
default, retensi data per kolom/tabel, dan pemetaan kontrol yang sudah
diimplementasikan ke kerangka kepatuhan yang relevan (UU PDP, PP PSTE,
ISO/IEC 27001/27002/27005/27701, OWASP ASVS, OWASP Logging Cheat Sheet).

Referensi terkait:

- `src/modules/visitor-analytics/README.md` — detail implementasi per
  issue (schema, collector, API, dashboard, geo enrichment, rollup/purge).
- `.claude/skills/awcms-mini-visitor-analytics/SKILL.md` — konteks
  cross-issue, keputusan yang sudah dibuat, apa yang tidak boleh
  di-re-derive.
- `18_configuration_env_reference.md` §Visitor analytics — referensi
  penuh 16 env var.
- `20_threat_model_security_architecture.md` §Standar tambahan dipicu
  epic visitor analytics — model ancaman.
- `04_erd_data_dictionary.md` §Visitor Analytics dan §Retention awal —
  skema tabel dan tabel retensi ringkas.

## Ringkasan modul

Modul `visitor_analytics` (`type: "system"`) mengumpulkan statistik
pengunjung manusia **privacy-first** untuk rute admin dan publik —
jumlah pengunjung unik, pageview, breakdown browser/device/negara,
traffic bot — tanpa menyimpan data pribadi mentah kecuali operator
secara eksplisit mengaktifkannya. Tiga tabel tenant-scoped
(`awcms_mini_visitor_sessions`, `awcms_mini_visit_events`,
`awcms_mini_visitor_daily_rollups`), semua `ENABLE`+`FORCE ROW LEVEL
SECURITY`.

Prinsip inti yang mengikat setiap mode operasi di bawah:

1. **Default aman tanpa konfigurasi apa pun.** Modul aktif secara
   default (`VISITOR_ANALYTICS_ENABLED=true`) tapi tiga sub-fitur paling
   sensitif — raw IP, raw user-agent, geolokasi — semuanya mati secara
   default dan independen satu sama lain. `bun run config:validate`
   selalu lulus tanpa satu pun `VISITOR_ANALYTICS_*` di-set.
2. **Retensi lebih pendek untuk data lebih sensitif.** Raw detail (30
   hari default) < event (90 hari default) < rollup agregat (730 hari
   default). Lihat §Retensi di bawah untuk detail per kolom.
3. **`raw_detail.read` terpisah dari `dashboard.read`.** Operator bisa
   memberi akses dashboard agregat tanpa memberi akses IP/user-agent
   mentah.
4. **Tidak pernah panggilan jaringan eksternal.** Geolokasi berasal dari
   header Cloudflare (`CF-IPCountry`) yang sudah ada di request, bukan
   API pihak ketiga — konsisten dengan modul yang berjalan penuh
   offline/LAN.

## Mode operasi

### Mode offline/LAN (default)

Deployment yang tidak pernah tersambung internet publik — atau memang
sengaja LAN-only — menjalankan modul ini tanpa mengubah satu env var
pun. Statistik dasar (dashboard `/admin/analytics`: pengunjung unik,
pageview, top paths/browsers/devices, traffic bot) berfungsi penuh:

- `VISITOR_ANALYTICS_ENABLED=true` (default) — koleksi tetap jalan,
  murni operasi database lokal (INSERT ke `awcms_mini_visit_events`
  lewat middleware, tidak pernah keluar proses).
- `VISITOR_ANALYTICS_RAW_IP_ENABLED=false`,
  `_RAW_USER_AGENT_ENABLED=false`, `_GEO_ENABLED=false` (semua default)
  — tidak ada IP mentah, user-agent mentah, atau negara pengunjung yang
  pernah tersimpan. Kolom `ip_address` di `awcms_mini_visitor_sessions`
  tetap `NULL` selamanya di mode ini.
- `VISITOR_ANALYTICS_TRUST_PROXY`/`_TRUST_CLOUDFLARE=false` (default) —
  IP klien di-resolve dari `clientAddress` koneksi langsung saja, tidak
  pernah dari header yang bisa dipalsukan klien LAN.
- Job terjadwal (`analytics:rollup`, `analytics:purge`) aman dijalankan
  di sini — keduanya operasi database murni tanpa dependency provider
  eksternal apa pun (lihat §Rollup dan §Purge di bawah).

### Mode full online (tanpa proxy tepercaya)

Deployment online publik yang **tidak** menempatkan origin di belakang
proxy/CDN tepercaya harus membiarkan `VISITOR_ANALYTICS_TRUST_PROXY`/
`_TRUST_CLOUDFLARE` tetap `false` — mempercayai header
`X-Forwarded-For`/`CF-Connecting-IP` tanpa proxy tepercaya nyata berarti
klien mana pun bisa memalsukan IP-nya sendiri di data analytics
(spoofing, bukan sekadar noise). Statistik dasar tetap berfungsi sama
seperti mode offline/LAN; hanya resolusi IP klien yang kurang akurat di
balik load balancer/reverse-proxy generik (`clientAddress` adalah IP
proxy, bukan IP klien asli) — trade-off yang diterima demi tidak
mempercayai header yang bisa dipalsukan.

### Mode trusted proxy / Cloudflare

Hanya bila origin **benar-benar** hanya bisa dijangkau lewat proxy/CDN
tepercaya (mis. firewall origin ke rentang IP Cloudflare saja):

- `VISITOR_ANALYTICS_TRUST_PROXY=true` — percaya `X-Forwarded-For` untuk
  resolusi IP klien di belakang reverse-proxy generik.
- `VISITOR_ANALYTICS_TRUST_CLOUDFLARE=true` — percaya `CF-Connecting-IP`
  (IP klien) **dan** `CF-IPCountry` (negara) sekaligus, khusus di
  belakang edge Cloudflare.
- `VISITOR_ANALYTICS_GEO_ENABLED=true` **dan**
  `VISITOR_ANALYTICS_TRUST_CLOUDFLARE=true` (keduanya wajib) untuk
  mengaktifkan breakdown negara pengunjung di dashboard. Salah satu saja
  aktif menghasilkan semua field geo `null` (fail-safe) —
  `bun run security:readiness`'s `checkVisitorAnalyticsGeoTrustedSourceReady`
  (Issue #624, critical) menolak kombinasi "geo aktif tanpa trust
  Cloudflare" sebelum go-live, supaya operator tidak mengira fitur aktif
  padahal diam-diam kosong.

**Kontrak operasional wajib**: proxy tepercaya harus MENIMPA (overwrite)
header `X-Forwarded-For`/`CF-Connecting-IP`/`CF-IPCountry` di setiap
request, tidak pernah meneruskan (append) nilai dari klien apa adanya.
`resolveAnalyticsClientIp` menolak header yang membawa >1 nilai
comma-separated (anomali, fallback ke sumber berikutnya + log warning) —
proxy yang dikonfigurasi benar tidak pernah menghasilkan itu.

### Raw IP / raw user-agent (opsional, semua mode)

Independen dari mode di atas — hanya nyalakan bila benar-benar
dibutuhkan (mis. investigasi keamanan jangka pendek, debugging abuse):

- `VISITOR_ANALYTICS_RAW_IP_ENABLED=true` — mengisi
  `awcms_mini_visitor_sessions.ip_address` (kolom `inet`). Wajib disertai
  `VISITOR_ANALYTICS_RAW_DETAIL_RETENTION_DAYS` yang pendek (default 30
  hari, tidak boleh melebihi `VISITOR_ANALYTICS_EVENT_RETENTION_DAYS`) —
  `bun run security:readiness`'s `checkVisitorAnalyticsRawIpRetentionReady`
  (critical) menggagalkan go-live bila urutan ini dilanggar.
- `VISITOR_ANALYTICS_RAW_USER_AGENT_ENABLED=true` — **saat ini no-op**:
  belum ada kolom raw-user-agent (hanya `user_agent_hash` +
  `user_agent_parsed` hasil parse yang tersimpan). Tetap divalidasi
  (`checkVisitorAnalyticsRawUserAgentRetentionReady`, warning) untuk
  kesiapan retensi hari flag ini benar-benar diwire ke kolom nyata.

## Retensi data (per tabel/kolom)

| Data                                                                 | Retensi default                                  | Env var                                       | Mekanisme purge                                            |
| -------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------- | ---------------------------------------------------------- |
| `awcms_mini_visit_events` (seluruh baris)                            | 90 hari                                          | `VISITOR_ANALYTICS_EVENT_RETENTION_DAYS`      | Hard delete (`bun run analytics:purge`)                    |
| `awcms_mini_visitor_sessions.ip_address`/`login_identifier_snapshot` | 30 hari (dari `last_seen_at`)                    | `VISITOR_ANALYTICS_RAW_DETAIL_RETENTION_DAYS` | Cleared in place (row tetap ada)                           |
| `awcms_mini_visitor_sessions` (seluruh baris)                        | 90 hari (dari `last_seen_at`, sama dengan event) | `VISITOR_ANALYTICS_EVENT_RETENTION_DAYS`      | Hard delete, hanya bila tanpa event tersisa (`NOT EXISTS`) |
| `awcms_mini_visitor_daily_rollups` (seluruh baris)                   | 730 hari                                         | `VISITOR_ANALYTICS_ROLLUP_RETENTION_DAYS`     | Hard delete (`bun run analytics:purge`)                    |

Urutan retensi (raw detail ≤ event ≤ rollup) adalah invarian yang
ditegakkan `bun run security:readiness`'s
`checkVisitorAnalyticsRetentionOrderingReady` (warning — hygiene
konfigurasi, bukan pelanggaran keamanan langsung) dan
`checkVisitorAnalyticsRawIpRetentionReady` (critical — spesifik untuk
raw IP yang benar-benar aktif). "Unless explicitly justified" (kata-kata
issue asli): operator yang punya alasan sah membalik urutan ini (mis.
kebutuhan investigasi jangka panjang) bisa menerima warning tersebut
secara sadar — `security:readiness` tidak memblokir go-live untuk
pelanggaran severity `warning`, hanya `critical`.

## Rollup (`bun run analytics:rollup`, Issue #624)

`scripts/visitor-analytics-rollup.ts` mengagregasi
`awcms_mini_visit_events` mentah menjadi
`awcms_mini_visitor_daily_rollups`, satu baris per `(tenant, date,
area)`, untuk setiap tenant `active`:

- **Idempotent by construction** — setiap run merekomputasi total penuh
  dari event mentah dan UPSERT (`ON CONFLICT (tenant_id, date, area) DO
UPDATE SET ... = EXCLUDED...`), tidak pernah menambah ke nilai lama.
  Menjalankan ulang tanggal yang sama menghasilkan baris identik,
  diverifikasi `tests/integration/visitor-analytics-rollup.integration.test.ts`.
- **Kolom yang diisi**: `human_unique_visitors`, `human_pageviews`,
  `bot_pageviews`, `authenticated_unique_users`,
  `public_unique_visitors` (khusus baris `area='public'`),
  `admin_unique_users` (khusus baris `area='admin'`), dan empat array
  top-10 (`top_paths`/`top_browsers`/`top_devices`/`top_countries`,
  `jsonb`).
- **Area tanpa event pada tanggal itu tidak mendapat baris** — bukan
  baris bernilai nol; sama seperti tabel `awcms_mini_visit_events`
  sumbernya sendiri.
- **Argumen CLI**: `--date=YYYY-MM-DD` (satu tanggal), atau
  `--start-date=.../--end-date=...` (rentang inklusif, untuk backfill).
  Tanpa argumen, default merangkum "kemarin" (UTC) — cocok dijalankan
  cron harian setelah tengah malam UTC, saat hari sebelumnya sudah
  final/tidak berubah lagi.
- **Tidak menyentuh data raw sensitif** — rollup hanya menghitung dan
  meringkas (count, top-N by name), tidak pernah menyalin
  `ip_address`/`login_identifier_snapshot`/nilai raw lain ke tabel
  agregat.

## Purge (`bun run analytics:purge`, Issue #624)

`scripts/visitor-analytics-purge.ts` memanggil
`purgeVisitorAnalyticsData` (`src/modules/visitor-analytics/application/retention-purge.ts`)
langsung untuk setiap tenant `active` — fungsi yang SAMA dipakai
`POST /api/v1/analytics/retention/purge` (Issue #621) untuk purge
on-demand. Job terjadwal ini tidak pernah men-derive ulang aturan
purge-nya sendiri secara terpisah.

Empat cutoff independen per run (detail lengkap di
`application/retention-purge.ts`'s doc comment):

1. `awcms_mini_visit_events` lebih tua dari `eventRetentionDays` — hard
   delete.
2. `ip_address`/`login_identifier_snapshot` di
   `awcms_mini_visitor_sessions` lebih tua dari `rawDetailRetentionDays`
   — dikosongkan di tempat, baris tetap ada (field
   browser/device/OS agregat tetap berguna lama setelah raw detail
   seharusnya hilang).
3. `awcms_mini_visitor_sessions` lebih tua dari `eventRetentionDays` —
   hard delete, hanya bila tidak ada `awcms_mini_visit_events` yang
   masih mereferensikannya (`NOT EXISTS`, mencegah pelanggaran FK dari
   write-throttle collector).
4. `awcms_mini_visitor_daily_rollups` lebih tua dari
   `rollupRetentionDays` — hard delete.

**Audit**: hanya tenant yang benar-benar memiliki baris
terhapus/terbersihkan yang mendapat audit event baru
(`module_key='visitor_analytics'`, `action='retention_purged'`,
`severity='critical'`, `resourceType='visitor_analytics_data'`) —
attributes hanya berisi empat angka ringkasan (`eventsDeleted`,
`sessionsRawDetailCleared`, `sessionsDeleted`, `rollupsDeleted`), tidak
pernah data mentah/daftar baris yang terhapus. Tenant tanpa data
kedaluwarsa tidak menghasilkan audit noise.

**Tidak ada lapisan batching tambahan** di atas apa yang
`purgeVisitorAnalyticsData` sudah lakukan (satu set statement per tenant
per run, sudah direview+diuji di Issue #621) — menambah skema batching
kedua yang berbeda akan menjadi bentuk re-derivation yang justru
dilarang doc comment fungsi tersebut.

**Rekomendasi jadwal**: jalankan `analytics:purge` setelah
`analytics:rollup` (lihat `deployment-profiles.md` §Job registry
lainnya) — supaya data yang akan dipurge sudah teragregasi ke rollup
lebih dulu.

## Config dan readiness checks (Issue #624)

Dua lapis validasi, konsisten dengan pola setiap fitur bergerbang
lainnya di repo ini (`checkOnlineAuthSecurityConfig`/`Ready`,
`checkTurnstileConfig`/`Ready`, dst.):

- **`bun run config:validate`** (`scripts/validate-env.ts`'s
  `checkVisitorAnalyticsConfig`, Issue #617) — validasi SHAPE saja:
  `VISITOR_ANALYTICS_MODE` enum dikenal, empat var retensi/jendela
  integer positif bila diisi. Tidak ada aturan cross-field di sini
  (dan sengaja tidak ditambah di Issue #624 — lihat keputusan desain di
  bawah).
- **`bun run security:readiness`** (`scripts/security-readiness.ts`,
  Issue #624) — lima check cross-field baru, semua reuse
  `resolveVisitorAnalyticsConfig` (tidak pernah baca `process.env`
  langsung):

  | Check                                             | Severity | Kondisi fail                                                                               |
  | ------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------ |
  | `checkVisitorAnalyticsRawIpRetentionReady`        | critical | Raw IP aktif dan retensi raw detail > retensi event                                        |
  | `checkVisitorAnalyticsRawUserAgentRetentionReady` | warning  | Raw user-agent aktif dan retensi raw detail > retensi event (flag ini sendiri masih no-op) |
  | `checkVisitorAnalyticsGeoTrustedSourceReady`      | critical | Geo aktif tanpa `VISITOR_ANALYTICS_TRUST_CLOUDFLARE`                                       |
  | `checkVisitorAnalyticsRetentionOrderingReady`     | warning  | Retensi raw detail > event, ATAU retensi rollup < event                                    |
  | `checkVisitorAnalyticsHashSaltReady`              | warning  | Modul aktif dan `VISITOR_ANALYTICS_HASH_SALT` kosong                                       |

  Hanya `critical` yang memblokir go-live (exit non-zero); `warning`
  dilaporkan tapi tidak memblokir — default privacy-first (semua var
  tidak di-set) selalu lulus BERSIH tanpa satu pun finding dari kelima
  check ini.

**Keputusan desain — kenapa cross-field rule ada di `security-readiness.ts`,
bukan `validate-env.ts`'s `checkVisitorAnalyticsConfig`**: pola yang
sudah mapan di repo ini (`checkOnlineAuthSecurityConfig` vs
`checkOnlineAuthSecurityReady`, dst.) memisahkan "apakah SHAPE var ini
valid" (`validate-env.ts`, tidak butuh judgment call keamanan) dari
"apakah KOMBINASI var ini aman untuk go-live" (`security-readiness.ts`,
punya `CheckSeverity` critical/warning/info dan `OUT_OF_SCOPE_ITEMS`
untuk kejujuran cakupan). Lima aturan Issue #624 di atas semuanya
judgment call keamanan lintas-field (raw IP + retensi, geo + trust,
retensi rollup vs event, salt + status aktif) — bukan validasi bentuk
satu var — jadi mengikuti pola yang sama menghindari duplikasi konsep
`CheckSeverity` di `validate-env.ts` yang tidak pernah punya itu.

## Pemetaan kepatuhan

Tabel di bawah memetakan kontrol yang **sudah diimplementasikan**
(bukan daftar aspirasional) ke pasal/kontrol praktik dari masing-masing
kerangka. Level praktis — merujuk fungsi/file konkret, bukan pernyataan
umum.

### UU PDP (Undang-Undang Pelindungan Data Pribadi, UU No. 27/2022)

| Prinsip UU PDP                                                            | Implementasi                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Minimisasi data** (Pasal 16 — pemrosesan sesuai tujuan, tidak berlebih) | Raw IP/user-agent/geolokasi (kelas data yang paling mudah mengidentifikasi individu) semuanya mati secara default; hanya hash (`ip_hash`/`user_agent_hash`, HMAC-SHA256 keyed salt deployment) dan field agregat (browser/device/negara) yang tersimpan default. |
| **Batasan penyimpanan** (Pasal 16 — data disimpan sepanjang perlu saja)   | Retensi bertingkat (raw detail 30 hari < event 90 hari < rollup 730 hari), ditegakkan job terjadwal `analytics:purge` + diverifikasi ulang tiap `security:readiness` (§Retensi di atas).                                                                         |
| **Keamanan pemrosesan** (Pasal 39 — langkah teknis melindungi data)       | RLS `ENABLE`+`FORCE` per tenant (isolasi lintas-tenant di level database, bukan hanya filter aplikasi), ABAC default-deny untuk setiap endpoint baca (`authorizeInTransaction`), permission `raw_detail.read` terpisah dari `dashboard.read`.                    |
| **Hak subjek data — akses terbatas ke pihak berwenang saja**              | Dashboard `/admin/analytics` dan endpoint `GET /api/v1/analytics/*` (Issue #621) hanya untuk actor dengan permission eksplisit; pengunjung publik tidak punya antarmuka untuk melihat data mereka sendiri (di luar cakupan — modul ini observability internal).  |
| **Akuntabilitas pemrosesan** (Pasal 44 — dokumentasi pemrosesan)          | Dokumen ini + `src/modules/visitor-analytics/README.md` + skill mendokumentasikan seluruh alur data: apa yang dikumpulkan, kapan, berapa lama disimpan, siapa yang bisa akses.                                                                                   |

### PP PSTE (Penyelenggaraan Sistem dan Transaksi Elektronik, PP No. 71/2019 + turunannya)

Kewajiban umum penyelenggara sistem elektronik yang relevan sudah
tercakup lewat kontrol teknis yang sama dipakai modul lain (RLS, ABAC,
audit, secret hygiene — lihat `20_threat_model_security_architecture.md`)
— tidak ada kewajiban PSTE spesifik-analytics tambahan yang
teridentifikasi di luar itu untuk base generik ini:

- **Keandalan sistem elektronik**: koleksi telemetry fail-open (tidak
  pernah menggagalkan request admin/publik yang sebenarnya — error
  koleksi hanya dicatat sebagai `log("warning", ...)`, tidak pernah
  dilempar ke response).
- **Perlindungan data pengguna sistem**: sama dengan kontrol UU PDP di
  atas (minimisasi, retensi, RLS, ABAC).
- Kewajiban sertifikasi/pendaftaran PSE (bila berlaku untuk skala
  operator tertentu) tetap tanggung jawab lapisan operasional aplikasi
  turunan, bukan sesuatu yang bisa dibuktikan dari kode.

### ISO/IEC 27001:2022 Annex A (kontrol relevan-kode)

| Kontrol Annex A                         | Implementasi                                                                                                                                                                        |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A.5.12 Klasifikasi informasi**        | IP/user-agent/geolokasi diperlakukan sebagai kelas data sensitif terpisah dari data agregat — permission `raw_detail.read` sendiri.                                                 |
| **A.8.10 Penghapusan informasi**        | `analytics:purge` (hard delete + in-place clear) sesuai retensi terkonfigurasi; tidak ada baris raw yang bertahan tanpa batas waktu.                                                |
| **A.8.15 Logging**                      | Purge itu sendiri diaudit (`retention_purged`, critical) — aksi penghapusan data bukan operasi senyap.                                                                              |
| **A.8.16 Aktivitas pemantauan**         | Dashboard/API menyediakan visibility pengunjung/traffic bot untuk tenant sendiri; tidak ada integrasi SIEM eksternal (out of scope).                                                |
| **A.8.24 Penggunaan kriptografi**       | `ip_hash`/`user_agent_hash`/`visitor_key_hash` = HMAC-SHA256 keyed `VISITOR_ANALYTICS_HASH_SALT` (bukan SHA256 polos) — mencegah korelasi lintas-deployment lewat tabel precompute. |
| **A.5.34 Privasi dan perlindungan PII** | Prinsip privacy-first default menyeluruh (§Ringkasan modul di atas) adalah implementasi langsung kontrol ini.                                                                       |

### ISO/IEC 27002:2022 (panduan implementasi kontrol di atas)

Panduan 27002 untuk kontrol Annex A yang sama di atas sudah tercermin
langsung di level kode, bukan hanya kebijakan tertulis: kontrol 8.10
(penghapusan) diimplementasikan sebagai job otomatis terjadwal (bukan
proses manual yang bisa terlewat), kontrol 5.12 (klasifikasi) sebagai
constraint permission yang ditegakkan database (bukan konvensi
penamaan), dan kontrol 8.24 (kriptografi) sebagai fungsi hash bersama
yang dipakai ulang di semua titik penulisan (`hashIpAddress`/
`hashUserAgent`/`hashVisitorKey`, satu implementasi, bukan tersebar).

### ISO/IEC 27005:2023 (manajemen risiko)

Pendekatan risk-treatment yang dipakai epic ini: setiap sub-fitur
berisiko tinggi (raw IP, raw user-agent, geolokasi) di-treat dengan
**avoidance-by-default** (mati kecuali eksplisit diaktifkan) ketimbang
mitigasi setelah aktif — pilihan yang lebih kuat dari sekadar
"mitigasi risiko" karena risiko tidak pernah terealisasi kecuali
operator secara sadar memilih trade-off-nya. Risiko residual yang
diterima secara eksplisit (bukan diabaikan diam-diam):

- Region/city/timezone selalu `null` (belum ada GeoIP lokal) — risiko
  "data lokasi tidak lengkap", diterima karena alternatifnya (GeoIP
  database pihak ketiga) memperkenalkan dependency baru di luar
  cakupan epic ini.
- `VISITOR_ANALYTICS_HASH_SALT` kosong tetap lulus `security:readiness`
  (warning, bukan critical) — risiko "korelasi hash lintas-deployment
  lewat precompute table", diterima karena menaikkan ke critical akan
  menggagalkan setiap deployment default yang sudah ada tanpa manfaat
  proporsional (lihat tabel severity di §Config dan readiness checks).

### ISO/IEC 27701:2019 (ekstensi privasi untuk ISO 27001, PIMS)

Modul ini beroperasi sebagai **PII controller** untuk data pengunjung
tenant sendiri (bukan PII processor pihak ketiga — tidak ada data
dikirim ke provider eksternal manapun):

- **6.2 Kondisi pengumpulan dan pemrosesan** — koleksi dibatasi tujuan
  (statistik operasional), tidak pernah dipakai untuk profiling
  individu di luar cakupan modul (tidak ada targeting/personalisasi).
- **7.4 Minimisasi PII (privasi berdasarkan desain)** — privacy-first
  default adalah penerapan langsung "privacy by design and by default"
  yang menjadi inti 27701 — bukan opt-out, tapi opt-in eksplisit per
  flag sensitif.
- **7.9 Penghapusan PII** — job purge terjadwal + retensi bertingkat
  (§Retensi/§Purge di atas).

### OWASP ASVS (Application Security Verification Standard, level L1/L2 relevan)

| Kontrol ASVS                                                            | Implementasi                                                                                                                                                                               |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **V1.8 (klasifikasi data), V8.3 (data sensitif tidak di-cache/di-log)** | Query-string sensitif (`token`/`password`/`secret`/dst., 11 parameter) dibuang oleh `sanitizePath` sebelum path pernah masuk `path_sanitized` — fail-safe untuk input yang gagal di-parse. |
| **V4.1/V4.2 (kontrol akses fungsi/data)**                               | ABAC default-deny per endpoint, `raw_detail.read` terpisah dari `dashboard.read`, RLS `FORCE` per tenant.                                                                                  |
| **V7.4 (error handling tidak membocorkan info sensitif)**               | Koleksi telemetry fail-open — kegagalan hanya di-log `warning`, tidak pernah bocor ke response client.                                                                                     |
| **V9.1/V9.2 (komunikasi, validasi header terpercaya)**                  | `resolveAnalyticsClientIp` hanya mempercayai header forwarded saat trust flag eksplisit `true`; header ambigu (>1 nilai) ditolak.                                                          |
| **V14.3 (konfigurasi aman by default)**                                 | Setiap sub-fitur sensitif default `false`; `config:validate`/`security:readiness` menegakkan kombinasi aman sebelum go-live.                                                               |

### OWASP Logging Cheat Sheet

| Rekomendasi                                                                                                                                                | Implementasi                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Jangan log data sensitif mentah**                                                                                                                        | Query-string sensitif disaring (`sanitizePath`); dua kolom `jsonb` catch-all (`user_agent_parsed`/`geo`) hanya berisi nilai hasil parse, tidak pernah raw request body/header/cookie/Authorization.                                              |
| **Log aksi administratif/berisiko tinggi**                                                                                                                 | Purge (hard delete data) selalu diaudit (`retention_purged`, critical) dengan ringkasan angka, correlation ID untuk pelacakan lintas-hop.                                                                                                        |
| **Retensi log yang wajar, bukan tak terbatas**                                                                                                             | §Retensi di atas — bertingkat sesuai sensitivitas, ditegakkan job terjadwal, bukan manual.                                                                                                                                                       |
| **Integritas log — tidak bisa diubah sembarangan aktor**                                                                                                   | Semua tabel `ENABLE`+`FORCE ROW LEVEL SECURITY`; hanya server-side code (bukan client) yang pernah menulis, lewat collector/rollup/purge terpusat.                                                                                               |
| **Fail-safe, bukan fail-open untuk keputusan keamanan** (catatan: koleksi telemetry sendiri sengaja fail-OPEN, bukan fail-closed — lihat catatan di bawah) | Koleksi (bukan keputusan otorisasi) fail-open by design supaya kegagalan logging tidak pernah memblokir request bisnis nyata — trade-off yang eksplisit, bukan kelalaian; kontras dengan ABAC/RLS yang selalu fail-closed untuk keputusan akses. |

## Batasan yang dicatat, bukan diabaikan

- **Rollup tidak menyertakan parameter area/visitor-type di endpoint
  agregat** — di luar cakupan Issue #624 (perubahan API, bukan job),
  konsisten dengan batasan yang sudah dicatat Issue #622.
- **Tidak ada integrasi SIEM eksternal** — out of scope epic ini;
  extension point `AuditExportHook` (`src/modules/logging/application/audit-log.ts`)
  sudah tersedia untuk aplikasi turunan yang ingin memasangnya sendiri.
- **Tidak ada GeoIP lokal/offline** — region/city/timezone selalu
  `null`; hanya country code dari header Cloudflare yang pernah terisi.
- **`VISITOR_ANALYTICS_RAW_USER_AGENT_ENABLED` masih no-op** — lihat
  §Raw IP / raw user-agent di atas.
