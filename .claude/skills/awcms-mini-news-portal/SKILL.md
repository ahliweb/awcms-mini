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
| #635  | Config validation + readiness checks (`config:validate`/`security:readiness`/`production:preflight`) untuk R2 image delivery | Belum dikerjakan — lihat §635 di bawah               |
| #636  | `blog_content` wajib referensi R2 media object untuk gambar berita saat mode aktif                                           | Belum dikerjakan — lihat §636 di bawah               |
| #637  | Editorial homepage section composer `/news` dengan render R2-only                                                            | Belum dikerjakan — lihat §637 di bawah               |
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
`markNewsMediaObjectUploaded`, bukan dari klaim client. Tidak ada kolom
untuk menyimpan klaim client terpisah dari nilai final itu. Solusi:
`checksumSha256` opsional diterima di BODY FINALIZE (bukan create) —
fungsional setara (klien Jalur A memegang byte yang sama persis untuk
kedua request, tidak ada kerugian menyertakan ulang di request kedua)
tanpa perlu migration baru. `CreateNewsMediaUploadSessionRequest` di
OpenAPI TIDAK punya field checksum sama sekali;
`FinalizeNewsMediaUploadSessionRequest` punya `checksumSha256` opsional.

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
  job, kemungkinan besar #635, di luar cakupan issue ini).
- Endpoint `attach` nyata (permission `news_portal.media.attach` sudah
  di-declare, tapi belum ada route yang memanggilnya) — verifikasi
  `owner_resource_id` exist+tenant-match (temuan Medium security-auditor
  PR #652, dicatat di §633 di atas) masih WAJIB ditegakkan issue yang
  menambah endpoint attach nyata, BUKAN issue ini.
- Retention/legal-hold pada purge — masih gap sistemik yang sama
  (dicatat di §633), tidak disentuh issue ini (tidak ada endpoint purge
  nyata yang dirilis di sini).

## §635 — Readiness checks (belum dikerjakan)

Ringkasan scope: `config:validate`, `security:readiness`,
`production:preflight` untuk R2 image delivery. Kontrak lengkap yang
wajib dipenuhi: `r2-security-checklist.md` §7 (termasuk penegakan
`NEWS_MEDIA_R2_BUCKET` ≠ `R2_BUCKET`, kredensial berbeda, SVG tidak di
allow-list kecuali override eksplisit). Implementor **wajib**
memperbarui `r2-security-checklist.md` §7 begitu check nyata ditulis
(ganti "belum ada" jadi nama fungsi/test).

## §636 — `blog_content` wajib referensi R2 media (belum dikerjakan)

Ringkasan scope: featured image, block gallery, gambar SEO, dan
surface gambar blog/news lain **wajib** menunjuk baris
`status='confirmed'` di media registry (#633) ketika mode R2-only aktif
— menerapkan Keputusan kunci #4 di atas ke `blog_content` yang sudah
ada (yang saat ini, sebelum issue ini, memakai `featuredMediaId` sebagai
UUID longgar tanpa FK dan URL bebas `isAbsoluteHttpUrl` untuk gallery —
lihat `src/modules/blog-content/README.md` §Media/Gallery). Implementor
**wajib** membaca subbagian itu untuk memahami perilaku sebelum issue
ini (tidak ada FK, tidak ada media library nyata) yang akan diganti.

## §637-#640, #642, #649 — konsumsi media registry (belum dikerjakan)

Ringkasan objective per issue (detail lengkap ada di body issue
GitHub masing-masing, cek `gh issue view <n>` bila butuh acceptance
criteria penuh):

- **#637** — homepage section composer `/news` dengan render R2-only
  (gambar section harus dari media registry, bukan URL bebas).
- **#638** — preset placement iklan dengan validasi gambar R2-only
  (memperluas `awcms_mini_blog_ads`'s `image_url` yang saat ini bebas
  URL http(s) — lihat `blog-content` README §Ads).
- **#639** — content block `video_news` baru dengan thumbnail R2 wajib
  (thumbnail, bukan video itu sendiri, yang wajib R2 — video hosting
  eksternal seperti YouTube/embed kemungkinan tetap di luar cakupan R2,
  cek body issue untuk detail persis sebelum implementasi).
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
