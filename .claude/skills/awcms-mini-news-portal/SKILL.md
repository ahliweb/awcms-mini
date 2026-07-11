---
name: awcms-mini-news-portal
description: Kerjakan bagian mana pun dari epic news_portal AWCMS-Mini (Issue #631-#642, #649). Gunakan saat menambah/mengubah preset full-online R2-only, media object registry, presigned upload flow, R2 readiness checks, homepage composer, ad/video/quality-checklist berbasis media R2, tag linking, atau SEO/social preview `/news`. Merangkum keputusan arsitektur yang sudah dibuat (docs/awcms-mini/news-portal/) supaya issue lanjutan tidak mengulang/kontradiksi.
---

# AWCMS-Mini — News Portal (full-online R2-only media)

Epic `news_portal` (#631-#642, #649) menambah lapisan editorial +
media di atas `blog_content` (base module, sudah `active`) dan online
public routing (`tenant_domain`, ADR-0009/ADR-0010), khusus untuk
deployment **full-online** yang mengaktifkan mode **R2-only** untuk
gambar berita. Epic lanjutan `social-publishing` (#643-#647) **bergantung**
pada fondasi arsitektur epic ini (khususnya media registry #633 untuk
gambar yang dibagikan ke platform sosial) tapi **bukan** bagian tabel
status di bawah — lihat skill/dokumentasi terpisah begitu epic itu
mulai dikerjakan.

## Kapan pakai skill ini vs skill generik

Skill ini melengkapi (bukan menggantikan) `awcms-mini-new-endpoint`,
`awcms-mini-new-migration`, `awcms-mini-integration` (pola outbox/
circuit breaker untuk R2, ADR-0006), `awcms-mini-idempotency` (mutation
`confirm` upload), `awcms-mini-sensitive-data` (foto berpotensi PII),
`awcms-mini-abac-guard`, dan `awcms-mini-blog-content` (model konten
post/page/gallery/ads yang jadi konsumen media registry). Skill ini
menyediakan konteks **cross-cutting epic spesifik** — terutama
keputusan "R2-only, bucket terpisah dari sync-storage" yang wajib
dipertahankan setiap issue.

**Baca dulu** `docs/awcms-mini/news-portal/full-online-r2-architecture.md`
sebelum mengerjakan issue mana pun di epic ini — dokumen itu (bukan
skill ini) adalah sumber kebenaran arsitektur; skill ini merangkum
status + pointer, bukan menduplikasi isinya.

## Status per issue (jangan bangun ulang yang sudah ada)

| Issue | Scope                                                                                                                        | Status                                               |
| ----- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| #631  | Dokumentasi arsitektur full-online R2-only + SOP + security + IR + backup + user guide                                       | **Selesai** — lihat §Dokumen yang sudah ada di bawah |
| #632  | Preset `news_portal_full_online_r2` (module descriptor/config gate)                                                          | **Selesai** — lihat §632 di bawah                    |
| #633  | Tenant-scoped R2-only media object registry (schema + migration)                                                             | **Selesai** — lihat §633 di bawah                    |
| #634  | Direct-to-R2 presigned upload flow (endpoint upload/confirm)                                                                 | **Selesai** — lihat §634 di bawah                    |
| #635  | Config validation + readiness checks (`config:validate`/`security:readiness`/`production:preflight`) untuk R2 image delivery | **Selesai** — lihat §635 di bawah                    |
| #636  | `blog_content` wajib referensi R2 media object untuk gambar berita saat mode aktif                                           | **Selesai** — lihat §636 di bawah                    |
| #637  | Editorial homepage section composer `/news` dengan render R2-only                                                            | **Selesai** — lihat §637 di bawah                    |
| #638  | Preset placement iklan news portal dengan validasi gambar R2-only                                                            | Belum dikerjakan — lihat §638 di bawah               |
| #639  | Content block `video_news` dengan thumbnail R2 wajib                                                                         | Belum dikerjakan — lihat §639 di bawah               |
| #640  | Content quality checklist publishing dengan syarat gambar R2                                                                 | Belum dikerjakan — lihat §640 di bawah               |
| #641  | Automatic internal tag linking untuk konten post/news                                                                        | Belum dikerjakan — lihat §641 di bawah               |
| #642  | Public social share buttons di halaman artikel `/news`                                                                       | Belum dikerjakan — lihat §642 di bawah               |
| #649  | SEO + social preview metadata lengkap di halaman artikel `/news`                                                             | Belum dikerjakan — lihat §649 di bawah               |

Urutan dependency yang disarankan (dari objective masing-masing issue):
631 → 632 → 633 → 634 → 635 (readiness butuh #632-#634 ada untuk
divalidasi) → 636 (butuh #633 registry) → 637/638/639/640 (butuh #636,
bisa paralel satu sama lain) → 641 (independen, hanya butuh
`blog_content` taxonomies yang sudah ada) → 642/649 (butuh #636 untuk
gambar R2 yang valid dipakai preview sosial, bisa paralel).

## Yang sudah ada — pakai ulang, jangan re-derive

### Dokumen arsitektur (Issue #631, `docs/awcms-mini/news-portal/`)

Enam dokumen, semua docs-only (tidak ada kode/migration/endpoint di
issue ini):

- **`full-online-r2-architecture.md`** — dokumen utama. Berisi:
  ruang lingkup full-online-only (§1), keputusan **bucket R2 terpisah
  dari `sync-storage`** (§2 — lihat §Keputusan kunci di bawah), lima
  prinsip inti tidak bisa dinegosiasi (§3), konvensi env var
  `NEWS_MEDIA_R2_*` (§4 — **diimplementasikan Issue #632**: sudah ada di
  `.env.example`/doc 18/`scripts/validate-env.ts`), model data konseptual
  media registry (§5), konvensi
  object key (§6), dua diagram alur upload (§7), lifecycle presigned
  URL (§8), urutan validasi MIME/ekstensi/checksum (§9), CORS (§10),
  custom domain (§11), Cache-Control (§12), rotasi kredensial (§13),
  diagram trust boundary (§14), dan pemetaan kepatuhan penuh ke
  ISO/IEC 27001/27002/27005/27017/27018/27701/27034, ISO 22301, OWASP
  ASVS, OWASP API Security Top 10 (§15).
- **`r2-upload-sop.md`** — SOP operasional Jalur A (direct-to-R2,
  disarankan) dan Jalur B (server-streaming tanpa temp file lokal),
  urutan validasi, penanganan error, troubleshooting operator.
- **`r2-security-checklist.md`** — checklist siap-pakai (validasi,
  object key, presigned URL, CORS, custom domain/cache, kredensial,
  readiness gates, monitoring) + contoh kebijakan API token R2
  least-privilege. §7 checklist ini awalnya menyatakan belum ada check
  nyata sampai #635 — **diperbarui**: shape/separation/SVG checks sudah
  landed lewat Issue #632 (lebih awal dari rencana semula); sisa untuk
  #633/#634/#635 hanya check level schema registry/endpoint upload.
- **`r2-incident-response.md`** — runbook Detect/Contain/Eradicate/
  Recover/Post-incident untuk tiga skenario: presigned URL bocor,
  object exposure publik, upload berbahaya.
- **`r2-backup-lifecycle.md`** — lifecycle objek `pending` (TTL default
  60 menit), retention policy per klasifikasi data, deteksi objek
  `orphaned`, strategi backup (replikasi/versioning — pilihan operator,
  bukan mandat tunggal), kontinuitas (RPO/RTO), privasi/minimisasi.
- **`newsroom-user-guide.md`** — panduan editor/jurnalis (bukan
  developer): cara upload, format/ukuran didukung, pesan error umum,
  praktik terbaik privasi/atribusi, ke mana gambar dipakai.

Test: tidak ada (docs-only, tidak ada acceptance criteria berupa
kode/test di issue #631). Validasi: `bun run lint`, `bun run check:docs`,
`bun run build`.

### Keputusan kunci #1 — bucket R2 terpisah dari `sync-storage` (WAJIB dipertahankan)

`src/modules/sync-storage/` sudah memakai R2 sejak Issue 6.3/#436
(`R2_ENABLED`/`R2_ACCOUNT_ID`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`/
`R2_BUCKET`) sebagai **object queue privat** untuk sinkronisasi
offline/LAN (lampiran/receipt, machine-to-machine via HMAC). News
portal media adalah kebutuhan yang **fundamental berbeda** — publik,
diakses browser, custom domain, CORS untuk direct-upload. **Jangan
pernah** menyatukan keduanya ke bucket/kredensial yang sama:

- Bucket berbeda mencegah kesalahan konfigurasi publik (CORS/custom
  domain) di satu fungsi membocorkan objek privat fungsi lain.
- Kredensial berbeda membatasi blast radius — kompromi token media
  publik (bucket yang memang sudah publik) tidak pernah memberi akses
  tulis ke objek sync privat, dan sebaliknya.
- Konvensi penamaan env var **`NEWS_MEDIA_R2_*`** (bukan `R2_*` yang
  sudah dipakai) — lihat `full-online-r2-architecture.md` §4 untuk
  daftar lengkap yang wajib diikuti implementor persis apa adanya.
- Cloudflare **account** boleh sama (satu akun, dua bucket) — yang
  wajib terpisah adalah bucket dan API token, bukan akun.

**Ditegakkan (bukan hanya didokumentasikan) sejak Issue #632**:
`findNewsMediaR2SeparationViolations`
(`news-portal/domain/news-media-r2-config.ts`) membandingkan
`NEWS_MEDIA_R2_BUCKET`/`_ACCESS_KEY_ID`/`_SECRET_ACCESS_KEY` terhadap
`R2_BUCKET`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` milik
`sync-storage`, dipanggil dari `config:validate`
(`checkNewsMediaR2SeparationFromSyncR2`, gagal `bun run config:validate`/
gate CI-deploy bila sama — **bukan** penegakan boot-time otomatis di
server; `config:validate`/`security:readiness` adalah script CLI mandiri
yang tidak dipanggil dari `src/server.ts`, sama seperti seluruh keluarga
check lain di `validate-env.ts`) DAN
`security:readiness` (`checkNewsPortalFullOnlineR2PresetReady`, critical)
— lihat `r2-security-checklist.md` §7 untuk kontrak lengkap dan apa yang
masih tersisa untuk #633/#634/#635 (schema/endpoint-level checks, bukan
shape/separation ini).

### Keputusan kunci #2 — tidak ada fallback lokal, tidak ada temp file

Mode ini (bila `NEWS_MEDIA_R2_ENABLED=true`) **tidak pernah** menulis
bytes gambar ke `LOCAL_STORAGE_PATH`/disk lokal server sebagai
pengganti R2 — baik sebagai fallback kegagalan maupun sebagai file
sementara di tengah proses upload (`full-online-r2-architecture.md`
§3.3/§3.4, `r2-upload-sop.md` §2/§3). Ini kebalikan dari `sync-storage`
(yang memang menyimpan lokal dulu, upload R2 belakangan via dispatcher
— desain yang benar untuk kasus offline-first-nya). Implementor #634
**wajib** memverifikasi tidak ada `Bun.write(tempPath, ...)`/
`fs.writeFile` perantara di jalur upload manapun sebelum PR dianggap
selesai.

### Keputusan kunci #3 — object key tidak pernah berisi PII/nama file asli

Format wajib: `news-media/{tenantId}/{yyyy}/{mm}/{uuid}.{ext}` — `uuid`
dari `crypto.randomUUID()`, `ext` **diturunkan dari MIME tervalidasi**
(bukan ekstensi asli client). `original_filename` tetap disimpan
sebagai kolom metadata terpisah untuk tampilan, tidak pernah masuk key
(`full-online-r2-architecture.md` §6). Implementor #633 (schema) dan
#634 (endpoint) wajib mengikuti format ini persis.

### Keputusan kunci #4 — status `pending`/`confirmed` tidak mengontrol akses storage

Residual risk yang sudah didokumentasikan dan **wajib** terus
dipertahankan setiap issue lanjutan: begitu objek ter-PUT sukses ke R2,
ia langsung reachable publik lewat custom domain — status Postgres
`pending` **tidak** memblokir pembacaan storage-level
(`full-online-r2-architecture.md` §8). Mitigasi: object key tidak bisa
ditebak (Keputusan #3), konten editorial tidak pernah menunjuk objek
`pending` (hanya `confirmed`), dan lifecycle job membersihkan objek
`pending` basi (`r2-backup-lifecycle.md` §2, `NEWS_MEDIA_R2_PENDING_TTL_MINUTES`
default 60 menit). Jangan mengimplementasikan kontrol yang mengasumsikan
status Postgres sudah cukup untuk mencegah akses publik — bila
implementor #634 menemukan cara menegakkan ACL per-objek R2 yang nyata,
itu peningkatan yang harus didokumentasikan sebagai penggantian
keputusan ini, bukan diam-diam diasumsikan sudah ada.

### Keputusan kunci #5 — `image/svg+xml` dilarang default

MIME allow-list default (`full-online-r2-architecture.md` §4/§9):
`image/jpeg, image/png, image/webp, image/gif`. SVG sengaja tidak
termasuk karena risiko XSS (script tersemat). Mengizinkannya butuh
pipeline sanitasi khusus dan keputusan terpisah — bukan sekadar
menambah ke allow-list di issue mana pun.

## §632 — Preset `news_portal_full_online_r2` (Selesai)

Implementasi lengkap: `src/modules/news-portal/` (module baru, minimal —
lihat "Kenapa modul baru" di bawah), preset
`news_portal_full_online_r2` di `module-management/domain/module-presets.ts`,
readiness gate di `application/apply-news-portal-preset.ts`,
`.env.example`, `18_configuration_env_reference.md` §News portal,
`scripts/validate-env.ts`, `scripts/security-readiness.ts`. Tiga
rekonsiliasi penamaan berikut **mengikat** issue #633-#649 lanjutan —
jangan investigasi ulang, jangan pakai nama lain dari body issue #632
yang sudah dilihat bertentangan berikut ini.

### Rekonsiliasi #1 — env var R2 pakai `NEWS_MEDIA_R2_*`, BUKAN nama dari body issue #632

Body issue #632 menulis `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`/
`CLOUDFLARE_ACCOUNT_ID`/`R2_NEWS_IMAGE_*` — ini SENGAJA tidak diikuti.
`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` adalah nama PERSIS yang sudah
dipakai `sync-storage` (Issue #436); mengikutinya akan membuat dua fitur
berbagi kredensial yang sama, tepat risiko yang Keputusan kunci #1 (di
atas) dirancang mencegah. Dipakai sebagai gantinya: konvensi
`NEWS_MEDIA_R2_*` PERSIS sesuai `full-online-r2-architecture.md` §4 —
`NEWS_MEDIA_R2_ENABLED`, `_ACCOUNT_ID`, `_ACCESS_KEY_ID`,
`_SECRET_ACCESS_KEY`, `_BUCKET`, `_PUBLIC_BASE_URL`,
`_PRESIGNED_UPLOAD_TTL_SECONDS`, `_MAX_UPLOAD_BYTES`,
`_ALLOWED_MIME_TYPES`, `_PENDING_TTL_MINUTES`. **Catatan**: dokumen §4
TIDAK punya `NEWS_MEDIA_R2_CUSTOM_DOMAIN` terpisah (§11-nya menyatakan
`_PUBLIC_BASE_URL` SUDAH mencakup custom domain) — implementor #633/#634
jangan menambah var `_CUSTOM_DOMAIN` terpisah tanpa keputusan eksplisit
baru. Resolver: `src/modules/news-portal/domain/news-media-r2-config.ts`
(`resolveNewsMediaR2Config`, `findMissingNewsMediaR2Vars`,
`findNewsMediaR2SeparationViolations`, `allowsSvgMimeType`).

### Rekonsiliasi #2 — tidak ada `DEPLOYMENT_PROFILE`/`BLOG_PUBLIC_ROUTE_MODE`/`BLOG_PUBLIC_BASE_PATH` baru

Body issue #632 menulis ketiga var ini seolah baru. Investigasi
membuktikan:

- `DEPLOYMENT_PROFILE` **tidak ada di kode sama sekali** (hanya narasi
  `deployment-profiles.md`) — TIDAK ditambahkan. Konvensi repo ini adalah
  flag independen per-fitur (`R2_ENABLED`, `EMAIL_ENABLED`,
  `VISITOR_ANALYTICS_ENABLED`, dst), bukan satu enum sentral. "Full-online"
  untuk preset ini dinyatakan lewat **dua var baru yang sempit**:
  `NEWS_PORTAL_ENABLED` (master switch preset ini sendiri) dan
  `NEWS_PORTAL_PROFILE` (saat ini hanya nilai valid `full_online_r2`) —
  digabung dengan `NEWS_MEDIA_R2_ENABLED` yang sudah ada. Tiga flag
  independen yang harus SEKALIGUS `true`/cocok, bukan satu master switch.
- `BLOG_PUBLIC_ROUTE_MODE=domain_default` di body issue **bukan** env var
  baru — string `"domain_default"` itu adalah nilai `PUBLIC_ROUTE_MODES`
  yang SUDAH ADA di `blog_content`'s per-tenant module setting
  `publicRouteMode` (`blog-content/application/public-route-settings.ts`,
  Issue #564), sudah default ke situ untuk setiap tenant hari ini. TIDAK
  ditambahkan env var baru untuk ini — preset #632 hanya
  MEREKOMENDASIKAN (dokumentasi, bukan mekanisme baru) tenant
  membiarkannya di default `"domain_default"` dan mengatur kolom
  `route_mode` (`canonical`/`legacy_blog`) milik
  `awcms_mini_tenant_domains` (Issue #557, per-domain, BUKAN per-tenant
  global) ke `"canonical"` lewat API tenant-domain yang sudah ada
  (#562) untuk domain yang dipakai news portal.
- `BLOG_PUBLIC_BASE_PATH` di body issue juga bukan var baru — itu
  `PUBLIC_CANONICAL_BASE_PATH` (Issue #556) yang sudah ada, default
  `/news`. TIDAK ditambahkan var baru.

Detail lengkap ada di komentar header
`src/modules/news-portal/domain/news-portal-preset-readiness.ts`.

### Rekonsiliasi #3 — preset name BUKAN reuse dari preset `news_portal` yang sudah ada

`module-management/domain/module-presets.ts` SUDAH punya preset bernama
`"news_portal"` (Issue #565, epic #555 — "online website + editorial
approval workflow", TIDAK terkait R2/media sama sekali). Preset baru
issue ini bernama **`news_portal_full_online_r2`** — nama yang BERBEDA,
BUKAN rename/merge dari yang sudah ada. Keduanya hidup berdampingan di
`MODULE_PRESETS`; lihat komentar `// NOTE:` tepat di atas entry
`news_portal_full_online_r2` di file itu.

### Kenapa modul baru `news_portal` diregistrasi sekarang (bukan ditunda)

`src/modules/news-portal/module.ts` — module baru, minimal (tanpa
`permissions`/`navigation`/`api`/`settings`/`jobs`/`health`, sama pola
`visitor_analytics` sebelum fitur nyatanya ada). Diregistrasi sekarang
karena preset butuh module key nyata untuk enable/disable (pola sama
`tenant_domain`, Issue #558, register descriptor duluan sebelum
resolver/routes/admin UI). **PENTING**: `dependencies` HANYA
`["tenant_admin", "identity_access"]` — SENGAJA TIDAK menyertakan
`blog_content`/`tenant_domain`/`visitor_analytics` walau hubungan
konseptual "layer di atas" itu benar (dijelaskan di `description`
descriptor). Percobaan pertama menambahkan mereka sebagai
`dependencies` nyata memecahkan 3 test integrasi yang sudah ada
(`blog-content-public-news.integration.test.ts` disable blog_content
gagal 409, `module-presets.integration.test.ts`'s online_website test)
karena setiap tenant baru punya SEMUA module enabled by default —
`news_portal` yang enabled-by-default lalu memblokir disable
blog_content/tenant_domain/visitor_analytics SELAMANYA lewat
`MODULE_REVERSE_DEPENDENCY_ACTIVE`. Implementor #633+ **jangan**
menambahkan dependency itu lagi tanpa memikirkan ulang konsekuensi ini —
urutan enable di dalam SATU preset application sudah cukup dijamin oleh
`enabledModuleKeys`'s urutan + `planEnableOrder`, tidak perlu dependency
permanen di graph.

### Readiness gate — WAJIB lewat `applyNewsPortalFullOnlineR2Preset`

`src/modules/news-portal/application/apply-news-portal-preset.ts`
adalah SATU-SATUNYA jalur yang sah untuk mengaktifkan preset ini — ia
menjalankan `evaluateNewsPortalFullOnlineR2Readiness` (env: harus
`NEWS_PORTAL_ENABLED=true`, `NEWS_PORTAL_PROFILE=full_online_r2`,
`NEWS_MEDIA_R2_*` lengkap DAN terpisah dari `R2_*` sync-storage) sebelum
memanggil `applyModulePreset` generik, dan mengaudit baik penolakan
(`news_portal_preset_activation_rejected`, warning) maupun keberhasilan
(`news_portal_preset_activated`, info) — keduanya via
`recordAuditEvent`, `moduleKey: "news_portal"`. Generic
`applyModulePreset` module-management **tidak tahu apa-apa** soal R2 —
ia tidak boleh diimpor modul domain manapun (lihat header comment
`module-presets.ts` sendiri) — jadi gate ini TIDAK bisa dipindah ke sana;
ia hidup sebagai wrapper terpisah. Belum ada endpoint HTTP yang memanggil
`applyModulePreset`/wrapper ini sama sekali (issue lanjutan/setup wizard).

**PENTING untuk issue lanjutan yang menambah endpoint/setup-wizard
pertama yang memanggil preset ini (temuan reviewer+security-auditor
PR #651, keduanya PASS tapi dengan catatan mengikat)**:

1. `applyModulePreset(tx, tenantId, actor, "news_portal_full_online_r2")`
   dipanggil langsung (melewati wrapper) hari ini **akan** mengaktifkan
   preset TANPA readiness gate dan TANPA audit event — generic engine-nya
   tidak tahu preset ini butuh gate. Inert hari ini (tidak ada caller sama
   sekali), tapi begitu issue lanjutan menambah caller apa pun ke
   `applyModulePreset`, WAJIB memastikan literal string
   `"news_portal_full_online_r2"` hanya pernah lewat
   `applyNewsPortalFullOnlineR2Preset`, tidak pernah dipanggil generic
   function-nya langsung — tambahkan test struktural (pola sama
   `news-portal-no-local-fallback.test.ts`) yang men-grep memastikan ini,
   jangan cuma mengandalkan disiplin code review.
2. `applyModulePreset`/wrapper ini **tidak melakukan ABAC/permission check
   sendiri** (by design, sama pola `enableTenantModule`/
   `disableTenantModule` — tanggung jawab pemanggil). Issue pertama yang
   menambah endpoint HTTP/halaman admin untuk mengaktifkan preset ini
   WAJIB menambah `authorizeInTransaction` (skill `awcms-mini-abac-guard`)
   dan mendaftarkan endpoint itu di OpenAPI — jangan asumsikan wrapper ini
   "sudah aman" karena sudah ada readiness+audit, itu bukan pengganti
   lapisan otorisasi.
3. Readiness/audit gate ini bersifat **global per-deployment** (baca env
   var, bukan state module per-tenant) — ia tidak memverifikasi bahwa
   `blog_content`/`tenant_domain`/`visitor_analytics` masih benar-benar
   `tenantEnabled=true` untuk tenant yang preset-nya sedang aktif (lihat
   §"Kenapa modul baru... dependencies HANYA..." di atas — ini sengaja,
   supaya `news_portal` bisa jadi leaf yang bisa di-disable). Konsekuensi:
   seorang admin tenant bisa mengaktifkan preset ini lalu belakangan
   men-disable `blog_content` untuk tenant itu tanpa terblokir apa pun,
   dan readiness check tetap melaporkan "ready" walau tenant itu
   fungsionalnya tidak bisa lagi menyajikan berita. Begitu #633/#634
   menambah API/health nyata yang dikonsumsi operator/end-user, tambahkan
   pemeriksaan tenant-scoped terpisah (bukan cuma env-level) sebelum
   mengklaim tenant tersebut "ready".

### Tidak ada flag "local fallback" sungguhan

Acceptance criteria issue minta "readiness gagal bila local upload
diaktifkan" — TIDAK diimplementasikan sebagai flag runtime
(`NEWS_MEDIA_LOCAL_FALLBACK_ENABLED` dkk) karena mode ini secara
struktural tidak punya jalur local-upload untuk didisable. Sebagai
gantinya: `tests/unit/news-portal-no-local-fallback.test.ts` — test
struktural yang grep seluruh `src/modules/news-portal/**` mencari
`Bun.write`/`fs.writeFile`/`LOCAL_STORAGE_PATH`/dst, gagal loud begitu
PR manapun (#634 khususnya) menambah jalur itu.

### File yang dibuat/diubah (referensi cepat)

- `src/modules/news-portal/module.ts`, `domain/news-media-r2-config.ts`,
  `domain/news-portal-preset-readiness.ts`,
  `application/apply-news-portal-preset.ts`.
- `src/modules/index.ts`,
  `src/modules/module-management/domain/module-presets.ts` (preset entry
  - `ModulePresetName` union).
- `scripts/validate-env.ts`
  (`checkNewsPortalProfileConfig`/`checkNewsMediaR2Config`/
  `checkNewsMediaR2SeparationFromSyncR2`/`isHttpsAbsoluteUrl`),
  `scripts/security-readiness.ts`
  (`checkNewsPortalFullOnlineR2PresetReady`/`checkNewsMediaR2SvgNotAllowed`).
- `.env.example`, `18_configuration_env_reference.md` §News portal,
  `full-online-r2-architecture.md` §4 (status diperbarui),
  `r2-security-checklist.md` §7 (status diperbarui — sebagian besar
  kontrak yang tadinya dijadwalkan #635 sudah terpenuhi #632; sisa untuk
  #633/#634/#635 hanya check yang butuh tabel registry/endpoint upload
  nyata).
- Test: `tests/unit/news-media-r2-config.test.ts`,
  `tests/unit/news-portal-preset-readiness.test.ts`,
  `tests/unit/news-portal-no-local-fallback.test.ts`,
  `tests/modules/news-portal-module.test.ts`,
  `tests/integration/news-portal-preset.integration.test.ts`; diperbarui:
  `tests/unit/module-presets.test.ts`,
  `tests/integration/module-presets.integration.test.ts`,
  `tests/foundation.test.ts` (module count 13→14).

## §633 — Media object registry (Selesai)

Implementasi lengkap: migration
`sql/041_awcms_mini_news_media_object_registry_schema.sql`, domain
`src/modules/news-portal/domain/news-media-object-key.ts` (object key
build/validate, trusted public URL) + `domain/news-media-permissions.ts`
(permission constants for #634, not wired yet), application
`application/news-media-object-directory.ts` (full CRUD + lifecycle).
Two rekonsiliasi below **mengikat** issue #634+ lanjutan — jangan
investigasi ulang.

### Rekonsiliasi #1 — nama tabel `awcms_mini_news_media_objects`, BUKAN `awcms_mini_media_objects` dari body issue #633

Body issue #633 menulis `awcms_mini_media_objects`. TIDAK diikuti — nama
ini sudah dipilih lebih dulu oleh
`full-online-r2-architecture.md` §5 ("rencana untuk Issue #633", ditulis
saat Issue #631, sebelum #633 mulai) yang merupakan sumber kebenaran
epic ini per header skill ini sendiri. Selain itu, nama generik
`awcms_mini_media_objects` terbaca seolah "media library umum aplikasi"
padahal tabel ini sengaja SEMPIT — hard-`CHECK`-constrained ke
`storage_driver = 'cloudflare_r2'` dan hanya relevan saat preset
full-online-R2-only (#632) aktif. Nama generik berisiko bentrok makna
dengan sistem media benar-benar umum di masa depan (avatar, gambar
produk, dll) yang mungkin ingin nama tanpa prefix itu untuk dirinya
sendiri. Detail lengkap ada di migration 041's header comment.

### Rekonsiliasi #2 — status enum 7-state, elaborasi dari sketsa 4-state §5 semula

`full-online-r2-architecture.md` §5 (ditulis sebelum #633) mensketsa
`pending|confirmed|orphaned|deleted`. Migration 041 memakai 7-state dari
body issue #633 sendiri:
`pending_upload|uploaded|verified|attached|orphaned|deleted|failed` —
ini ELABORASI, bukan kontradiksi: `pending_upload` = `pending`;
`uploaded`+`verified` memecah `confirmed` tunggal jadi "R2 PUT sukses"
vs "MIME/checksum/dimensi sudah diverifikasi server" (cocok dengan alur
dua-langkah Jalur A di §7 — #634 akan butuh kedua state ini untuk
merepresentasikan celah antara HEAD sukses dan verifikasi konten
penuh); `attached` baru (media benar-benar dirujuk resource pemilik,
bukan sekadar verified-tapi-menganggur); `orphaned`/`deleted` tidak
berubah; `failed` baru. **Soft delete (`deleted_at`) ortogonal terhadap
`status`** (pola sama `awcms_mini_blog_posts`) — hapus/restore tidak
pernah menulis ulang `status`.

### `owner_resource_type`/`owner_resource_id` — polymorphic reference generik, TANPA FK ke `blog_content`

Sengaja pasangan `(text, uuid)` longgar tanpa foreign key, mengikuti POLA
yang sama (BUKAN tipe kolom identik — koreksi post-review PR #652) dengan
idiom yang SUDAH ADA di `awcms_mini_audit_events.resource_type`/
`resource_id` (migration 011, `resource_id text`) dan
`awcms_mini_workflow_instances.resource_type`/`resource_id` (migration
012, `resource_id text` juga) — BUKAN FK ke `awcms_mini_blog_posts` atau
tabel spesifik lain. Tabel ini memakai `owner_resource_id uuid` (bukan
`text`) plus `CHECK` enum untuk `owner_resource_type` — varian yang lebih
ketat dari idiom yang sama, bukan replika persis. Ini memungkinkan satu
registry melayani semua konsumen di objective (blog post/page, homepage
section, gallery item, ad, video thumbnail, SEO image) tanpa FK
per-konsumen, dan tanpa migration ini bergantung sama sekali pada skema
`blog_content` — cocok dengan `news_portal`'s `module.ts` yang sengaja
TIDAK punya hard dependency ke `blog_content` (lihat §"Kenapa modul
baru... dependencies HANYA..." di atas). Kedua kolom `NULL` sampai baris
mencapai `status='attached'` (ditegakkan `CHECK` di DB DAN oleh
`attachNewsMediaObject` yang hanya menerima transisi dari
`status='verified'`).

**WAJIB untuk #634 (temuan security-auditor PR #652, Medium, laten —
tidak ada endpoint yang bisa dieksploitasi hari ini, tapi mengikat
sebelum #634 merilis endpoint attach/purge nyata):**

1. `attachNewsMediaObject` **tidak pernah** memverifikasi `owner_resource_id`
   benar-benar ada DAN milik tenant yang sama — karena tidak ada FK, fungsi
   ini akan selalu sukses meng-attach ke UUID apa pun yang diberikan
   pemanggil, termasuk UUID resource milik tenant lain atau yang tidak
   pernah ada sama sekali. Sebelum endpoint attach di #634 dirilis, WAJIB
   menambah query verifikasi (`SELECT 1 FROM <tabel pemilik> WHERE id = $1
AND tenant_id = $2`) di dalam transaksi tenant-scoped yang sama SEBELUM
   memanggil `attachNewsMediaObject`, plus test integrasi cross-tenant
   attach yang eksplisit menegaskan penolakan.
2. Tidak ada mekanisme retention/legal-hold pada `purgeNewsMediaObject`/
   `restoreNewsMediaObject` sama sekali (gap sistemik, sama seperti
   `blog-content`'s `purgeBlogPost` — bukan regresi baru PR ini). Karena
   media R2 punya IR khusus (`r2-incident-response.md`) yang mengandalkan
   retensi/audit forensik, #634 (atau issue retention terpisah) WAJIB
   menentukan mekanisme yang memblokir purge pada objek yang masih dalam
   periode retensi wajib sebelum endpoint purge nyata dirilis.

### Object key & public URL — server-generated, divalidasi 3 lapis

`buildNewsMediaObjectKey`/`isValidNewsMediaObjectKey`
(`domain/news-media-object-key.ts`) menerapkan §6 persis:
`news-media/{tenantId}/{yyyy}/{mm}/{uuid}.{ext}`, `{ext}` diturunkan
dari `mime_type` tervalidasi (map eksplisit 4 tipe default, BUKAN
`mime.split("/")[1]` generik — mime type di luar map melempar error
loud, bukan menebak ekstensi). Divalidasi 3 lapis: (1) application layer
saat generate, (2) `CHECK` constraint di Postgres sendiri
(`awcms_mini_news_media_objects_object_key_format_check`,
mereferensi kolom `tenant_id` baris yang sama — pertahanan bila ada
INSERT langsung yang melewati helper), (3) unit test structural.
`buildNewsMediaPublicUrl` membangun public URL HANYA dari
`NEWS_MEDIA_R2_PUBLIC_BASE_URL` tepercaya (config #632) + object key
server-generated — menolak base URL non-https/malformed
(`UntrustedNewsMediaPublicBaseUrlError`), tidak pernah menerima input
client.

### Permission key untuk #634 — disiapkan sebagai konstanta, BELUM dideklarasikan di `module.ts`

`domain/news-media-permissions.ts` mengekspor
`NEWS_MEDIA_PERMISSIONS.{create,read,verify,attach,detach,delete,restore,purge}`
(nilai `news_portal.media.<action>`) — dokumentasi/konstanta MURNI,
belum disinkronkan ke `awcms_mini_permissions` (tidak ada baris DB, tidak
ada perubahan `module.ts`'s `permissions` array). Alasan: `news_portal`
sengaja meninggalkan `permissions` undeclared sampai endpoint nyata ada
(pola sama `visitor_analytics`, lihat §"Kenapa modul baru..." di atas) —
#633 hanya menambah domain/application helper, belum ada HTTP endpoint
yang menegakkannya. **Wajib untuk #634**: pakai persis konstanta ini
(jangan buat nama baru) saat mendeklarasikan `module.ts`'s `permissions`
array dan memanggil `authorizeInTransaction` (skill
`awcms-mini-abac-guard`).

### File yang dibuat/diubah (referensi cepat)

- `sql/041_awcms_mini_news_media_object_registry_schema.sql`.
- `src/modules/news-portal/domain/news-media-object-key.ts`,
  `domain/news-media-permissions.ts`,
  `application/news-media-object-directory.ts`.
- Test: `tests/unit/news-media-object-key.test.ts`,
  `tests/unit/news-media-permissions.test.ts`,
  `tests/integration/news-media-object-registry.integration.test.ts`;
  diperbarui: `tests/foundation.test.ts` (migration list).
- Docs: `full-online-r2-architecture.md` §5/§6/§16 (status diperbarui),
  `04_erd_data_dictionary.md` (§News Portal baru ditambah).

## §634 — Direct-to-R2 presigned upload flow (Selesai)

Implementasi lengkap Jalur A (`r2-upload-sop.md` §2) — tiga endpoint:
`POST /api/v1/media/news-images/upload-sessions` (create),
`POST .../{id}/finalize`, `POST .../{id}/cancel`. Jalur B (server-
streaming, §3) **tidak** diimplementasikan — di luar cakupan issue ini,
Jalur A sudah mencukupi acceptance criteria.

### KONFIRMASI KRUSIAL — finalize melakukan GET penuh + magic-byte sniffing + checksum server-side, BUKAN HEAD-only

Body issue #634 di GitHub menulis "Server verifies object existence and
metadata via R2 HEAD/metadata" — kalimat itu SENGAJA TIDAK diikuti
karena sudah usang dibanding keputusan arsitektur pasca-review (temuan
Critical security-auditor #631) di `full-online-r2-architecture.md` §9
dan `r2-upload-sop.md` §2 langkah 5. Implementasi nyata:
`src/modules/news-portal/application/news-media-r2-verification.ts`'s
`verifyNewsMediaR2Object` — urutan PERSIS: (1) `client.headObject()`
(cek cepat eksistensi + `Content-Length` real, short-circuit sebelum
`GET` kalau objek tidak ada atau kelebihan ukuran — hemat bandwidth
sesuai §9 poin 1), (2) `client.getObject()` = `S3File.arrayBuffer()`
(GET PENUH, bukan ranged/partial), (3) `sniffNewsMediaMimeType(bytes)`
(`domain/news-media-mime-sniffer.ts`, magic-byte allow-list JPEG/PNG/
WebP/GIF — payload apa pun yang tidak cocok, termasuk HTML/JS berkedok
`.jpg`, sniff ke `undefined`), (4) `Bun.CryptoHasher("sha256")` dihitung
dari BYTE YANG SAMA yang dibaca di langkah 2 (bukan hash ulang beberapa
byte pertama), (5) `decideNewsMediaFinalizeOutcome`
(`domain/news-media-finalize-decision.ts`) — keputusan MIME/konten
SELALU dari hasil sniffing; checksum klaim client (opsional, di body
finalize request, BUKAN create — lihat Rekonsiliasi checksum di bawah)
HANYA dibandingkan sebagai deteksi korupsi transport, tidak pernah
menggantikan sniffing. `HEAD` (langkah 1) TIDAK PERNAH sendirian
menaikkan status — bila objek tidak ada atau kelebihan ukuran, request
ditolak SEBELUM `GET` sama sekali dipanggil (defense-in-depth, tapi
tetap lewat urutan HEAD-lalu-GET, bukan HEAD-saja).

Route (`pages/api/v1/media/news-images/upload-sessions/[id]/finalize.ts`)
hanya parsing/validasi HTTP tipis — logika nyata ada di
`application/news-media-finalize-upload-session.ts`'s
`finalizeNewsMediaUploadSession` (dua transaksi `withTenant` terpisah
mengapit panggilan R2 di tengah, ADR-0006 — precheck row/TTL/idempotency
di tx pertama, commit, panggil R2 di luar transaksi, lalu tx kedua
menulis hasil `verified`/`failed`). Test yang membuktikan HTML/JS
berkedok gambar ditolak:
`tests/integration/news-media-upload-session-api.integration.test.ts`'s
"HTML/JS payload disguised as a .jpg (Issue #631 exploit scenario) is
REJECTED" — meng-upload byte HTML/`<script>` sungguhan ke objek R2 palsu
(fake in-memory S3 server, `Bun.serve`, path-style `/{bucket}/{key}`,
dikonfirmasi empiris cocok dengan request nyata `Bun.S3Client`) yang
key/claimed-mime-type-nya bilang `image/jpeg`, lalu memastikan
`finalize` mengembalikan `422 UPLOAD_VERIFICATION_FAILED` dengan
`reason: "mime_not_recognized"`, baris tetap `failed` (bukan
`verified`), dan audit event `news_media.object.finalize_rejected`
tercatat. Test serupa di level unit (tanpa DB):
`tests/unit/news-media-mime-sniffer.test.ts`,
`tests/unit/news-media-finalize-decision.test.ts`,
`tests/unit/news-media-r2-verification.test.ts`.

### Kenapa test R2-dependent tidak lewat route HTTP langsung

Route Astro punya signature tetap `(context) => Response`, tidak ada
seam untuk inject R2 client palsu ke test. `finalizeNewsMediaUploadSession`
diekstrak ke `application/news-media-finalize-upload-session.ts` persis
supaya punya `deps.createR2Client` yang bisa di-override test (pola sama
`dispatchObjectSyncQueue`'s `resolveUploader` option di `sync-storage`,
diterapkan satu layer lebih dalam karena di situlah seam-nya nyata ada).
Skenario yang TIDAK butuh R2 nyata (auth/tenant/ABAC, validasi shape,
idempotency-required, not-found, wrong-status, expired-session — semua
diputuskan dari state DB semata sebelum R2 dipanggil sama sekali) tetap
di-test lewat route asli (`invoke()`). Skenario yang butuh R2 (accept,
object-not-found, mime-mismatch/exploit, checksum-mismatch) memanggil
`finalizeNewsMediaUploadSession` langsung dengan `Bun.S3Client` sungguhan
menunjuk ke fake server lokal.

### Rekonsiliasi permission — pakai `news_portal.media.*` dari #633, BUKAN `media_objects.news_images.*` dari body issue #634

Body issue #634 menyarankan
`media_objects.news_images.{upload,read,attach,delete}`. TIDAK diikuti —
`news-media-permissions.ts` (#633) sudah membekukan
`news_portal.media.{create,read,verify,attach,detach,delete,restore,purge}`
lebih dulu, dan file itu sendiri sudah menulis eksplisit "#634 WAJIB
pakai persis konstanta ini". Verifikasi dilakukan: tidak ada modul lain
di repo ini bernama `media_objects` atau pattern permission generik
serupa (`grep` tidak menemukan apa pun) — jadi tidak ada konflik nyata
untuk direkonsiliasi selain penamaan itu sendiri. Pemetaan endpoint →
permission: create session → `news_portal.media.create` (action
`"create"`, sudah ada di `AccessAction` union); finalize → `news_portal.media.verify`
(action `"verify"`, sudah ada); cancel → permission BARU
`news_portal.media.cancel` (action `"cancel"`, sudah ada duluan di
`AccessAction` union untuk keperluan sync/POS — direuse, bukan
ditambah). `cancel` ditambahkan ke `NEWS_MEDIA_PERMISSIONS` karena #633
tidak pernah menganggarkan konsep "upload session" sama sekali (registry
saat itu hanya berpikir dalam status lifecycle objek, bukan sesi
presigned) — ini ekstensi aditif, bukan kontradiksi terhadap set #633.
Migration `042_awcms_mini_news_media_permissions.sql` menyeed sembilan
baris (delapan dari #633 + `cancel` baru) ke `awcms_mini_permissions`,
dan `module.ts`'s `permissions` array (BARU dideklarasikan issue ini,
sebelumnya sengaja `undefined`) menyalin PERSIS sembilan action yang
sama — diverifikasi test
(`tests/modules/news-portal-module.test.ts`'s "every declared
permission's activityCode/action reproduces exactly one
NEWS_MEDIA_PERMISSIONS constant").

### Rekonsiliasi checksum klaim client — di body FINALIZE, bukan di body CREATE seperti tersirat SOP

`r2-upload-sop.md` §2 langkah 5 menulis "checksum yang diklaim di
langkah 1" (create) dibandingkan di langkah finalize — tapi migration
041 (#633, schema BEKU, tidak diubah issue ini) hanya punya SATU kolom
`checksum_sha256`, diisi dari nilai HASIL PERHITUNGAN SERVER saat
`markNewsMediaObjectVerified` (bukan `markNewsMediaObjectUploaded` —
sejak PR #653 re-review, klaim atomik `pending_upload->uploaded` terjadi
SEBELUM GET nyata, lihat subbagian di bawah), bukan dari klaim client. Tidak ada kolom
untuk menyimpan klaim client terpisah dari nilai final itu. Solusi:
`checksumSha256` opsional diterima di BODY FINALIZE (bukan create) —
fungsional setara (klien Jalur A memegang byte yang sama persis untuk
kedua request, tidak ada kerugian menyertakan ulang di request kedua)
tanpa perlu migration baru. `CreateNewsMediaUploadSessionRequest` di
OpenAPI TIDAK punya field checksum sama sekali;
`FinalizeNewsMediaUploadSessionRequest` punya `checksumSha256` opsional.

### PR #653 re-review — dua temuan security-auditor ditutup, jangan diperkenalkan ulang

PR #653 (issue ini) melalui SATU putaran review setelah commit awal — reviewer

- security-auditor menemukan dua bug nyata pada implementasi finalize:

1. **Critical (TOCTOU size-cap)**: `getObject` semula memanggil
   `file.arrayBuffer()` — buffer SELURUH objek ke memori SEBELUM ukurannya
   dicek. Presigned PUT URL bisa dipakai ulang, jadi penyerang bisa
   menimpa objek dengan file raksasa DI ANTARA `headObject` (yang
   melaporkan ukuran kecil) dan `getObject` (yang membaca byte
   sesungguhnya) — proses bisa OOM. **Fix**: `getObject(objectKey,
maxBytes)` sekarang membaca via `readCappedStream` (helper diekspor
   dari `news-media-r2-client.ts`, bisa diuji langsung terhadap
   `ReadableStream` sintetis) yang membatalkan (`reader.cancel()`) baca
   PERSIS saat total terbaca melebihi `maxBytes`, TANPA pernah
   mengakumulasi lebih dari `maxBytes`. `verifyNewsMediaR2Object`
   memperlakukan `get.sizeExceeded` sebagai OTORITATIF, mengalahkan
   `head.sizeBytes` yang mungkin basi.
2. **High (concurrent-finalize cost amplification)**: N panggilan
   `finalize` konkuren dengan `Idempotency-Key` BERBEDA terhadap
   `objectId` yang SAMA dulunya masing-masing mencapai
   `verifyNewsMediaR2Object` sendiri-sendiri (masing-masing bayar
   `HEAD`+`GET` sendiri). **Fix**: `markNewsMediaObjectUploaded(tx,
tenantId, objectId)` (kini `input` opsional, `COALESCE` di SQL) dipakai
   sebagai KLAIM ATOMIK (`pending_upload -> uploaded`) DI DALAM transaksi
   precheck, SEBELUM panggilan R2 apa pun — `WHERE status =
'pending_upload'`-nya adalah primitif mutual-exclusion (Postgres
   menyerialkan `UPDATE` konkuren pada baris yang sama). Pemenang lanjut
   ke R2; yang kalah dapat `409` murah, TANPA pernah memanggil R2.

**Konsekuensi desain yang WAJIB dipertahankan issue lanjutan**: klaim
`uploaded` kini dipegang lintas satu transaksi DB TERPISAH (bukan lagi
satu transaksi yang sama dengan resolusi `verified`/`failed`) selama
panggilan R2 nyata berjalan. Ini butuh jalur revert eksplisit
(`revertNewsMediaObjectUploadClaim`, `uploaded -> pending_upload`) —
dipanggil untuk (a) outcome `provider_error` yang sudah ditangani, DAN
(b) EXCEPTION TAK TERDUGA apa pun dari `verifyNewsMediaR2Object` atau
transaksi resolusi (bug, OOM, dll) — lihat `try/catch` di
`finalizeNewsMediaUploadSession`. Tanpa (b), crash di antara commit klaim
dan resolusi meninggalkan baris macet PERMANEN di `uploaded` (baik
`finalize` maupun `cancel` mensyaratkan `pending_upload`) — TIDAK ADA
reaper/job pembersihan untuk baris `uploaded` basi saat ini (beda dari
`pending_upload`, yang punya TTL check). Jangan hapus `try/catch` ini
demi "menyederhanakan" tanpa menambahkan job rekonsiliasi sepadan
terlebih dahulu.

Perbaikan idempotency terkait: outcome `rejected` (422) kini JUGA
menyimpan idempotency record-nya sendiri (`saveIdempotencyRecord` dengan
status 422) — sebelumnya hanya jalur sukses (200) yang disimpan, jadi
retry dengan `Idempotency-Key` yang sama setelah rejection akan jatuh ke
guard status (`row.status !== "pending_upload"`) dan dapat respons
BERBEDA ("Cannot finalize... status failed"), melanggar kontrak "key +
request sama -> replay identik".

Test yang membuktikan kedua fix + regresi: `tests/unit/news-media-r2-client.test.ts`
(`readCappedStream` langsung + skenario objek ditukar via loopback
server berbadan besar-tapi-terhingga — JANGAN pakai `pull()` yang
`enqueue()` tanpa henti/tanpa `close()`, itu bug desain test yang
menggantung runtime Bun bahkan tanpa `Bun.S3Client` sama sekali, bukan
properti kode yang diuji), `tests/unit/news-media-r2-verification.test.ts`
(`sizeExceeded: true` otoritatif meski `HEAD` klaim ukuran dalam batas),
`tests/integration/news-media-object-registry.integration.test.ts`
(`markNewsMediaObjectUploaded` tanpa argumen sebagai klaim + guard
kedua-klaim-kalah, `revertNewsMediaObjectUploadClaim` transisi balik +
no-op di status lain), `tests/integration/news-media-upload-session-api.integration.test.ts`
(provider_error → 502 → klaim direvert → retry key baru sukses; 422
di-replay identik dengan key sama, bukan jatuh ke guard status).

Residual (dicatat security-auditor, BUKAN blocker go-live, untuk issue
lanjutan): `withTimeout` (`src/lib/integration/timeout.ts`) tidak
membatalkan stream yang sedang dibaca saat timeout tercapai — pembacaan
`readCappedStream` di background tetap berjalan sampai selesai/di-GC
(bounded ke `maxBytes`, jadi bukan lagi unbounded, tapi belum benar-benar
"dihentikan"); dan belum ada test konkurensi race NYATA (dua `finalize`
paralel sungguhan) — argumen korektnya saat ini bertumpu pada inspeksi
semantik `READ COMMITTED` Postgres di `withTenant`, bukan test
merah/hijau.

### File yang dibuat/diubah (referensi cepat)

- `sql/042_awcms_mini_news_media_permissions.sql`.
- `src/modules/news-portal/domain/news-media-mime-sniffer.ts`,
  `domain/news-media-finalize-decision.ts`,
  `domain/news-media-upload-session-validation.ts`; diperbarui:
  `domain/news-media-permissions.ts` (tambah `cancel`).
- `src/modules/news-portal/infrastructure/news-media-r2-client.ts`
  (`Bun.S3Client` wrapper: presign/HEAD/GET, circuit breaker
  `"news-media-r2"`, timeout — pola sama `object-storage-uploader.ts`).
- `src/modules/news-portal/application/news-media-r2-verification.ts`
  (orkestrasi HEAD→GET→sniff→checksum→decision, tanpa `tx`, murni R2 +
  domain), `application/news-media-finalize-upload-session.ts`
  (orkestrasi finalize penuh: precheck tx → R2 verify → outcome tx,
  `deps.createR2Client` injectable untuk test).
- `src/pages/api/v1/media/news-images/upload-sessions/index.ts` (create),
  `.../[id]/finalize.ts`, `.../[id]/cancel.ts` — route tipis.
- Diperbarui: `src/modules/news-portal/module.ts` (`permissions`, `api`
  baru dideklarasikan, versi 0.1.0→0.2.0).
- `openapi/awcms-mini-public-api.openapi.yaml` (tag "News Media", tiga
  path, lima schema baru).
- Test: `tests/unit/news-media-mime-sniffer.test.ts`,
  `tests/unit/news-media-finalize-decision.test.ts`,
  `tests/unit/news-media-upload-session-validation.test.ts`,
  `tests/unit/news-media-r2-client.test.ts`,
  `tests/unit/news-media-r2-verification.test.ts`,
  `tests/integration/news-media-upload-session-api.integration.test.ts`;
  diperbarui: `tests/unit/news-media-permissions.test.ts` (9 keys,
  module.ts kini deklarasikan permissions),
  `tests/modules/news-portal-module.test.ts`,
  `tests/unit/news-portal-no-local-fallback.test.ts` (extend scan ke
  `src/pages/api/v1/media/news-images`), `tests/foundation.test.ts`
  (migration list 042).
- Changeset: `.changeset/news-media-presigned-upload-issue-634.md`.

### Belum/di luar cakupan issue ini (untuk issue lanjutan)

- Jalur B (server-streaming) — tidak diimplementasikan.
- Job pembersihan objek R2 `failed`/`orphaned`/`pending` kedaluwarsa —
  finalize hanya MENANDAI baris `failed` dan mengaudit, TIDAK
  menghapus objek R2 sungguhan (`r2-backup-lifecycle.md`'s lifecycle
  job). **Update #635**: TERNYATA bukan scope #635 juga (judul issue itu
  "readiness checks", bukan "cleanup job") — #635 hanya menambah
  `checkNewsMediaR2NoStalePendingObjects` yang MELAPORKAN backlog
  sebagai warning, tidak menghapus. Job penghapusan nyata masih belum
  ada issue yang mengklaimnya — lihat §635 di bawah.
- Endpoint `attach` nyata (permission `news_portal.media.attach` sudah
  di-declare, tapi belum ada route yang memanggilnya) — verifikasi
  `owner_resource_id` exist+tenant-match (temuan Medium security-auditor
  PR #652, dicatat di §633 di atas) masih WAJIB ditegakkan issue yang
  menambah endpoint attach nyata, BUKAN issue ini.
- Retention/legal-hold pada purge — masih gap sistemik yang sama
  (dicatat di §633), tidak disentuh issue ini (tidak ada endpoint purge
  nyata yang dirilis di sini).

## §635 — R2 image delivery readiness checks (Selesai)

### Rekonsiliasi — body issue #635 pakai nama var placeholder, BUKAN `NEWS_MEDIA_R2_*` nyata

Body issue #635 menulis `R2_NEWS_IMAGE_*`, `NEWS_IMAGE_STORAGE_POLICY`,
`FILE_STORAGE_DRIVER`, `LOCAL_FILE_UPLOADS_ENABLED`,
`LOCAL_MEDIA_STORAGE_ENABLED` — TIDAK satu pun dari var ini ada di kode
(sama pola rekonsiliasi #632/#633/#634 di atas). Var nyata tetap
`NEWS_MEDIA_R2_*` (§4 architecture doc, ditegakkan sejak #632). Tidak
ada `LOCAL_FILE_UPLOADS_ENABLED`/`LOCAL_MEDIA_STORAGE_ENABLED`/
`FILE_STORAGE_DRIVER` karena mode ini secara struktural tidak punya
jalur upload lokal untuk didisable (Keputusan kunci #2, `Tidak ada flag
"local fallback" sungguhan` di §632 di atas — masih berlaku sama persis
di sini, TIDAK diimplementasikan ulang sebagai flag baru).

### Scope nyata yang dikerjakan — sebagian besar acceptance criteria issue SUDAH terpenuhi #632, sisanya di sini

`r2-security-checklist.md` §7 (ditulis saat #631/#632) sudah menandai
sebagian besar acceptance criteria issue #635 selesai lebih awal lewat
#632 (`checkNewsPortalProfileConfig`, `checkNewsMediaR2Config`,
`checkNewsMediaR2SeparationFromSyncR2`,
`checkNewsPortalFullOnlineR2PresetReady`,
`checkNewsMediaR2SvgNotAllowed`) DAN menandai eksplisit apa yang
"masih terbuka untuk #635". Issue ini menambah EMPAT check baru yang
menutup sisanya:

- **`checkNewsMediaR2AllowedMimeTypesKnown`** (`config:validate`,
  **fail**) — `NEWS_MEDIA_R2_ALLOWED_MIME_TYPES` wajib seluruhnya berada
  di `NEWS_MEDIA_R2_KNOWN_MIME_TYPES` (domain
  `news-media-r2-config.ts`: empat tipe raster yang bisa disniff
  `news-media-mime-sniffer.ts` PLUS `image/svg+xml` — svg tetap "known"
  karena punya jalur override yang sah lewat
  `checkNewsMediaR2SvgNotAllowed`, bukan "unknown/unsafe"). Entri lain
  (`text/html`, `application/octet-stream`, typo) tidak pernah bisa
  lolos sniffing di `finalize` — ini murni misconfiguration, jadi
  **fail** hard, bukan warning.
- **`checkNewsMediaR2PresignedTtlUpperBound`** (`config:validate`,
  **fail**) — `NEWS_MEDIA_R2_PRESIGNED_UPLOAD_TTL_SECONDS` tidak boleh
  melebihi `NEWS_MEDIA_R2_MAX_PRESIGNED_UPLOAD_TTL_SECONDS` (konstanta
  baru, 3600 detik/1 jam) — presigned PUT URL bisa dipakai ulang selama
  TTL berlaku (architecture doc §8), jadi TTL berlebihan melemahkan
  mitigasi itu. Angka 3600 dipilih sebagai batas atas yang longgar tapi
  tetap bermakna — bukan dari acceptance criteria issue (yang tidak
  memberi angka), didokumentasikan sebagai keputusan implementor.
- **`checkNewsMediaR2PublicBaseUrlProductionSafe`** (`security:readiness`,
  **critical**) — PERTAMA kalinya keluarga check ini (config:validate/
  security:readiness untuk news-media R2) bercabang pada `APP_ENV`. Saat
  `APP_ENV=production` DAN `NEWS_MEDIA_R2_ENABLED=true`: menolak host
  `*.r2.dev` bawaan Cloudflare (regex `\.r2\.dev$` pada hostname, bukan
  substring match — hindari false-positive terhadap domain kustom yang
  kebetulan mengandung string itu di path) dan host loopback
  (`localhost`/`127.0.0.1`). Non-production SELALU **pass** — issue
  eksplisit minta "non-production/dev mode boleh didokumentasikan
  terpisah tanpa melemahkan default production", jadi non-production
  tidak pernah gagal di sini walau URL-nya `r2.dev`. Ini check
  **critical** PERTAMA yang membaca `APP_ENV` di keluarga
  `security-readiness.ts` — precedent untuk implementor lanjutan yang
  butuh perilaku berbeda production vs non-production.
- **`checkNewsMediaR2NoStalePendingObjects`** (`security:readiness`,
  **warning**, ASYNC + butuh `DATABASE_URL`) — inilah yang
  `r2-security-checklist.md` §7 versi lama tandai eksplisit "masih
  terbuka untuk #635": check yang menyentuh TABEL REGISTRY itu sendiri,
  bukan cuma shape env var. Scan lintas SEMUA tenant aktif untuk baris
  `pending_upload` yang sudah lewat `NEWS_MEDIA_R2_PENDING_TTL_MINUTES`
  — pola IDENTIK `checkSsoBreakGlassReady` (Issue #593): query
  `awcms_mini_tenants` dulu, lalu satu `sql.begin` per tenant dengan
  `SET LOCAL app.current_tenant_id`, supaya check ini tetap benar lewat
  RLS terlepas dari privilege `DATABASE_URL` yang dipakai
  `security:readiness`. **Severity `warning`, bukan `critical`** —
  backlog objek `pending_upload` basi adalah gap housekeeping (job
  pembersihan §2 memang belum ada sama sekali di kode ini — lihat
  paragraf di bawah), bukan bukti eksploitasi aktif.

**PENTING — apa yang TIDAK dikerjakan issue ini (sengaja, per
`r2-backup-lifecycle.md`)**:

1. **Job pembersihan objek `pending_upload` basi yang NYATA** (§2 —
   menghapus objek R2 + baris metadata). `checkNewsMediaR2NoStalePendingObjects`
   di atas hanya MELAPORKAN backlog, TIDAK menghapus apa pun. Job nyata
   masih murni scope operasional/lifecycle yang belum
   diimplementasikan siapa pun sampai sekarang (§2 sendiri menulis
   "kemungkinan bagian dari #633/#634" — ternyata tidak, dan #635 juga
   bukan tempatnya karena judul issue ini adalah "readiness checks",
   bukan "cleanup job").
2. **Deteksi objek `confirmed` `orphaned`** (§4) — SENGAJA tidak
   diimplementasikan di issue ini karena bergantung pada daftar
   LENGKAP titik referensi (`blog_content` featured image, block
   `gallery`/`video_news`, `ad.imageUrl`, SEO share image) yang baru ada
   setelah #636-#640/#642/#649 selesai (§4 eksplisit: "daftar titik
   referensi ini wajib diperbarui setiap kali issue lanjutan menambah
   surface baru"). Mengimplementasikan deteksi orphan SEKARANG — sebelum
   `blog_content` bahkan mewajibkan referensi R2 (#636) — akan salah
   menandai SEMUA objek `confirmed`/`verified` sebagai orphan (belum ada
   satu pun surface yang benar-benar mereferensikannya), persis
   kesalahan "jangan bangun ke depan sebelum dependency siap" yang
   epic ini berulang kali diperingatkan hindari.

Implementor issue yang akhirnya menambah salah satu dari dua hal di atas
**wajib** memperbarui `r2-security-checklist.md` §7 dan bagian ini lagi.

### PR #665 re-review — hostname bypass di check `checkNewsMediaR2PublicBaseUrlProductionSafe`

Reviewer DAN security-auditor independen sama-sama menemukan
`findNewsMediaR2PublicBaseUrlProductionUnsafeReason` (dan helper
`isLoopbackHost`/`isR2DevHost`) bisa dilewati:

1. **Trailing-dot FQDN** — `https://pub-abc123.r2.dev./x` punya
   `hostname` literal `"pub-abc123.r2.dev."` (titik root DNS
   dipertahankan `new URL(...).hostname`), tidak cocok regex
   `/\.r2\.dev$/i` yang tidak menormalisasi titik akhir — padahal DNS
   memperlakukan `abc.r2.dev.` PERSIS sama dengan `abc.r2.dev`. Sama
   untuk `http://localhost.`.
2. **IPv6/`0.0.0.0` loopback tidak tercakup** (reviewer) —
   `new URL("http://[::1]/").hostname` mengembalikan `"[::1]"`, dan
   `new URL("http://0.0.0.0/").hostname` mengembalikan `"0.0.0.0"` —
   keduanya tidak cocok exact-string check yang tadinya cuma
   `"localhost"`/`"127.0.0.1"`.

**Fix**: `stripTrailingDot` (helper baru) menormalisasi titik akhir
SEBELUM kedua check berjalan; `isLoopbackHost` diperluas mencakup
`0.0.0.0`, `::1`, `[::1]` (case-insensitive). Encouragingly, obfuscation
IP lain (oktal/desimal/hex — `0177.0.0.1`/`2130706433`/`0x7f000001`) DAN
homograph Unicode pada dot (`．`/`。`) sudah otomatis dinetralkan oleh
normalisasi `URL`/IDNA bawaan Bun SEBELUM regex/exact-match berjalan
(diverifikasi kedua agent secara independen) — bukan sesuatu yang perlu
ditangani manual di sini. Regression test untuk kedua bypass di atas
ditambahkan ke `tests/unit/news-media-r2-config.test.ts`. Implementor
lanjutan yang menyentuh fungsi ini lagi **wajib** mempertahankan
`stripTrailingDot` dan keempat variant loopback ini — jangan
menyederhanakan balik ke exact-string match polos.

### File yang dibuat/diubah (referensi cepat)

- `src/modules/news-portal/domain/news-media-r2-config.ts`: tambah
  `NEWS_MEDIA_R2_KNOWN_MIME_TYPES`,
  `NEWS_MEDIA_R2_MAX_PRESIGNED_UPLOAD_TTL_SECONDS`,
  `findUnknownNewsMediaR2MimeTypes`, `isPresignedUploadTtlTooLong`,
  `findNewsMediaR2PublicBaseUrlProductionUnsafeReason`.
- `scripts/validate-env.ts`: `checkNewsMediaR2AllowedMimeTypesKnown`,
  `checkNewsMediaR2PresignedTtlUpperBound`, wired into
  `runEnvValidation`.
- `scripts/security-readiness.ts`:
  `checkNewsMediaR2PublicBaseUrlProductionSafe`,
  `checkNewsMediaR2NoStalePendingObjects`, wired into
  `runSecurityReadinessChecks`.
- `.env.example`, `18_configuration_env_reference.md` §News portal,
  `full-online-r2-architecture.md` §4, `r2-security-checklist.md` §7 —
  semua diperbarui untuk keempat check baru.
- Test: `tests/unit/news-media-r2-config.test.ts` (tambah describe
  block untuk tiga helper baru), `tests/validate-env.test.ts` (tambah
  describe block untuk dua check config:validate baru),
  `tests/security-readiness.test.ts` (tambah describe block untuk
  `checkNewsMediaR2PublicBaseUrlProductionSafe`; `checkNewsMediaR2NoStalePendingObjects`
  SENGAJA tidak di-unit-test di sini — pola sama
  `checkSsoBreakGlassReady`, lihat komentar header file test itu),
  `tests/integration/security-readiness-news-media-r2.integration.test.ts`
  (baru — DB nyata untuk `checkNewsMediaR2NoStalePendingObjects`, pola
  sama `security-readiness-break-glass.integration.test.ts`).
- Changeset: `.changeset/news-media-r2-readiness-checks-issue-635.md`.

## §636 — `blog_content` wajib referensi R2 media (Selesai)

### Rekonsiliasi — body issue #636 menyiratkan bentuk `{mediaObjectId, alt, caption}` baru; TIDAK diikuti untuk `featuredMediaId`

Body issue #636 menyiratkan reference shape `{mediaObjectId, alt,
caption}` sebagai field baru menggantikan `featuredMediaId`. **Tidak
diikuti** — `featuredMediaId` (kolom `awcms_mini_blog_posts`/
`awcms_mini_blog_pages`.`featured_media_id`, migration 026, TANPA FK,
lihat §633 di atas) TETAP UUID longgar persis seperti sebelumnya;
`alt`/`caption` SUDAH ADA sebagai kolom `alt_text`/`caption` di
`awcms_mini_news_media_objects` itu sendiri (#633) — menduplikasinya ke
kolom terpisah di `blog_content` akan menciptakan dua sumber kebenaran
untuk data yang sama (persis pola "derive, don't duplicate" yang
arsitektur doc §11 tetapkan untuk `public_url`). Yang berubah HANYA
validasi: `featuredMediaId`, ketika ada, sekarang WAJIB menunjuk baris
registry yang ada/`verified`/`attached`/tenant-sama — ditegakkan di
lapisan APLIKASI (butuh DB round-trip), bukan validator murni
(`blog-post-validation.ts`'s `validateFeaturedMediaId` TETAP shape-only,
sama pola `termIds`/`countExistingTerms`, Issue #539).

Untuk gallery block `content_json` (`GalleryItem` type,
`content-block-rendering.ts`, Issue #542): item bertipe `mediaType:
"image"` sekarang mendukung field baru `mediaObjectId` (di samping
`url` yang tetap ada untuk mode non-R2-only) — persis bentuk
`{mediaObjectId, caption}` yang diminta issue, TANPA `alt` terpisah
(alt text tetap dari `alt_text` registry, sama alasan di atas). Item
`mediaType: "video"` **tidak disentuh** — thumbnail R2 wajib untuk
video adalah scope #639 (belum dikerjakan), memaksanya sekarang akan
"membangun ke depan" sebelum dependency-nya siap.

### Gate tenant+env — komponen infrastruktur baru yang belum ada sebelumnya

`evaluateNewsPortalFullOnlineR2Readiness` (§632) murni env-based/global
— TIDAK tahu apakah TENANT PEMANGGIL benar-benar mengaktifkan preset
`news_portal_full_online_r2`. Issue ini menambah
`src/modules/blog-content/application/news-portal-r2-mode-gate.ts`'s
`isNewsPortalFullOnlineR2ModeActiveForTenant(tx, tenantId, env)` —
mengomposisikan check env global TERSEBUT dengan sinyal per-tenant
nyata bahwa tenant itu SUDAH menerapkan preset. **Sengaja runtime
check, BUKAN `module.ts` `dependencies` entry** — `blog_content` maupun
`news_portal` sudah SENGAJA tidak saling deklarasi dependency (lihat
§632's "Kenapa modul baru... dependencies HANYA...") untuk menghindari
`MODULE_REVERSE_DEPENDENCY_ACTIVE` mengunci disable salah satu modul
selamanya — menambah dependency di sini akan membangkitkan masalah yang
sama.

**PENTING — TIGA percobaan gagal sebelum menemukan sinyal yang benar
(tiga putaran review reviewer+security-auditor, PR #666; jangan re-derive
dari nol, KETIGANYA dikonfirmasi gagal secara nyata — dua oleh
integration test merah, satu oleh eksploitasi hidup yang direproduksi
security-auditor):**

1. **`fetchTenantModuleEntry(...).tenantEnabled` — GAGAL total.**
   Fungsi ini opt-out-by-default (tidak ada baris `awcms_mini_tenant_modules`
   berarti `tenantEnabled: true` — dokumentasinya sendiri menyatakan
   ini): HAMPIR SETIAP tenant baca `news_portal` "enabled" entah pernah
   menerapkan preset atau tidak (default setiap module untuk setiap
   tenant). Memakai ini sebagai sinyal opt-in membuat seluruh
   tenant-scoping issue ini TIDAK BEROPERASI SAMA SEKALI — begitu SATU
   tenant mana pun membuat env var deployment-wide jadi benar,
   VALIDASI INI AKTIF UNTUK SEMUA TENANT LAIN JUGA, persis skenario
   yang file ini sendiri tulis untuk dicegah.
2. **`entry.enabledAt !== null` — juga GAGAL, lebih halus.**
   Percobaan kedua: hanya `enableTenantModule` yang pernah menulis baris
   `awcms_mini_tenant_modules`, jadi `enabledAt: null` seharusnya berarti
   "tidak pernah disentuh". TAPI `enableTenantModule` (dipanggil oleh
   `applyModulePreset`/`applyNewsPortalFullOnlineR2Preset`) memvalidasi
   state SAAT INI dulu — tenant baru SUDAH baca "enabled" (default di
   atas), jadi validasi menolak dengan `MODULE_ALREADY_ENABLED`, yang
   oleh `applyModulePreset` diperlakukan sebagai `already_satisfied`
   (idempotency) — **TIDAK PERNAH menulis baris sama sekali**. Tenant
   yang BARU SAJA menerapkan preset punya `enabledAt: null` PERSIS SAMA
   dengan tenant yang tidak pernah menyentuhnya — dikonfirmasi gagal
   oleh 8 test integration yang tadinya lulus tiba-tiba merah semua
   begitu fix ini dicoba.
3. **`awcms_mini_module_settings` (`updateModuleSettings`/
   `fetchModuleSettingsView`) — GAGAL, dan ini yang PALING BERBAHAYA.**
   Percobaan ketiga BENAR secara logika (berhasil membedakan "diterapkan"
   dari "belum pernah disentuh"), TAPI tabel ini bisa ditulis langsung
   oleh tenant lewat endpoint generik
   `PATCH /api/v1/tenant/modules/{moduleKey}/settings`, digerbangi permission
   generik `module_management.settings.update` (default digrant ke
   Owner/Admin — SAMA SEKALI tidak terkait permission
   `blog_content`/`news_portal`). Tenant pemegang permission generik itu
   bisa `PATCH` key markernya jadi `null` dan MEMATIKAN SELURUH validasi
   R2-only issue ini untuk dirinya sendiri — security-auditor
   mereproduksi eksploitasi ini hidup end-to-end (PATCH 200, lalu POST
   post dengan `featuredMediaId` mentah lolos 200 padahal seharusnya
   422). **Verdict BLOCKED** pada re-audit kedua karena temuan ini.

**Sinyal yang BENAR-BENAR bekerja (percobaan keempat, final)**: tabel
BARU khusus, `awcms_mini_news_portal_tenant_state` (migration `043`,
`tenant_id` PK, kolom `full_online_r2_mode_applied_at`), yang TIDAK
PUNYA endpoint tulis generik SAMA SEKALI di mana pun. Satu-satunya kode
yang pernah menulis ke tabel ini adalah
`applyNewsPortalFullOnlineR2Preset`
(`news-portal/application/apply-news-portal-preset.ts`, lewat
`news-portal-tenant-state.ts`'s `markFullOnlineR2ModeApplied`) — satu-
satunya jalur resmi mengaktifkan preset ini (lihat header file itu
sendiri). `isNewsPortalFullOnlineR2ModeActiveForTenant` membaca lewat
`isFullOnlineR2ModeAppliedForTenant` — tenant tanpa baris di tabel ini
(mayoritas tenant hari ini) selalu `false`, fail-closed by construction,
TIDAK ADA jalur API mana pun (baik `module_management.settings.update`
maupun permission generik lain) yang bisa menyentuhnya.

**Pelajaran untuk implementor lanjutan yang butuh sinyal per-tenant
serupa**: JANGAN pernah menaruh sinyal keamanan/enforcement di
mekanisme yang SUDAH punya endpoint generik tenant-writable
(`awcms_mini_tenant_modules`, `awcms_mini_module_settings`) — keduanya
dirancang untuk operator self-service, bukan untuk menyimpan state yang
tidak boleh tenant itu sendiri ubah. Kalau butuh sinyal yang genuinely
tamper-proof, buat tabel baru sempit yang HANYA disentuh oleh satu
fungsi aplikasi yang sudah dipercaya, dan JANGAN mengekspos write path
apa pun ke sana.

Ketika mode TIDAK aktif untuk tenant (mayoritas deployment/tenant hari
ini): seluruh validasi baru ini adalah no-op — `featuredMediaId`/URL
gallery lama tetap berperilaku identik sebelum issue ini (backward
compatible, bukan pengetatan blanket). Regression test
`"R2-only mode active for tenant A does NOT leak into tenant B"` DAN
`"the generic PATCH .../settings endpoint CANNOT disable R2-only
validation"` di `blog-content-news-media-r2-references.integration.test.ts`
membuktikan ini secara eksplisit — implementor lanjutan yang mengubah
gate ini **wajib** menjaga kedua test itu tetap lulus.

### Bypass jalur restore revisi — ditemukan & ditutup sebelum merge (security-auditor, PR #666 review)

`POST /api/v1/blog/posts/{id}/revisions/{revisionId}/restore` (Issue
#541) menulis `revision.contentJson` balik ke post hidup lewat
`updateBlogPost` — jalur tulis KELIMA ke `content_json`/`featuredMediaId`
yang TIDAK ikut ter-patch bersama keempat route handler create/update
posts/pages ketika validasi ini pertama kali ditulis. Skenario nyata:
revisi lama (dibuat SEBELUM mode R2-only aktif, berisi gallery `url`
mentah yang legal saat itu) di-restore SETELAH tenant mengaktifkan mode
R2-only — restore lolos begitu saja, mengembalikan `url` mentah ke post
hidup TANPA validasi apa pun, langsung tampil publik di `/news`. **Fix**:
`restore.ts` sekarang juga memanggil
`validateNewsMediaReferencesForFullOnlineR2Mode` (hanya `contentJson`
revisi — `featuredMediaId` memang tidak pernah ikut snapshot revisi,
lihat §Aturan #13 blog-content skill) tepat sebelum `updateBlogPost`,
gagal `422 NEWS_MEDIA_REFERENCE_INVALID` persis sama seperti PATCH
biasa. Regression test:
`"POST .../revisions/{id}/restore also enforces the same validation"` di
file integration test yang sama. **Setiap jalur tulis baru ke
`content_json`/`featuredMediaId` di masa depan (mis. bulk-import,
duplicate-post) WAJIB melalui gate yang sama** — jangan asumsikan
keempat route handler asli sudah mencakup semua jalur tulis yang ada.

### File yang dibuat/diubah (referensi cepat)

- `src/modules/news-portal/application/news-media-object-directory.ts`:
  tambah `isNewsMediaObjectSafeForPublicReference(status)` — predikat
  bersama (`verified`/`attached` saja) dipakai `blog_content` supaya
  daftar "status aman untuk direferensikan publik" hanya didefinisikan
  SATU tempat.
- `src/modules/blog-content/application/news-portal-r2-mode-gate.ts`
  (baru) — lihat di atas.
- `src/modules/blog-content/domain/content-block-media-references.ts`
  (baru) — `collectGalleryImageReferences(contentJson)`, murni: mengekstrak
  `mediaObjectId` gallery item bertipe image + melaporkan violation
  (`raw_url_not_allowed`/`media_object_id_missing_or_malformed`) tanpa
  DB access.
- `src/modules/blog-content/application/news-media-reference-gate.ts`
  (baru) — `validateNewsMediaReferencesForFullOnlineR2Mode` (dipanggil
  route handler SETELAH validator murni, SEBELUM tulis — pola
  `countExistingTerms`) dan `resolveVerifiedNewsMediaReferences` (dipakai
  render-time, lihat di bawah).
- `src/modules/blog-content/domain/content-block-rendering.ts`: `GalleryItem`
  gains `mediaObjectId` opsional; `renderGalleryItem`/`renderGallery`/
  `renderBlock`/`renderContentJsonToHtml` menerima `resolvedMediaUrls`
  (default kosong — backward compatible untuk caller lama). Tambah
  `collectRenderableGalleryMediaObjectIds` (thin re-export
  `collectGalleryImageReferences`, satu traversal dipakai baik write-time
  maupun render-time supaya tidak pernah drift).
- `src/modules/blog-content/domain/seo-rendering.ts`: tambah
  `resolveOgImageUrl` — murni, menerima URL yang SUDAH di-resolve
  (bukan melakukan lookup sendiri).
- `src/modules/blog-content/domain/public-page-rendering.ts`:
  `PublicPageShellOptions` gains `ogImageUrl`/`ogImageAlt` opsional;
  `renderPublicPageShell` mengemit `og:image`/`twitter:card`/
  `twitter:image`/`og:image:alt` hanya bila `ogImageUrl` ada.
- `src/modules/blog-content/application/public-blog-directory.ts`:
  `PublicBlogPostDetail`/`fetchPublicBlogPostBySlug` SELECT sekarang ikut
  `featured_media_id` (sebelumnya tidak pernah di-SELECT sama sekali —
  tidak ada yang me-render-nya sebelum issue ini).
- `src/pages/news/[slug].ts`, `src/pages/blog/[tenantCode]/[slug].ts`:
  resolve SEMUA mediaObjectId (featured + gallery) dalam SATU bulk
  lookup (`resolveVerifiedNewsMediaReferences`) sebelum render — id yang
  tidak resolve (salah tenant/status tidak aman/tidak ada) diam-diam
  tidak dirender (degrade, don't 500).
- `src/pages/api/v1/blog/posts/index.ts`, `[id].ts`,
  `src/pages/api/v1/blog/pages/index.ts`, `[id].ts`,
  `src/pages/api/v1/blog/posts/[id]/revisions/[revisionId]/restore.ts`
  (kelima route — yang terakhir ditambah setelah re-review, lihat
  §"Bypass jalur restore revisi" di atas): panggil
  `validateNewsMediaReferencesForFullOnlineR2Mode` setelah pure
  validator + (untuk posts) `countExistingTerms`, sebelum
  create/updateBlogPost/Page — gagal `422 NEWS_MEDIA_REFERENCE_INVALID`.
- `sql/043_awcms_mini_news_portal_tenant_state_schema.sql` (baru) — tabel
  sempit `awcms_mini_news_portal_tenant_state` (`tenant_id` PK,
  `full_online_r2_mode_applied_at`), RLS FORCE, TANPA endpoint tulis
  generik apa pun — lihat §"Gate tenant+env" di atas untuk kenapa ini
  butuh migration baru (dua percobaan tanpa migration baru gagal, satu
  di antaranya benar-benar bisa dieksploitasi).
- `src/modules/news-portal/application/news-portal-tenant-state.ts`
  (baru) — `markFullOnlineR2ModeApplied`/`isFullOnlineR2ModeAppliedForTenant`,
  satu-satunya kode yang boleh menulis tabel di atas.
- `src/modules/news-portal/application/apply-news-portal-preset.ts`:
  setelah `applyModulePreset` sukses DAN entry `news_portal` sendiri di
  `result.changes` tidak `rejected` (rejection modul LAIN yang dibundel
  preset, mis. `visitor_analytics` karena `logging`-nya sendiri disabled,
  TIDAK memblokir — hanya rejection `news_portal` sendiri yang berarti
  tenant ini genuinely belum siap), panggil `markFullOnlineR2ModeApplied`.
- `src/lib/i18n/error-messages.ts`, `i18n/en.po`, `i18n/id.po`: entry baru
  `error.news_media_reference_invalid` untuk kode error di atas (admin UI
  sudah generic-fallback ke `error.message` server tanpa ini, tapi entry
  i18n eksplisit konsisten dengan SEMUA kode error lain di katalog).
- `openapi/awcms-mini-public-api.openapi.yaml`: `featuredMediaId`/
  `contentJson` schema description diperbarui (bentuk TIDAK berubah);
  response `422` baru di kelima endpoint create/update posts/pages +
  restore revisi.
- `tests/foundation.test.ts`: tambah nama file migration `043` ke daftar
  migration yang diharapkan.
- Test: `tests/unit/content-block-media-references.test.ts` (baru),
  `tests/blog-content-public-rendering.test.ts` (tambah describe block
  gallery mediaObjectId + og:image + `resolveOgImageUrl`),
  `tests/integration/blog-content-news-media-r2-references.integration.test.ts`
  (baru — end-to-end: create/update reject, cross-tenant, status
  unsafe, soft-deleted, gallery raw-url reject, gallery mediaObjectId
  accept, video item tidak terpengaruh, render publik og:image+gallery
  `<img>`, restore-revisi reject, "tenant B tidak terpengaruh aktivasi
  tenant A", DAN "endpoint settings generik tidak bisa menonaktifkan
  validasi" — tiga test terakhir ditambah setelah tiga putaran review).
- Changeset: `.changeset/blog-content-news-media-r2-references-issue-636.md`.

### Belum/di luar cakupan issue ini (untuk issue lanjutan)

- **Deteksi objek `orphaned`** (§4 `r2-backup-lifecycle.md`) — issue ini
  MENAMBAH titik referensi baru (`featuredMediaId`, gallery
  `mediaObjectId`) yang WAJIB masuk daftar titik referensi deteksi
  orphan begitu job itu akhirnya dibangun (masih belum ada issue yang
  mengklaimnya, lihat §635's catatan).
- **Video gallery item R2-only** — sengaja tidak disentuh, scope #639.
- **SEO metadata lengkap** (structured data, Twitter card selain
  `summary_large_image`, dst.) — `resolveOgImageUrl`/`og:image` di sini
  adalah irisan MINIMAL yang memenuhi acceptance criteria #636 ("SEO
  image rendering uses verified R2 media metadata only"); polish SEO
  penuh tetap scope #649.
- **Admin UI picker visual** untuk memilih media object (saat ini admin
  tetap mengetik UUID `featuredMediaId`/`mediaObjectId` manual di form —
  sama seperti sebelum issue ini, lihat `awcms-mini-blog-content`
  SKILL.md). Server mengembalikan error jelas
  (`NEWS_MEDIA_REFERENCE_INVALID`) yang sudah tampil sebagai banner
  admin UI (fallback generic `strings.errorMessages`/`error.message`,
  `AdminLayout.astro`'s pattern) — tapi tidak ada UI picker baru yang
  dibangun issue ini.

## §637 — Editorial homepage section composer (Selesai)

Implementasi lengkap: migration `044_awcms_mini_news_portal_homepage_sections_schema.sql`
(tabel `awcms_mini_news_portal_homepage_sections`, RLS ENABLE+FORCE, sama
idiom `awcms_mini_blog_ads`), domain `news-portal/domain/homepage-section-policy.ts`
(whitelist enam `sectionType` + validator `config_json` per tipe, diskriminasi
ketat), application `news-portal/application/homepage-section-directory.ts`
(CRUD tenant-scoped), `homepage-section-reference-validation.ts` (existence/
ownership check untuk setiap id/slug di `config`), `homepage-section-composer.ts`
(orkestrasi render-time: resolve referensi live lalu panggil renderer),
domain `homepage-section-rendering.ts` (renderer whitelist murni), endpoint
admin `POST/GET /api/v1/news-portal/homepage-sections`,
`PATCH/DELETE .../{id}`, admin UI `admin/news-portal/homepage-sections.astro`,
dan wiring publik di `src/pages/news/index.ts` (halaman 1 saja).

### Rekonsiliasi — enam `sectionType` diimplementasikan, EMPAT dari daftar "such as" issue TIDAK

Body issue #637 menyarankan sepuluh tipe section
(`headline, latest_posts, featured_posts, editor_picks, category_grid,
video_block, gallery_block, ad_slot, static_page_block, custom_widget_block`)
sebagai contoh ("such as"), BUKAN acceptance criteria wajib berbentuk daftar
tertutup. Diimplementasikan: `headline`, `latest_posts`, `featured_posts`,
`editor_picks`, `category_grid`, `gallery_block` — enam tipe yang SEMUANYA
bisa dipenuhi acceptance criteria "setiap gambar yang dirender section wajib
dari objek R2 media terverifikasi" memakai infrastruktur yang SUDAH ADA
(post `featured_media_id`, sudah R2-gated sejak #636; registry media #633).
EMPAT tipe berikut **sengaja tidak diimplementasikan issue ini**, didokumentasikan
di migration 044's header comment:

- **`video_block`** — butuh Issue #639 (content block `video_news` dengan
  thumbnail R2 wajib) yang BELUM ada. Membangunnya sekarang berarti
  "membangun ke depan sebelum dependency siap" — pola kesalahan yang epic
  ini berulang kali diperingatkan hindari (lihat §635's catatan soal deteksi
  orphan).
- **`ad_slot`** — butuh Issue #638 (preset placement iklan R2-only) yang
  BELUM ada. `awcms_mini_blog_ads`'s `image_url` HARI INI masih URL bebas
  (lihat `blog-content` README §Ads) — merender iklan lewat homepage
  composer sekarang akan MELANGGAR acceptance criteria issue ini sendiri
  ("semua gambar section wajib R2 terverifikasi").
- **`custom_widget_block`** — **eksplisit di luar cakupan** per body issue
  sendiri ("Arbitrary HTML widgets" ada di §Out of scope).
- **`static_page_block`** — dipertimbangkan lalu di-drop: TIDAK ADA route
  publik yang me-render `awcms_mini_blog_pages` sama sekali di repo ini
  hari ini (hanya `blog-page-directory.ts` sisi admin) — membangun rute
  publik page-detail baru bukan efek samping issue homepage composer,
  itu keputusan terpisah.

Implementor #638/#639 yang akhirnya membangun dependency di atas **wajib**
menambah `sectionType` baru ke whitelist (`homepage-section-policy.ts`,
migration `CHECK` constraint-nya, OpenAPI enum) — bukan mengubah tipe yang
sudah ada.

### Reference validation — TANPA GERBANG mode R2-only, berbeda dari #636

`homepage-section-reference-validation.ts` memvalidasi SETIAP referensi
(`postId`/`postIds`/`categorySlugs`/`mediaObjectIds`) SETIAP KALI, TANPA
gerbang `isNewsPortalFullOnlineR2ModeActiveForTenant` yang #636 pakai.
Ini BUKAN kealpaan — tabel `awcms_mini_news_portal_homepage_sections`
adalah tabel BARU dengan NOL baris pra-eksisting; tidak ada "bentuk lama"
yang perlu dijaga kompatibel (beda dengan `featuredMediaId`/gallery
`content_json` #636 yang sudah dipakai jutaan post sebelum R2-only mode
ada). Implementor lanjutan JANGAN menambahkan gerbang mode di sini tanpa
alasan baru — sengaja unconditional by design.

### `sectionType` immutable setelah dibuat

`validateUpdateHomepageSectionInput(body, currentSectionType)` menerima
`currentSectionType` dari row yang SUDAH ADA (di-fetch pemanggil dulu) —
`config` pada request update SELALU divalidasi terhadap tipe SAAT INI,
BUKAN tipe baru yang mungkin diminta client. Request yang mencoba mengubah
`sectionType` ditolak `400`. Alasan: mengizinkan ganti tipe berarti bentuk
`config_json` lama (misal `postId` milik `headline`) jadi sampah tak
tervalidasi untuk tipe baru (misal `gallery_block` yang butuh
`mediaObjectIds`) — lebih sederhana & aman mewajibkan hapus+buat ulang
daripada membangun migrasi bentuk config in-place.

### Reorder — TIDAK ada endpoint bulk-reorder terpisah

Repo ini TIDAK punya preseden endpoint "PATCH array of ids in order" atau
"reorder" khusus di manapun (`grep -rn "reorder"` nihil hasil relevan
sebelum issue ini) — konvensi yang ada (`widget-directory.ts`'s
`updateWidget`) memperlakukan `sort_order` sebagai field yang di-PATCH
satu-per-row seperti field lain. Issue ini mengikuti PERSIS pola itu:
admin "reorder" dengan mem-PATCH `sortOrder` tiap section satu per satu
lewat form edit yang sudah ada — TIDAK menambah endpoint baru untuk itu.

### File yang dibuat/diubah (referensi cepat)

- `sql/044_awcms_mini_news_portal_homepage_sections_schema.sql` (baru).
- `src/modules/news-portal/domain/homepage-section-policy.ts`,
  `domain/homepage-section-rendering.ts`,
  `application/homepage-section-directory.ts`,
  `application/homepage-section-reference-validation.ts`,
  `application/homepage-section-composer.ts` (semua baru).
- `src/modules/blog-content/application/public-blog-directory.ts`: tambah
  `featuredMediaId` ke `PublicBlogPostSummary`/`toSummary` (sebelumnya
  hanya di `PublicBlogPostDetail`, #636) + `fetchPublicBlogPostSummariesByIds`
  baru (mempertahankan urutan permintaan pemanggil untuk konten kurasi,
  BUKAN `published_at DESC`).
- `src/pages/api/v1/news-portal/homepage-sections/index.ts` (create/list),
  `.../[id].ts` (update/delete) — baru.
- `src/pages/admin/news-portal/homepage-sections.astro` — baru, pola sama
  `admin/blog/ads.astro` (JSON textarea untuk `config`, state
  loading/empty/error/ready via `StateNotice`).
- `src/pages/news/index.ts`: panggil `composeHomepageSectionsHtml` di atas
  daftar post polos, HANYA `page === 1` — tenant tanpa section (mayoritas
  hari ini) melihat halaman byte-identik dengan sebelum issue ini.
- Diperbarui: `src/modules/news-portal/module.ts` (permissions
  `homepage_sections.{read,configure}`, `navigation` baru dideklarasikan
  — screen admin pertama modul ini, version 0.2.0→0.3.0),
  `src/lib/i18n/error-messages.ts` (`HOMEPAGE_SECTION_REFERENCE_INVALID`/
  `HOMEPAGE_SECTION_KEY_CONFLICT`), `i18n/en.po`/`i18n/id.po`.
- `openapi/awcms-mini-public-api.openapi.yaml`: tag "News Portal Homepage
  Sections" baru, tiga path, empat schema baru.
- Test: `tests/unit/homepage-section-policy.test.ts`,
  `tests/unit/homepage-section-rendering.test.ts`,
  `tests/integration/news-portal-homepage-sections.integration.test.ts`
  (baru — CRUD, reference validation per tipe, cross-tenant 404 (RLS,
  bukan 403), ABAC 403 tanpa permission, render publik enabled/disabled/
  degrade-saat-unpublish/gallery); diperbarui:
  `tests/unit/news-media-permissions.test.ts`,
  `tests/modules/news-portal-module.test.ts` (keduanya di-filter per
  `activityCode` supaya jumlah permission `media` yang lama tidak
  tercampur dengan `homepage_sections` yang baru),
  `tests/foundation.test.ts` (migration list 044).
- Changeset: `.changeset/news-portal-homepage-sections-issue-637.md`.

## §638-#640, #642, #649 — konsumsi media registry lanjutan (belum dikerjakan)

Ringkasan objective per issue (detail lengkap ada di body issue
GitHub masing-masing, cek `gh issue view <n>` bila butuh acceptance
criteria penuh):

- **#638** — preset placement iklan dengan validasi gambar R2-only
  (memperluas `awcms_mini_blog_ads`'s `image_url` yang saat ini bebas
  URL http(s) — lihat `blog-content` README §Ads). **Setelah ini selesai**,
  `homepage-section-policy.ts`'s whitelist WAJIB diperluas dengan
  `ad_slot` (lihat §637's "Rekonsiliasi" di atas).
- **#639** — content block `video_news` baru dengan thumbnail R2 wajib
  (thumbnail, bukan video itu sendiri, yang wajib R2 — video hosting
  eksternal seperti YouTube/embed kemungkinan tetap di luar cakupan R2,
  cek body issue untuk detail persis sebelum implementasi). **Setelah ini
  selesai**, tambahkan `video_block` ke whitelist yang sama.
- **#640** — content quality checklist publishing dengan syarat gambar
  R2 (mis. featured image wajib ada + confirmed sebelum status
  `published` diizinkan).
- **#642** — social share buttons publik di `/news` dengan canonical
  URL aman + Open Graph/Twitter Card + privacy-conscious.
- **#649** — SEO + social preview metadata lengkap (title/excerpt/
  canonical/gambar R2 terverifikasi) untuk crawler share.

Semua issue ini **wajib** mengonsumsi media registry (#633) dan validasi
`confirmed`-only (#636) — bukan re-derive validasi URL/MIME sendiri.

## §641 — Automatic internal tag linking (belum dikerjakan)

Ringkasan scope: auto-linking tag/taxonomy di dalam konten post/news
memakai tag/taxonomy yang **sudah ada** (`blog_content`'s
`awcms_mini_blog_terms`), sambil menjaga kontrol editorial, keamanan
SEO, aksesibilitas, dan keamanan rendering. **Tidak terkait R2/media**
secara langsung — item ini ada di epic yang sama karena sama-sama
bagian pengalaman editorial `news_portal`, tapi tidak bergantung pada
Keputusan kunci #1-#5 di atas. Implementor wajib tetap memakai whitelist
renderer yang sama (`content-block-rendering.ts`) — auto-linking tidak
boleh membuka jalur raw-HTML baru (lihat `blog-content` README
§Rendering publik tetap aman dari XSS).

## Prinsip yang wajib dipertahankan di setiap issue lanjutan

1. **Full-online-only, opt-in eksplisit** — tidak ada perilaku epic ini
   yang aktif default untuk deployment yang tidak eksplisit mengaktifkan
   preset (#632). Offline/LAN tidak boleh terpengaruh sama sekali.
2. **R2-only untuk binary, Postgres untuk metadata** — tidak ada kolom
   binary baru di tabel manapun epic ini menyentuh.
3. **Tidak ada fallback filesystem lokal, tidak ada temp file lokal** —
   lihat Keputusan kunci #2.
4. **Bucket + kredensial R2 media terpisah dari `sync-storage`** — lihat
   Keputusan kunci #1. Ini bukan saran, ini penegakan wajib di
   `config:validate`/`security:readiness` (#635).
5. **Object key: UUID + tanggal + tenant, tidak pernah nama file/PII** —
   lihat Keputusan kunci #3.
6. **Status Postgres bukan kontrol akses storage** — lihat Keputusan
   kunci #4, jangan berasumsi sebaliknya di kode/dokumentasi baru.
7. **SVG dilarang default** — lihat Keputusan kunci #5.
8. **Konten editorial hanya boleh menunjuk media `confirmed`** — dari
   #636 dan seterusnya; jangan re-derive aturan URL bebas lama.

## Referensi

- `docs/awcms-mini/news-portal/full-online-r2-architecture.md` — arsitektur lengkap + pemetaan kepatuhan.
- `docs/awcms-mini/news-portal/r2-upload-sop.md` — SOP upload.
- `docs/awcms-mini/news-portal/r2-security-checklist.md` — checklist keamanan.
- `docs/awcms-mini/news-portal/r2-incident-response.md` — runbook insiden.
- `docs/awcms-mini/news-portal/r2-backup-lifecycle.md` — backup/lifecycle/retensi.
- `docs/awcms-mini/news-portal/newsroom-user-guide.md` — panduan editor.
- `src/modules/sync-storage/README.md` — R2 usage yang sudah ada (bucket terpisah, Keputusan kunci #1).
- `src/modules/blog-content/README.md` §Media/Gallery, §Ads — perilaku sebelum #636 mengubahnya.
- `docs/adr/0006-offline-first-sync-outbox.md` — provider eksternal opsional/di luar transaksi.
- `docs/awcms-mini/deployment-profiles.md` §News portal — ringkasan per profil deployment.
- `AGENTS.md` skill table.
