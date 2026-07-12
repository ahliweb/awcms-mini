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
| #638  | Preset placement iklan news portal dengan validasi gambar R2-only                                                            | **Selesai** — lihat §638 di bawah                    |
| #639  | Content block `video_news` dengan thumbnail R2 wajib                                                                         | **Selesai** — lihat §639 di bawah                    |
| #640  | Content quality checklist publishing dengan syarat gambar R2                                                                 | **Selesai** — lihat §640 di bawah                    |
| #641  | Automatic internal tag linking untuk konten post/news                                                                        | **Selesai** — lihat §641 di bawah                    |
| #642  | Public social share buttons di halaman artikel `/news`                                                                       | **Selesai** — lihat §642 di bawah                    |
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

## §639 — Content block `video_news` dengan thumbnail R2 wajib (Selesai)

Implementasi lengkap: domain baru
`blog-content/domain/video-news-block-validation.ts` (allowlist provider +
normalisasi videoId, UNCONDITIONAL — tidak digerbangi mode R2-only),
application baru
`blog-content/application/video-news-thumbnail-reference-gate.ts` (verifikasi
`thumbnailMediaObjectId`, mode-gated — pola PERSIS sama `news-media-
reference-gate.ts` #636), renderer baru `_shared/rendering/video-news-block-
renderer.ts` (iframe `youtube-nocookie.com` aman). **Tidak ada migration
baru** — `owner_resource_type` enum (migration 041, #633) sudah memuat
`'video_thumbnail'` sejak awal, dan thumbnail video tidak pernah di-`attach`
(persis pola gallery image #636 — hanya diverifikasi `verified`/`attached`,
tidak pernah menulis `owner_resource_type`/`owner_resource_id`).

### Keputusan desain kunci — DUA lapis validasi, hanya SATU yang mode-gated

Berbeda dari #636 (yang semuanya mode-gated), issue ini memisahkan dua
kelas kontrol:

1. **UNCONDITIONAL (selalu berlaku, tidak peduli mode R2-only aktif atau
   tidak)** — allowlist `provider` (hanya `"youtube"` hari ini) dan
   validasi/normalisasi `videoId` (dari id mentah 11 karakter ATAU URL
   YouTube umum: `watch?v=`, `youtu.be/`, `/embed/`, `/shorts/`, semuanya
   dinormalisasi ke id kanonik sebelum disimpan). Alasan: body issue sendiri
   membingkai ini sebagai kontrol keamanan embed ("treat video embeds as
   high-risk content"), bukan kebijakan penyimpanan R2 — jadi berlaku untuk
   SEMUA tenant, bukan hanya yang mengaktifkan preset `news_portal_full_online_r2`.
   Dijalankan di `validateAndNormalizeContentJsonVideoBlocks` (pure, tanpa
   akses DB), dipanggil route handler SEBELUM `withTenant` (tidak butuh
   transaksi).
2. **MODE-GATED (hanya saat `isFullOnlineR2ModeActiveForTenant` true)** —
   `thumbnailMediaObjectId` (opsional — body issue eksplisit "tenant policy
   may optionally allow provider default thumbnail") wajib menunjuk objek
   registry R2 yang ada/verified-atau-attached/tenant-sama, PERSIS pola
   `featuredMediaId`/gallery `mediaObjectId` (#636). Di luar mode itu, field
   ini bahkan TIDAK divalidasi format-nya sama sekali (sengaja meniru
   perlakuan gallery `mediaObjectId` yang juga tidak pernah dicek shape-nya
   di luar mode aktif) — nilai apa pun yang tidak resolve hanya tidak pernah
   dirender, tidak pernah dianggap error.

"Raw iframe HTML/script harus ditolak" (Rules issue ini) SENGAJA TIDAK
diimplementasikan sebagai regex baru khusus blok ini — proteksi yang sudah
ada (`content-validation.ts`'s `containsUnsafeHtml`, Issue #538,
unconditional, men-scan SELURUH `contentJson` yang di-`JSON.stringify`)
SUDAH menutup ini untuk block type apa pun termasuk `video_news`. Lapis
kedua yang genuinely baru:
`validateAndNormalizeContentJsonVideoBlocks` MEMBANGUN ULANG setiap blok
`video_news` HANYA dari field yang dikenal (`provider`/`videoId`
ternormalisasi/`title`/`caption`/`thumbnailMediaObjectId`/
`durationSeconds`/`sourceLabel`) — field asing apa pun (mis. `rawEmbedHtml`)
otomatis hilang saat disimpan, bukan cuma diblok regex.

### Kenapa DUA file terpisah untuk thumbnail-reference, bukan extend `news-media-reference-gate.ts` (#636) langsung

Issue paralel #640 (content quality checklist) berjalan bersamaan dan sama-
sama menyentuh permukaan validasi/rendering content-block. Untuk
meminimalkan risiko conflict merge, ekstensi issue ini dibuat SEADITIF
mungkin:

- `content-block-media-references.ts` (#636): HANYA menambah fungsi baru
  `collectVideoNewsThumbnailReferences` + tipe barunya — fungsi
  `collectGalleryImageReferences` yang sudah ada SAMA SEKALI tidak disentuh.
- `content-block-rendering.ts` (#636): HANYA menambah import baru, satu
  union member baru (`video_news`), satu `case` baru di `renderBlock`'s
  `switch`, dan satu fungsi re-export baru
  (`collectRenderableVideoNewsThumbnailMediaObjectIds`) — signature
  `renderContentJsonToHtml`/`renderBlock` TIDAK berubah sama sekali (thumbnail
  video memakai `resolvedMediaUrls` map yang SAMA dengan gallery, karena
  keduanya berbagi id space registry media yang sama — tidak perlu parameter
  kedua).
- `news-media-reference-gate.ts` (#636) SENGAJA TIDAK disentuh SAMA SEKALI —
  dibuat file sibling baru
  `video-news-thumbnail-reference-gate.ts` dengan fungsi
  `validateVideoNewsThumbnailReferencesForFullOnlineR2Mode` yang polanya
  identik tapi hidup independen. Route handler memanggil KEDUA gate secara
  berurutan (gallery/featured dulu, lalu video thumbnail) — sedikit boilerplate
  ekstra di route handler, tapi nol risiko konflik pada fungsi #636 yang
  sudah lolos tiga putaran review.

### Renderer — iframe `youtube-nocookie.com`, CSP `frame-src` diperluas

`_shared/rendering/video-news-block-renderer.ts` (pola sama
`gallery-block-renderer.ts`, Issue #681 — neutral ground, tidak meng-import
dari `blog_content`/`news_portal` mana pun) membangun `<iframe src="https://
www.youtube-nocookie.com/embed/{videoId}">` HANYA dari `provider`+`videoId`
tervalidasi — TIDAK PERNAH dari field HTML mentah apa pun (tidak ada field
seperti itu dalam skema block ini sama sekali). `astro.config.mjs`'s CSP
`frame-src` diperluas menambahkan origin ini (pola sama penambahan
Cloudflare Turnstile, Issue #588) — tanpa ini, browser akan MEMBLOKIR iframe
tersebut meski markup-nya sudah aman. Thumbnail kustom (bila resolve)
dirender sebagai `<img class="video-news-thumbnail">` terpisah SEBELUM
iframe; `sourceLabel`/`caption` dirender sebagai teks ter-escape sesudahnya.

### File yang dibuat/diubah (referensi cepat)

- `src/modules/blog-content/domain/video-news-block-validation.ts` (baru).
- `src/modules/blog-content/application/video-news-thumbnail-reference-gate.ts`
  (baru).
- `src/modules/_shared/rendering/video-news-block-renderer.ts` (baru).
- `src/modules/blog-content/domain/content-block-media-references.ts`:
  tambah `collectVideoNewsThumbnailReferences` (aditif).
- `src/modules/blog-content/domain/content-block-rendering.ts`: tambah
  union `video_news`, `case` baru di `renderBlock`, fungsi
  `collectRenderableVideoNewsThumbnailMediaObjectIds` (aditif).
- `astro.config.mjs`: `frame-src` tambah `https://www.youtube-nocookie.com`.
- `src/pages/api/v1/blog/posts/index.ts`, `[id].ts`,
  `src/pages/api/v1/blog/pages/index.ts`, `[id].ts`,
  `src/pages/api/v1/blog/posts/[id]/revisions/[revisionId]/restore.ts`:
  panggil `validateAndNormalizeContentJsonVideoBlocks` (unconditional,
  400 VALIDATION_ERROR) DAN
  `validateVideoNewsThumbnailReferencesForFullOnlineR2Mode` (mode-gated,
  422 NEWS_MEDIA_REFERENCE_INVALID, reuse kode error yang sama dengan #636).
- `src/pages/news/[slug].ts`, `src/pages/blog/[tenantCode]/[slug].ts`:
  gabungkan id thumbnail video ke bulk `resolveMediaReferences` yang sama
  dengan featured+gallery.
- `i18n/en.po`/`i18n/id.po`:
  `admin.blog.posts.content_json_hint` diperbarui menyebut `video_news`.
- `openapi/awcms-mini-public-api.openapi.yaml`: deskripsi `contentJson`
  (enam lokasi) dan respons 422 (lima lokasi) diperbarui menyebut
  `video_news`/thumbnail — bentuk schema TIDAK berubah (`contentJson` tetap
  `type: object` generik).
- Test: `tests/unit/video-news-block-validation.test.ts`,
  `tests/unit/video-news-thumbnail-reference-gate.test.ts` (baru);
  diperbarui: `tests/unit/content-block-media-references.test.ts` (describe
  block baru untuk `collectVideoNewsThumbnailReferences`),
  `tests/blog-content-public-rendering.test.ts` (describe block baru untuk
  rendering `video_news` +
  `collectRenderableVideoNewsThumbnailMediaObjectIds`); baru:
  `tests/integration/blog-content-video-news-block.integration.test.ts`
  (file TERPISAH dari `blog-content-news-media-r2-references.integration.test.ts`
  #636 — end-to-end: normalisasi videoId dari URL, provider ditolak,
  videoId tidak valid ditolak, iframe/script mentah ditolak, field asing
  di-strip, cross-tenant/status-tidak-aman thumbnail ditolak, render publik
  iframe+thumbnail).
- Changeset: `.changeset/news-portal-video-news-block-issue-639.md`.

### Belum/di luar cakupan issue ini (untuk issue lanjutan)

- **Provider selain YouTube** (Vimeo, dll) — `VIDEO_NEWS_PROVIDERS`
  sengaja hanya `["youtube"]` (body issue: "Initial provider allowlist:
  youtube"). Menambah provider lain butuh fungsi normalisasi id baru per
  provider di `video-news-block-validation.ts` DAN entry `frame-src` CSP
  baru di `astro.config.mjs`.
- **Tenant policy toggle eksplisit** untuk "izinkan thumbnail default
  provider vs wajib custom R2" — body issue menyebut ini sebagai opsi
  ("Tenant policy may optionally allow provider default thumbnail"), TIDAK
  diimplementasikan sebagai setting nyata (thumbnail sudah opsional secara
  struktural — tidak ada mekanisme "wajibkan custom thumbnail" terpisah).
  Issue lanjutan yang butuh mode itu boleh menambah field
  `module_settings` baru, mengikuti pola yang sudah ada.
- **Homepage section `video_block`** (`homepage-section-policy.ts`'s
  whitelist, #637's catatan) — dependency (`video_news` block ini) sekarang
  SUDAH ada, tapi mewiring `sectionType` baru itu sendiri tetap scope issue
  terpisah, tidak diklaim di sini.
- **Admin UI picker visual** untuk memilih video/thumbnail — sama seperti
  #636/#637, admin tetap mengetik JSON `contentJson` manual (textarea yang
  sudah ada); hanya hint teksnya yang diperbarui.

## §681 — Capability ports menggantikan import langsung ke `blog_content` (epic #679, BUKAN epic ini — Selesai)

**Issue ini bukan bagian epic `news_portal` (#631-#642/#649)** — ia datang
dari epic terpisah `#679` (platform-hardening, audit statis repo), tapi
mengubah cukup banyak file inti modul ini sehingga didokumentasikan di
sini juga (lihat `[[platform-hardening-epic-progress]]` di memory kalau
butuh konteks epic #679 penuh).

### Masalah — cycle source-level nyata, bukan cuma di `dependencies`

§636 dan §637 di atas masing-masing menulis eksplisit "cross-module
TypeScript import BUKAN `dependencies` array, yang cuma mengatur urutan
enable/disable" — benar untuk KONSEKUENSI lifecycle-nya, tapi hasil
akhirnya tetap sebuah cycle nyata di level import SOURCE CODE:
`blog-content/application/news-media-reference-gate.ts` meng-import
`news-portal/application/news-media-object-directory.ts` (§636), sementara
`news-portal/application/homepage-section-composer.ts` meng-import
`blog-content/application/public-blog-directory.ts` DAN
`blog-content/application/news-media-reference-gate.ts` (§637) — yang
baru saja disebut BALIK meng-import `news-portal`. Rantai tiga-hop yang
sama sekali tidak terlihat dari `module.ts`'s `dependencies` manapun.
`news-portal/domain/homepage-section-rendering.ts` juga meng-import
`blog-content/domain/content-block-rendering.ts` langsung (reuse gallery
renderer).

### Solusi — ports-and-adapters minimal, composition root = route handler

Detail lengkap alasan/alternatif ada di **ADR-0011**
(`docs/adr/0011-capability-ports-for-cross-module-collaboration.md`) —
ringkasan:

- **Port** (interface murni, TIDAK meng-import modul manapun):
  `src/modules/_shared/ports/news-media-port.ts` (`NewsMediaPort` —
  kapabilitas `news_portal`, dipakai `blog_content`) dan `.../public-
content-port.ts` (`PublicContentPort` — kapabilitas `blog_content`,
  dipakai `news_portal`). DTO di port SENGAJA bentuk sendiri, bukan
  re-export tipe modul pemilik.
- **Adapter** (implementasi konkret, hidup di modul PEMILIK kapabilitas):
  `news-portal/application/news-media-port-adapter.ts` (folds in fungsi
  `isNewsPortalFullOnlineR2ModeActiveForTenant` yang dulu di
  `blog-content/application/news-portal-r2-mode-gate.ts` — **file itu
  DIHAPUS**, seluruh histori "TIGA percobaan gagal" §636 di atas
  dipindah verbatim ke header komentar adapter ini, JANGAN hilang saat
  baca ulang §636 tanpa cek adapter ini juga) dan
  `blog-content/application/public-content-port-adapter.ts`.
- **Composition root** = route handler (`src/pages/api/v1/**`,
  `src/pages/news/**`, `src/pages/blog/**`) — SUDAH jadi lapisan yang
  boleh meng-import lintas-modul (konvensi lama, bukan baru), jadi tidak
  butuh infrastruktur DI baru. Setiap route handler yang butuh kapabilitas
  lintas-modul meng-import adapter konkret dan menyuntikkannya sebagai
  parameter fungsi biasa (BUKAN default parameter — setiap pemanggil
  WAJIB eksplisit menyuntikkan, supaya tidak ada jalur "lupa suntik jadi
  diam-diam pakai import langsung lagi").
- `renderContentJsonToHtml`'s gallery-rendering (dipakai KEDUA modul)
  pindah ke `src/modules/_shared/rendering/gallery-block-renderer.ts` —
  neutral ground, bukan salah satu modul "meminjam" dari yang lain.
  `content-block-rendering.ts` (blog-content) dan
  `homepage-section-rendering.ts` (news-portal) SAMA-SAMA memanggil
  fungsi shared ini sekarang.
- `_shared/module-contract.ts`'s `ModuleDescriptor` dapat field baru
  opsional, `capabilities?: {provides, consumes}` — dokumentasi
  terstruktur hubungan port ini, TERPISAH dari `dependencies` (yang tetap
  murni untuk urutan enable/disable, keputusan #632 masih berlaku, TIDAK
  diubah issue ini).
- Test struktural baru, `tests/unit/module-boundary.test.ts` — men-scan
  `blog-content`/`news-portal`'s `application`/`domain` tree untuk import
  langsung ke tree modul lain (regex `from ["'].../(?:application|domain)/...["']`,
  tidak false-positive ke prose komentar yang backtick-quote path, bukan
  `from "..."` syntax). Gagal loud bila PR mana pun mengembalikan pola
  lama.

### Fungsi yang berubah signature — WAJIB baca sebelum menyentuh lagi

Setiap fungsi berikut sekarang menerima port sebagai parameter tambahan
(bukan lagi meng-import modul lain sendiri):

- `blog-content/application/news-media-reference-gate.ts`'s
  `validateNewsMediaReferencesForFullOnlineR2Mode(tx, tenantId, input,
mediaPort: NewsMediaPort, env?)` — parameter `mediaPort` baru sebelum
  `env`. `resolveVerifiedNewsMediaReferences` (fungsi render-time yang
  dulu ada di file ini) **DIHAPUS SELURUHNYA** — setiap pemanggil (route
  publik `blog_content` sendiri, homepage composer `news_portal`)
  sekarang memanggil `NewsMediaPort.resolveMediaReferences` LANGSUNG
  (adapter `newsMediaPortAdapter` dari `news-portal`), karena itu memang
  murni kapabilitas port itu sendiri, tidak ada lagi yang perlu
  ditambahkan file ini di atasnya.
- `news-portal/application/homepage-section-reference-validation.ts`'s
  `validateHomepageSectionReferences(tx, tenantId, sectionType, config,
contentPort: PublicContentPort)` — parameter `contentPort` baru di
  akhir. `mediaObjectIds` (`gallery_block`) TIDAK berubah — itu
  `news-media-object-directory.ts` milik modul ini SENDIRI, bukan
  cross-module.
- `news-portal/application/homepage-section-composer.ts`'s
  `composeHomepageSectionsHtml(tx, tenantId, basePath, contentPort:
PublicContentPort, mediaPort: NewsMediaPort, now?)` — DUA parameter
  port baru sebelum `now`.

Setiap route handler pemanggil (5 di `blog_content` untuk gate #636, 3 di
`news_portal` untuk composer/reference-validation #637, plus dua route
publik detail post) diperbarui untuk meng-import adapter konkret yang
relevan dan menyuntikkannya — lihat diff Issue #681/PR terkait untuk
daftar file lengkap kalau butuh contoh call-site persis.

### File yang dibuat/diubah/dihapus (referensi cepat)

- **Baru**: `src/modules/_shared/ports/news-media-port.ts`,
  `_shared/ports/public-content-port.ts`,
  `_shared/rendering/gallery-block-renderer.ts`,
  `news-portal/application/news-media-port-adapter.ts`,
  `blog-content/application/public-content-port-adapter.ts`,
  `tests/unit/module-boundary.test.ts`,
  `docs/adr/0011-capability-ports-for-cross-module-collaboration.md`.
- **Dihapus**: `blog-content/application/news-portal-r2-mode-gate.ts`
  (logika pindah ke `news-media-port-adapter.ts`, histori "tiga percobaan
  gagal" §636 dipindah verbatim).
- **Diubah**: `blog-content/application/news-media-reference-gate.ts`
  (terima `mediaPort`, `resolveVerifiedNewsMediaReferences` dihapus),
  `blog-content/domain/content-block-rendering.ts` (delegasi gallery ke
  shared renderer), `news-portal/application/homepage-section-composer.ts`,
  `news-portal/application/homepage-section-reference-validation.ts`,
  `news-portal/domain/homepage-section-rendering.ts` (semua terima
  port/pakai shared renderer), `_shared/module-contract.ts`
  (`capabilities` field baru), `blog-content/module.ts`,
  `news-portal/module.ts` (deklarasi `capabilities.provides/consumes`),
  10 route handler (5 blog_content create/update/restore, 2 route publik
  detail, 3 news_portal homepage-sections/`/news` index) — wiring adapter
  di composition root.

## §638 — R2-only advertisement placement presets (Selesai)

Implementasi lengkap: migration
`sql/049_awcms_mini_news_portal_ad_placements_schema.sql` (tabel BARU
`awcms_mini_news_portal_ad_placements`, RLS ENABLE+FORCE), domain
`news-portal/domain/ad-placement-policy.ts` (whitelist dua belas
`placementKey` persis dari body issue + preset metadata statis
`AD_PLACEMENT_PRESETS` + validator create/update) dan
`domain/ad-placement-rotation.ts` (`selectAdsForRotation`, murni, empat
mode rotasi), application `application/ad-placement-directory.ts` (CRUD
tenant-scoped + query render publik + renderer whitelist) dan
`application/ad-placement-reference-validation.ts` (verifikasi
`mediaObjectId`), endpoint admin `POST/GET /api/v1/news-portal/ad-placements`,
`PATCH/DELETE .../{id}`, dan admin UI
`admin/news-portal/ad-placements.astro`.

### Rekonsiliasi — tabel BARU di `news_portal`, BUKAN ekstensi `awcms_mini_blog_ads`

Body issue #638 menulis "blog_content already includes advertisement
capabilities" seolah issue ini memperluas `awcms_mini_blog_ads`/
`awcms_mini_blog_ad_placements` (`blog_content`, migration 029, Issue
#542) yang `image_url`-nya HARI INI masih URL http(s) bebas. TIDAK
diikuti — persis alasan migration 044 (#637) sudah dokumentasikan untuk
dilema yang sama: menambah validasi R2-only ke tabel generik itu akan
mematahkan tenant non-full-online-R2 yang sah memakai `awcms_mini_blog_ads`
dengan URL gambar eksternal biasa. Sebagai gantinya: tabel BARU dan
SEMPIT, `awcms_mini_news_portal_ad_placements`, dimiliki modul
`news_portal` (bukan `blog_content`) — pola identik
`awcms_mini_news_portal_homepage_sections` (#637): "tabel baru, nol baris
pra-eksisting, tidak perlu gerbang mode R2-only runtime" (lihat §637's
"Reference validation — TANPA GERBANG..." di atas, alasan yang SAMA
berlaku di sini). R2-only-ness berlaku BY CONSTRUCTION: kolom
`media_object_id` adalah FK nyata ke `awcms_mini_news_media_objects`, TIDAK
ADA kolom `image_url` bebas teks sama sekali pada tabel ini — beda dengan
`awcms_mini_blog_ads` yang tetap dipertahankan PERSIS seperti sebelumnya
(tidak disentuh issue ini) untuk tenant yang tidak memakai preset
full-online-R2.

Karena tabel ini hidup DI DALAM modul `news_portal` sendiri (bukan lintas
modul seperti gate #636's `blog_content`↔`news_portal`), validasi
`mediaObjectId` (`ad-placement-reference-validation.ts`) memanggil
`fetchNewsMediaObjectById`/`isNewsMediaObjectSafeForPublicReference`
(`news-media-object-directory.ts`, #633) LANGSUNG — TIDAK butuh
`_shared/ports/news-media-port.ts` (port #681) sama sekali, sama seperti
`homepage-section-reference-validation.ts`'s `mediaObjectIds`
(`gallery_block`) check. Ini PERSIS pola "verified-media-reference
validation" yang diminta prompt orchestrator untuk dipakai ulang dari
`content-block-media-references.ts`/`news-media-reference-gate.ts` (#636)
— bedanya hanya lapisan mana yang melakukan pengecekan existence+status
(di sini: application layer `news_portal` sendiri, bukan gate lintas
modul `blog_content`), bukan pola validasinya sendiri (predikat
`isNewsMediaObjectSafeForPublicReference` yang sama, dipanggil dengan
argumen yang sama).

### `placementKey` BUKAN immutable — kontras eksplisit dengan `sectionType` #637

`homepage-section-policy.ts`'s `sectionType` immutable setelah dibuat
karena `config_json` per tipe punya BENTUK BERBEDA (mengganti tipe berarti
config lama jadi sampah tak tervalidasi untuk tipe baru). Tabel ad
placement ini TIDAK punya masalah itu — SETIAP `placementKey` berbagi
BENTUK BARIS YANG SAMA PERSIS (`mediaObjectId` + `linkUrl` + jadwal +
knob rotasi), jadi mengizinkan admin memindahkan satu ad yang sudah ada
ke `placementKey` lain lewat PATCH tidak menciptakan bahaya bentuk data
apa pun — `validateUpdateAdPlacementInput` menerima `placementKey` sebagai
field biasa yang bisa diubah, dan endpoint PATCH me-re-validasi
`mediaObjectId` (existing atau baru) terhadap `allowedMediaTypes`
placement TARGET (baru atau lama) setiap kali salah satu dari keduanya
berubah.

### `recommended_size`/`allowed_media_types`/`max_items` — metadata preset statis di kode, BUKAN kolom tabel

Sesuai pola `homepage-section-policy.ts`'s `HomepageSectionType` whitelist
(bentuk config per tipe hidup di kode, DB hanya `CHECK`-constrain key-nya):
`AD_PLACEMENT_PRESETS` (`ad-placement-policy.ts`) adalah `Record` statis
memetakan setiap `placementKey` ke `{recommendedSize, allowedMediaTypes,
maxItems}` — bukan kolom di `awcms_mini_news_portal_ad_placements`.
Keputusan desain per field (mengikat implementor lanjutan yang menyentuh
whitelist ini):

- **`recommendedSize`** — ADVISORY UI saja (ditampilkan admin, bukan
  ditegakkan terhadap `width`/`height` media yang sebenarnya sudah
  terverifikasi). Menegakkan kecocokan piksel persis/mendekati berisiko
  menolak gambar yang sah tapi sudah di-crop berbeda, dan tidak diminta
  acceptance criteria issue.
- **`allowedMediaTypes`** — SEMUA dua belas preset hari ini berbagi set
  default yang SAMA (empat tipe raster yang sudah divalidasi pipeline
  upload R2 — SVG tetap dilarang, Keputusan kunci #5), jadi
  `validateAdPlacementMediaReference`'s pengecekan mime-per-placement
  SAAT INI redundan dengan jaminan pipeline upload — tetap diimplementasikan
  sebagai defense-in-depth nyata + teruji supaya placement MASA DEPAN bisa
  mempersempit allow-list-nya (mis. melarang GIF beranimasi di slot banner
  sempit) tanpa migration baru atau mekanisme validasi baru.
- **`maxItems`** — HANYA ditegakkan sebagai batas seleksi RENDER-TIME
  (`selectAdsForRotation` memotong hasil ke `maxItems`), BUKAN batas
  write-time jumlah baris yang boleh dikonfigurasi admin untuk satu
  `placementKey`. Admin boleh mengonfigurasi lebih banyak kandidat ad
  daripada `maxItems` (mis. sepuluh ad `header_banner` terjadwal di
  rentang tanggal berbeda); rotasi memilih subset yang tampil saat baca.

### Empat mode rotasi — pure function, `randomFn` injectable untuk test

`ad-placement-rotation.ts`'s `selectAdsForRotation(candidates, rotationMode,
maxItems, randomFn = Math.random)` — TIDAK ada I/O/`Bun.SQL`, sama pola
pemisahan "seleksi murni, keberadaan/keamanan diputuskan aplikasi"
`homepage-section-rendering.ts` pakai. `latest` (urut `createdAt DESC`),
`priority` (urut `priority DESC`, tie-break `createdAt DESC`, deterministik
— beda dari `weighted`), `random_safe` (Fisher-Yates shuffle, setiap
permutasi sama-rata mungkin), `weighted` (sampling tanpa pengembalian,
bobot = `priority + 1` — SENGAJA `+1`, bukan `priority` polos, supaya baris
`priority: 0` tetap punya peluang terpilih, tidak pernah terkunci permanen
kalau ada baris berprioritas lebih tinggi). `randomFn` yang bisa disuntik
BUKAN untuk keamanan (ini murni memutuskan urutan/subset tampilan dari ad
yang SUDAH diotorisasi tampil, bukan kontrol akses) — `Math.random` default
sudah tepat, tidak butuh `crypto.getRandomValues`.

### Safe link URL — predikat diduplikasi, BUKAN diimpor dari `blog_content`

`isSafeAdLinkUrl` (`ad-placement-policy.ts`) menerapkan aturan absolute
http(s) yang SAMA persis dengan `blog-content/domain/seo-validation.ts`'s
`isAbsoluteHttpUrl`/`ad-policy.ts` — SENGAJA diduplikasi sebagai literal
dua baris, BUKAN diimpor: `tests/unit/module-boundary.test.ts` (#681)
melarang file `domain`/`application` `news_portal` mengimpor tree
`domain`/`application` `blog_content` manapun. Predikat murni sekecil ini
lebih murah dipertahankan sinkron dengan mata daripada dilewatkan lewat
port lintas modul baru.

### Tidak perlu gerbang mode R2-only — R2-only berlaku by construction

Berbeda dari `blog_content`'s Issue #636 gate
(`isNewsPortalFullOnlineR2ModeActiveForTenant`, lewat `NewsMediaPort`),
validasi di sini TIDAK BERSYARAT sama sekali — tidak ada pengecekan
"apakah preset full-online-R2 aktif untuk tenant ini". Alasannya SAMA
dengan §637's homepage sections: tabel baru, nol baris warisan, jadi tidak
ada kekhawatiran kompatibilitas mundur yang memaksa perilaku lama tetap
jalan untuk tenant yang belum mengaktifkan preset R2-only.

### `ad_slot` homepage-section integration — TETAP di luar cakupan issue ini

§637's catatan menulis "setelah #638 selesai, `homepage-section-policy.ts`'s
whitelist WAJIB diperluas dengan `ad_slot`" — body issue #638 GitHub
sendiri TIDAK menyebut homepage composer/`ad_slot` sama sekali (scope-nya
murni preset placement iklan + validasi gambar R2-only). Menambah
`ad_slot` ke `homepage-section-policy.ts`/migration 044's `CHECK`
constraint sekarang akan melebarkan scope issue ini ke sistem lain
(composer #637) tanpa acceptance criteria yang memintanya — DITUNDA
sebagai pekerjaan lanjutan terpisah (belum ada issue yang mengklaimnya).
Implementor yang akhirnya mengerjakan integrasi itu punya semua yang
dibutuhkan sudah siap: `ad-placement-directory.ts`'s
`selectAndRenderActiveAdsForPlacement(tx, tenantId, placementKey, now?)`
mengembalikan array string HTML siap-render per placement, tinggal
dipanggil dari `homepage-section-composer.ts` untuk `sectionType:
"ad_slot"` yang config-nya berisi `placementKey`.

### Residual risk — `media_object_id` FK nyata vs. `purgeNewsMediaObject` masa depan

Berbeda dari `owner_resource_id` polymorphic (§633, sengaja tanpa FK),
`media_object_id` di tabel ini adalah FK nyata ke
`awcms_mini_news_media_objects` — pilihan sah karena tabel ini hidup DI
DALAM modul yang sama dengan registry-nya. Konsekuensi didokumentasikan di
header migration 049: `purgeNewsMediaObject` (hard DELETE, sudah ada sejak
#633, TAPI belum ada route yang memanggilnya sampai hari ini — diverifikasi
`src/pages/api/v1/media/news-images/` hanya berisi create/finalize/cancel
upload session) akan gagal dengan Postgres FK-violation mentah, bukan
409/422 aplikasi yang rapi, bila dipanggil terhadap media object yang masih
direferensikan baris di tabel ini. Laten, bukan bug aktif (tidak ada jalur
API yang bisa memicunya hari ini) — implementor issue yang akhirnya
menambah endpoint purge nyata WAJIB menangani constraint ini (tangkap error
atau precheck referensi) sebelum merilis endpoint itu.

### Rendering publik — query + renderer teruji, belum dipasang ke rute manapun

`listActiveAdPlacementsForRendering`/`renderAdPlacementHtml`/
`selectAndRenderActiveAdsForPlacement` (`ad-placement-directory.ts`) sudah
lengkap dan teruji end-to-end (lihat §Test di bawah) — TIDAK dipasang ke
`/news` atau rute publik manapun di issue ini, sama persis precedent
"tested public-safe helper, wiring is a later issue's job" yang
`ads-directory.ts`'s `listActiveAdsForPlacement`/`renderAdHtml` (#542)
sudah tetapkan lebih dulu, dan yang §637 secara eksplisit tunda untuk
`ad_slot`. Whitelist render `<img>`/`<a rel="sponsored noopener
noreferrer">` — tidak ada field embed/iframe/raw-HTML apa pun di skema
tabel ini, jadi rendering TIDAK BISA jadi kanal XSS apa pun isi request-nya
(sama argumen `ads-directory.ts`'s `renderAdHtml` §542 pakai).

### File yang dibuat/diubah (referensi cepat)

- `sql/049_awcms_mini_news_portal_ad_placements_schema.sql` (baru).
- `src/modules/news-portal/domain/ad-placement-policy.ts`,
  `domain/ad-placement-rotation.ts` (keduanya baru).
- `src/modules/news-portal/application/ad-placement-directory.ts`,
  `application/ad-placement-reference-validation.ts` (keduanya baru).
- `src/pages/api/v1/news-portal/ad-placements/index.ts` (create/list),
  `.../[id].ts` (update/delete) — baru.
- `src/pages/admin/news-portal/ad-placements.astro` — baru, pola sama
  `admin/news-portal/homepage-sections.astro` (form field datar, tanpa
  textarea JSON — setiap field di sini adalah skalar, bukan `config_json`
  berbentuk-bervariasi).
- Diperbarui: `src/modules/news-portal/module.ts` (permissions
  `ad_placements.{read,configure}`, navigation entry kedua, version
  0.3.0→0.4.0), `src/lib/i18n/error-messages.ts`
  (`AD_PLACEMENT_REFERENCE_INVALID`), `i18n/en.po`/`i18n/id.po`.
- `openapi/modules/news-portal-ad-placements.openapi.yaml` (fragment baru
  — lihat `openapi/README.md` untuk alur split-source; JANGAN edit
  `openapi/awcms-mini-public-api.openapi.yaml` langsung, itu file
  GENERATED oleh `bun run openapi:bundle`), tag baru di
  `awcms-mini-public-api.src.yaml`.
- Test: `tests/unit/ad-placement-policy.test.ts`,
  `tests/unit/ad-placement-rotation.test.ts`,
  `tests/integration/news-portal-ad-placements.integration.test.ts`
  (CRUD, validasi mediaObjectId tidak ada/tidak terverifikasi/cross-tenant,
  linkUrl tidak aman, RLS 404 lintas tenant, ABAC 403 tanpa permission,
  rendering publik hanya emit public URL registry, ad
  inactive/future/expired/placement-lain dikecualikan, media yang
  soft-delete setelah placement dibuat dikecualikan, rotasi memotong ke
  `maxItems`); diperbarui: `tests/foundation.test.ts` (migration list 049),
  `tests/modules/news-portal-module.test.ts` (navigation dua entri,
  permission pair `ad_placements` baru).
- Changeset: `.changeset/news-portal-ad-placements-issue-638.md`.

### Belum/di luar cakupan issue ini (untuk issue lanjutan)

- **Integrasi `ad_slot` ke homepage composer** (#637) — lihat subbagian di
  atas. Butuh menambah `ad_slot` ke `HOMEPAGE_SECTION_TYPES`/migration
  044's `CHECK` constraint DAN memanggil
  `selectAndRenderActiveAdsForPlacement` dari
  `homepage-section-composer.ts`.
- **Wiring rendering publik ke `/news`/halaman artikel** — query+renderer
  sudah ada dan teruji, belum dipasang ke rute publik manapun (sama
  precedent `awcms_mini_blog_ads` §542).
- **UI picker media visual** — admin tetap mengetik UUID `mediaObjectId`
  manual, sama gap yang dicatat `awcms-mini-blog-content`/§636/§637.
- **Click fraud detection** — eksplisit di luar cakupan per body issue.

## §649 — konsumsi media registry lanjutan (belum dikerjakan)

Ringkasan objective (detail lengkap ada di body issue GitHub, cek
`gh issue view 649` bila butuh acceptance criteria penuh). #638, #639,
#640, #642 sudah selesai — lihat §638/§639/§640/§642 masing-masing di
bawah untuk detailnya, tidak diulang di sini lagi.

- **#649** — SEO + social preview metadata lengkap (title/excerpt/
  canonical/gambar R2 terverifikasi) untuk crawler share. §642 di bawah
  sudah menambah irisan minimal `og:title`/`og:description`/`og:url`/
  `og:site_name` + `twitter:title`/`twitter:description`/`twitter:card`
  (selalu `summary`, naik ke `summary_large_image` saat ada gambar R2) —
  #649 kemungkinan menambah structured data (JSON-LD)/polish lebih lanjut,
  bukan membangun ulang dasar OG/Twitter yang sudah ada.

## §642 — Public social share buttons (Selesai)

Implementasi lengkap: domain baru
`src/modules/news-portal/domain/news-share-config.ts` (resolver env
`NEWS_SHARE_*`, pure),
`src/modules/blog-content/domain/social-share-links.ts` (link builder
allowlisted per platform + renderer HTML widget), script client statis
`public/js/news-share.js` (native share + copy-link, progressive
enhancement), dan perluasan
`src/modules/blog-content/domain/public-page-rendering.ts` (og:title/
og:description/og:url/og:site_name + twitter:title/twitter:description/
twitter:card selalu ada). **Tidak ada migration baru** — murni
UI/rendering/config, tidak ada data baru yang dipersist (highest migration
tetap `047` di saat issue ini dikerjakan; awasi nomor yang benar-benar
terbaru di `sql/` sebelum issue lanjutan menambah migration, karena issue
lain di epic yang sama bisa jalan paralel).

### Kenapa config resolver di `news-portal`, tapi link-builder+renderer di `blog-content`

`NEWS_SHARE_*` env var **dimiliki** modul `news-portal` (konvensi
CONFIG_REGISTRY: prefix `NEWS_` = `ownerModule: "news-portal"`, sama
seperti `NEWS_PORTAL_ENABLED`/`NEWS_MEDIA_R2_*`) — jadi resolver env
(`resolveNewsShareConfig`) hidup di sana. Tapi fungsi murni yang membangun
URL share per platform + merender widget HTML
(`buildSocialShareLinks`/`renderSocialShareButtonsHtml`) hidup di
`blog-content` karena beroperasi pada konsep `blog_content` murni
(title/excerpt/canonical URL post) dan dipanggil dari route yang sama
(`/news/[slug].ts`, `/blog/[tenantCode]/[slug].ts`) yang sudah merender
`seo-rendering.ts`/`public-page-rendering.ts` — TIDAK ada dependency
fungsional ke media registry R2 sama sekali untuk fitur ini (beda dari
#636). `SocialShareRenderConfig` (di `blog-content`) sengaja punya field
yang sama persis dengan `NewsShareConfig` (di `news-portal`) TANPA
cross-module import — struktural TypeScript cukup, route (composition
root) yang memanggil keduanya langsung, sama pola "route mengimpor dari
dua modul sekaligus" yang sudah ada (`[slug].ts` sudah mengimpor
`newsMediaPortAdapter` dari `news-portal/application/` langsung sebelum
issue ini).

### Instagram — TIDAK ada tombol/URL, hanya catatan teks

Tidak ada URL web-share Instagram yang didukung untuk sharing dari URL
eksternal sembarang (beda dari WhatsApp/Telegram/Facebook/LinkedIn/X yang
semuanya punya endpoint share-intent resmi) — jadi `STATIC_SHARE_LINK_BUILDERS`
di `social-share-links.ts` TIDAK PERNAH punya entry Instagram.
`NEWS_SHARE_INSTAGRAM_NATIVE_ONLY` (default `true`) hanya menggerbang
sebuah catatan teks statis di dekat tombol native-share, menjelaskan
Instagram dibagikan lewat native share (`navigator.share`, saat OS
menampilkannya sebagai target) atau copy-link — tidak pernah membangun
tombol/URL baru untuk itu. Test `social-share-links.test.ts`'s "never
emits a fake Instagram share link/button" menegakkan ini secara eksplisit
(grep `instagram.com`/`news-share__link--instagram` tidak pernah ada di
output manapun).

### Canonical URL, bukan querystring — dijamin struktural, bukan filter

Setiap link/atribut `data-share-url` dibangun HANYA dari `canonicalUrl`
yang sudah di-resolve `resolveCanonicalUrl` (server-side, dari
`url.origin` + slug post) — tidak pernah dari `request.url`/`Astro.url`
mentah. Karena `canonicalUrl` server-generated tidak pernah membawa
querystring/tracking parameter/session id sama sekali, syarat issue "do
not leak admin preview URLs, draft URLs, session IDs, or private query
parameters" terpenuhi secara struktural (nilai itu memang tidak pernah
ada di sana), bukan oleh sebuah filter yang bisa lupa memfilter sesuatu.
Test integrasi membuktikan ini dengan memanggil route dengan
`?utm_source=newsletter&session_id=abc123` di URL request dan menegaskan
tidak satupun string itu muncul di respons.

### Script client — file statis same-origin, BUKAN inline (CSP)

`native_web_share`/`copy_link` butuh JS (Web Share API, Clipboard API) —
semua platform lain adalah `<a href>` statis tanpa JS sama sekali.
`public/js/news-share.js` dimuat via `<script src="/js/news-share.js"
defer>` (same-origin, `public/` Astro default) — **bukan** `<script>`
inline. Ini sengaja menghindari seluruh kerumitan CSP hash/nonce yang
`astro.config.mjs`/`theme-init-script.ts` sudah dokumentasikan
(Astro's `security.csp` hanya meng-hash script yang **ia proses**
sendiri — script yang dirender lewat `.ts` API route seperti
`/news/[slug].ts` bukan `.astro` component, jadi TIDAK pernah lewat
pipeline hashing Astro sama sekali; sebuah `<script>` inline di sini
berisiko diblokir CSP browser nyata tanpa test headless-Chrome yang bisa
mendeteksinya lewat `curl`). `script-src 'self'` (default Astro) sudah
cukup untuk file statis same-origin — nol entri hash baru diperlukan.
Tombol native-share dirender `hidden` di server, hanya di-unhide oleh
script ini setelah deteksi fitur nyata (`window.isSecureContext &&
navigator.share`) — issue: "native share uses `navigator.share` only
after user activation and only in secure context." Tidak ada dependency
eksternal, tidak ada `fetch`/`import` ke origin manapun selain halaman itu
sendiri — `tests/unit/news-share-client-script.test.ts` menegaskan tidak
ada string `http(s)://` eksternal apa pun di file ini.

### Konfigurasi — semua flag default `true`, deviasi sengaja dari kebiasaan repo

Setiap flag `NEWS_SHARE_*` default `true` (lihat header comment
`news-share-config.ts` untuk alasan lengkap) — berbeda dari kebiasaan
"opt-in, default off" var lain di repo ini (`NEWS_PORTAL_ENABLED`,
`VISITOR_ANALYTICS_ENABLED`, dst.) karena fitur ini tidak mengumpulkan
data/memuat script eksternal/butuh kredensial apa pun untuk diaktifkan.
Tidak ada flag terpisah untuk copy-link (selalu ada begitu
`NEWS_SHARE_BUTTONS_ENABLED=true`) — body issue #642 tidak
menyarankannya, dan copy-link adalah fallback universal yang seharusnya
selalu tersedia.

### Meta tag OG/Twitter — perluasan `renderPublicPageShell`, bukan fungsi baru

`og:title`/`og:description`/`og:url` + `twitter:title`/
`twitter:description` diturunkan dari field `title`/`description`/
`canonicalUrl` yang SUDAH ada di `PublicPageShellOptions` (satu sumber
kebenaran per field — tidak ada kolom kedua yang bisa drift).
`twitter:card` sekarang SELALU dirender (`summary` tanpa gambar,
`summary_large_image` dengan `og:image` — beda dari sebelum issue ini,
yang meng-omit `twitter:card` sama sekali tanpa gambar). `og:image`/
`twitter:image`/`og:image:alt` TIDAK berubah — tetap gerbang R2-only
Issue #636 (`resolveOgImageUrl`, hanya media `verified`/`attached`).
`og:site_name` baru, opsional, dari `PublicTenantResolution.tenantName` —
diteruskan kedua route (`/news/[slug].ts`, `/blog/[tenantCode]/[slug].ts`)
tanpa lookup tambahan (tenant sudah di-resolve untuk gerbang tenant/module
yang sudah ada).

### File yang dibuat/diubah (referensi cepat)

- `src/modules/news-portal/domain/news-share-config.ts` (baru).
- `src/modules/blog-content/domain/social-share-links.ts` (baru).
- `public/js/news-share.js` (baru).
- `src/modules/blog-content/domain/public-page-rendering.ts`: `PublicPageShellOptions`
  gains `siteName`; `renderOpenGraphMetaTags` baru (og:title/description/
  url/site_name + twitter:title/description/card selalu ada).
- `src/pages/news/[slug].ts`, `src/pages/blog/[tenantCode]/[slug].ts`:
  panggil `resolveNewsShareConfig()` + `renderSocialShareButtonsHtml`,
  teruskan `siteName: tenant.tenantName` ke shell.
- `src/lib/config/registry.ts`: sembilan entri `NEWS_SHARE_*` baru
  (`ownerModule: "news-portal"`, `profiles: ALL_PROFILES`, semua
  default `"true"`).
- `.env.example`, `18_configuration_env_reference.md` §News portal —
  public social share buttons (tabel + fenced block ringkas).
- Test: `tests/unit/news-share-config.test.ts`,
  `tests/unit/social-share-links.test.ts`,
  `tests/unit/news-share-client-script.test.ts`,
  `tests/integration/news-portal-share-buttons.integration.test.ts`;
  diperbarui: `tests/blog-content-public-rendering.test.ts` (og:title/
  description/url/site_name/twitter:card selalu ada).
- Changeset: `.changeset/news-portal-social-share-buttons-issue-642.md`.

## §640 — Content quality checklist publishing dengan syarat gambar R2 (Selesai)

Implementasi lengkap: domain `blog-content/domain/content-quality-checklist.ts`
(17 rule murni, tiga severity `blocking`/`warning`/`info`, lima rule
security non-overridable), application
`blog-content/application/content-quality-checklist-gate.ts` (orkestrasi
DB/port), diwire ke `POST /api/v1/blog/posts/{id}/publish`,
`POST /api/v1/blog/posts/{id}/schedule`, `blog-scheduled-publish.ts`'s
`publishDueScheduledPosts` (Issue #541), dan dua endpoint preview baru
`GET /api/v1/blog/posts/{id}/quality-checklist` /
`GET /api/v1/blog/pages/{id}/quality-checklist`. **Tidak ada migration
baru** — kebijakan override tenant disimpan di kolom catch-all
`awcms_mini_blog_settings.settings` (Issue #543) yang sudah ada, bukan
tabel baru.

### Gate tunggal — mengikuti persis pola mode-gate #636, BUKAN blanket tightening ke seluruh `blog_content`

Seluruh checklist (bukan cuma rule R2) adalah SATU no-op ketika full-online
R2-only mode tidak aktif untuk tenant pemanggil
(`mediaPort.isFullOnlineR2ModeActiveForTenant`) — publish/schedule tenant
`blog_content`-only (mayoritas tenant hari ini) berperilaku identik sebelum
issue ini, byte-for-byte. Ini keputusan sengaja, bukan kealpaan: memaksa
rule editorial baru (meta description hilang, taxonomy kosong, dst) jadi
warning/blocking untuk SEMUA tenant `blog_content` — termasuk yang tidak
pernah mengaktifkan `news_portal` — akan menjadi "blanket tightening"
persis pola kesalahan yang epic ini berulang kali dokumentasikan untuk
dihindari (lihat §636's prinsip yang sama). `applicable: false` pada
`ContentQualityChecklistResult` adalah sinyal itu.

### Reuse — SATU pemanggilan mediaPort.resolveMediaReferences, bukan re-derive verifikasi R2

`content-quality-checklist-gate.ts` memanggil
`collectGalleryImageReferences` (domain #636, TIDAK diubah traversal-nya)
dan `NewsMediaPort.resolveMediaReferences` (adapter #681,
`news-portal/application/news-media-port-adapter.ts`) — SATU bulk lookup
untuk featured image + semua gallery mediaObjectId, PERSIS primitif yang
#636 sudah bangun. Checklist TIDAK memanggil registry/DB `news_portal`
sendiri secara langsung dan TIDAK re-implement query "apakah media ini
verified/attached" — itu sudah jadi tanggung jawab
`isNewsMediaObjectSafeForPublicReference` di balik port, dipanggil satu
tempat (`news-media-port-adapter.ts`).

### Perubahan aditif ke file yang di-flag berbagi dengan Issue #639 (video block, dikerjakan paralel)

Dua file yang disebut eksplisit berisiko konflik dengan #639 disentuh
MINIMAL dan aditif murni:

- `blog-content/domain/content-block-media-references.ts` —
  `GalleryImageReferenceViolation` dapat field opsional baru `rawUrl?:
string` (diisi hanya untuk `reason: "raw_url_not_allowed"`), supaya
  checklist bisa mengklasifikasi local-path vs external-url TANPA
  traversal kedua atas `contentJson` (lihat file itu sendiri untuk
  alasan "satu traversal, jangan drift"). TIDAK ada perubahan pada
  `mediaType: "video"` (tetap di luar cakupan, scope #639), TIDAK ada
  perubahan pada urutan/isi array `violations` untuk consumer lama
  (`news-media-reference-gate.ts`'s `violationMessage` hanya baca
  `itemIndex`/`reason`, tidak terpengaruh field baru).
- `content-block-rendering.ts` — **TIDAK disentuh sama sekali** oleh
  issue ini (rendering bukan concern checklist — checklist hanya
  membaca `contentJson`/registry, tidak pernah merender HTML).

`_shared/ports/news-media-port.ts` juga diperluas aditif:
`ResolvedNewsMediaReferenceDTO` dapat empat field metadata baru
(`mimeType`, `width`, `height`, `sizeBytes`) di samping `publicUrl`/
`altText` yang sudah ada — setiap consumer lama (homepage composer,
render-time gallery/og:image resolution) tetap hanya membaca dua field
lama, tidak terpengaruh.

### Klasifikasi "featured image MIME/size" — tidak re-derive policy config, murni laporan metadata terverifikasi

`featured_image_mime_allowed`/`featured_image_size_within_policy` TIDAK
membaca `NEWS_MEDIA_R2_ALLOWED_MIME_TYPES`/`NEWS_MEDIA_R2_MAX_UPLOAD_BYTES`
(itu akan jadi cross-module coupling baru ke config domain `news_portal`,
dilarang `module-boundary.test.ts`). Sebagai gantinya: SETIAP objek yang
mencapai status `verified`/`attached` SUDAH PASTI lolos sniffing MIME
raster (empat tipe) dan byte-cap saat upload (Issue #634) — jadi kedua
rule ini melaporkan metadata yang SUDAH terverifikasi (nilai `mimeType`/
`sizeBytes` sungguhan dari registry), bukan mengulang keputusan
allow/deny. Severity `info`, tidak overridable (tidak ada yang perlu
di-override — rule ini secara struktural tidak bisa gagal untuk objek
verified).

### Lima rule security — TIDAK BISA di-downgrade tenant policy, di environment manapun (lebih ketat dari permintaan literal issue)

`SECURITY_RULE_IDS` (`unsafe_html_rejected`, `no_local_image_path`,
`no_external_image_url`, `featured_image_verified_r2`,
`gallery_images_verified`) menolak override APA PUN, tanpa cabang
`APP_ENV`. Issue #640's security notes hanya minta "tidak boleh
di-downgrade DI PRODUKSI" — implementasi ini SENGAJA lebih ketat
(menolak universal) karena itu trivially memenuhi syarat literalnya
tanpa menambah percabangan env baru yang berisiko jadi footgun untuk
staging yang mirror data produksi. `resolveSeverity` (domain) menolak
override untuk id di luar `OVERRIDABLE_RULE_IDS` secara runtime —
independen dari `blog-settings-policy.ts`'s validasi write-time (dua
lapis, bukan satu titik kegagalan, sama pelajaran §636's restore-revision
bypass).

### Kebijakan tenant — disimpan di `awcms_mini_blog_settings.settings`, BUKAN mekanisme baru

`contentQualityChecklistPolicy` (map rule id overridable -> severity)
hidup di kolom catch-all `settings jsonb` milik `awcms_mini_blog_settings`
(Issue #543, sudah tenant-writable via `PATCH /api/v1/blog/settings`,
permission `blog_content.settings.configure`). Ini BUKAN pola anti-pattern
§636 ("jangan taruh sinyal security di mekanisme generic-writable") —
lima rule security di atas TIDAK PERNAH dibaca dari blob ini sama sekali
(hard-coded di `content-quality-checklist.ts`), jadi tidak ada bypass
yang mungkin lewat sini walau kolomnya generic-writable. `validateUpdateBlogSettingsInput`
menolak (400) key yang bukan `OVERRIDABLE_RULE_IDS` atau severity yang
tidak valid — termasuk percobaan menaruh rule security di sana.

### Scheduled-publish worker — direstrukturisasi dari bulk UPDATE ke loop per-post

`publishDueScheduledPosts` (Issue #541) sebelumnya satu `UPDATE ...
RETURNING` set-based. Issue ini merestrukturisasi jadi `SELECT ... FOR
UPDATE` lalu loop per-post: setiap post due dievaluasi checklist-nya
sendiri; yang gagal DIBIARKAN `scheduled` (bukan silently published, bukan
di-unschedule) + audit event `blog.post.scheduled_publish_blocked`; yang
lolos baru di-`UPDATE` satu-per-satu ke `published`. Alasan: tanpa ini,
tenant bisa bypass checklist sepenuhnya dengan men-schedule post SEBELUM
mengaktifkan mode R2-only (atau sebelum media diverifikasi ulang), lalu
menunggu due — celah kelas yang sama dengan §636's restore-revision
bypass. `mediaPort` sekarang parameter WAJIB fungsi ini (disuntik
`scripts/blog-scheduled-publish.ts` sebagai composition root) — signature
lama `(sql, tenantId, options?)` berubah jadi `(sql, tenantId, mediaPort,
options?)`, breaking change untuk pemanggil manapun.

### Response envelope — `qualityChecklist` field aditif, `error.details` tetap `ErrorDetail[]`

Response sukses `publish`/`schedule` (200) memakai pola PERSIS yang
`termIds` sudah pakai di `BlogPostItem` (Issue #539: "hanya field
opsional yang sebagian endpoint isi") — `ok({ ...updated, qualityChecklist
})`, TIDAK membungkus `data` dalam wrapper baru. Response blocked (422,
kode `CONTENT_QUALITY_CHECKLIST_BLOCKED`) memetakan setiap blocker ke
`{ field: ruleId, message }` — bentuk `ErrorDetail` yang SUDAH ADA
(dipakai `VALIDATION_ERROR`/`NEWS_MEDIA_REFERENCE_INVALID`), BUKAN objek
checklist penuh di `error.details` (yang butuh perubahan skema `ApiError`
shared) — checklist lengkap (termasuk warning/info) tetap didapat lewat
endpoint preview `GET .../quality-checklist`.

### Halaman (`blog_content` pages) — preview-only, TIDAK ada endpoint publish/schedule untuk pages sama sekali

`GET /api/v1/blog/pages/{id}/quality-checklist` ada (memenuhi "Checklist
tersedia di admin post/page editor"), tapi TIDAK ADA `POST
/api/v1/blog/pages/{id}/publish`/`.../schedule` di codebase ini — pages
dibuat langsung `status='draft'` tanpa rute transisi lifecycle apa pun
(gap pra-eksisting, bukan sesuatu issue ini perbaiki, di luar scope atomic
issue ini). `taxonomy_exists` selalu `applicable: false` untuk pages
(tidak ada tabel `_terms` untuk pages, beda dari
`awcms_mini_blog_post_terms` milik posts).

### File yang dibuat/diubah (referensi cepat)

- **Baru**: `src/modules/blog-content/domain/content-quality-checklist.ts`,
  `src/modules/blog-content/application/content-quality-checklist-gate.ts`,
  `src/pages/api/v1/blog/posts/[id]/quality-checklist.ts`,
  `src/pages/api/v1/blog/pages/[id]/quality-checklist.ts`.
- **Diubah (aditif)**: `src/modules/_shared/ports/news-media-port.ts`
  (`ResolvedNewsMediaReferenceDTO` metadata baru),
  `src/modules/news-portal/application/news-media-port-adapter.ts`
  (mengisi metadata baru), `src/modules/blog-content/domain/content-block-media-references.ts`
  (`rawUrl` opsional pada violation), `src/modules/blog-content/domain/blog-settings-policy.ts`
  - `application/blog-settings-directory.ts` (`contentQualityChecklistPolicy`),
    `src/pages/api/v1/blog/posts/[id]/publish.ts`, `.../schedule.ts` (gate +
    audit + `qualityChecklist` di response), `src/modules/blog-content/application/blog-scheduled-publish.ts`
  - `scripts/blog-scheduled-publish.ts` (restrukturisasi per-post + inject
    `mediaPort`).
- `openapi/awcms-mini-public-api.src.yaml` (`ContentQualityChecklistResult`/
  `ContentQualityChecklistRuleOutcome` schema baru, `BlogPostItem.qualityChecklist`),
  `openapi/modules/blog-posts.openapi.yaml` (422 baru di publish/schedule,
  path `quality-checklist` baru), `openapi/modules/blog-pages.openapi.yaml`
  (path `quality-checklist` baru), `openapi/modules/blog-settings.openapi.yaml`
  (`ContentQualityChecklistPolicy` schema baru).
- `src/lib/i18n/error-messages.ts` (`CONTENT_QUALITY_CHECKLIST_BLOCKED`),
  `i18n/en.po`/`i18n/id.po` (error string + admin UI checklist panel +
  settings policy field strings).
- Admin UI: `src/pages/admin/blog/posts/[id].astro` (panel checklist baru),
  `src/pages/admin/blog/pages/[id].astro` (panel checklist baru, read-only),
  `src/pages/admin/blog/settings.astro` (textarea JSON kebijakan
  checklist).
- Test: `tests/unit/content-quality-checklist.test.ts`,
  `tests/unit/content-quality-checklist-gate.test.ts`,
  `tests/unit/blog-settings-policy.test.ts` (baru — scoped ke field baru
  saja), `tests/integration/blog-content-quality-checklist.integration.test.ts`
  (baru); diperbarui: `tests/unit/content-block-media-references.test.ts`
  (assert `rawUrl` baru), `tests/integration/blog-content-scheduled-publish.integration.test.ts`
  (signature `publishDueScheduledPosts` baru butuh `mediaPort`).
- Changeset: `.changeset/blog-content-quality-checklist-issue-640.md`.
- **Tidak ada migration baru** — lihat "Gate tunggal"/"Kebijakan tenant" di
  atas untuk alasan.

## §641 — Automatic internal tag linking (Selesai)

Implementasi lengkap: domain `blog-content/domain/internal-tag-linking.ts`
(matching engine murni + transform HTML berbasis `HTMLRewriter` bawaan
Bun), `domain/internal-tag-linking-config.ts` (resolver enam env var
`BLOG_AUTO_INTERNAL_TAG_LINKS_*`), `domain/internal-tag-linking-policy.ts`
(validator kebijakan tenant), aplikasi
`application/internal-tag-link-settings-directory.ts` (tabel khusus
tenant policy) + `application/internal-tag-link-rendering.ts` (orkestrasi
dipakai render publik DAN endpoint preview). Migration
`sql/050_awcms_mini_blog_content_internal_tag_links_schema.sql` (kolom
`auto_internal_tag_links_disabled` di `awcms_mini_blog_posts` + tabel baru
`awcms_mini_blog_internal_tag_link_settings`) dan
`sql/051_awcms_mini_blog_content_internal_tag_links_permissions.sql`
(permission `blog_content.internal_links.{read,configure,preview}`).
**Tidak terkait R2/media** secara langsung — item ini ada di epic yang
sama karena sama-sama bagian pengalaman editorial `news_portal`, tidak
bergantung pada Keputusan kunci #1-#5 di atas. Fitur hidup di modul
`blog_content` (bukan `news_portal`) karena harus generik untuk SEMUA
konsumen `blog_content`, bukan hanya tenant full-online-R2 — dibuktikan
dengan pemasangannya di KEDUA route publik (`/news/{slug}` DAN
`/blog/{tenantCode}/{slug}`), bukan hanya salah satu.

### Keputusan kunci — HTML tree parsing via Bun `HTMLRewriter`, bukan regex atas string mentah

Security notes issue #641 eksplisit melarang "naive string replacement
on raw HTML without parsing/sanitization." Implementasi memakai
`HTMLRewriter` bawaan Bun (built-in global, sama API dengan Cloudflare
Workers, TIDAK butuh dependency baru — konsisten aturan Bun-only) untuk
benar-benar berjalan di pohon elemen: sebuah `skipDepth` counter
di-increment saat masuk elemen dalam daftar kecualikan (`a`, `script`,
`style`, `code`, `pre`, `kbd`, `samp`, `textarea`, `noscript`,
`figcaption`, `iframe`, `object`, `embed`, `video`, `audio`, `template`,
`math`, `svg`, plus `h1`-`h6` bila `excludeHeadings=true`) dan
di-decrement tepat di `el.onEndTag()` elemen yang SAMA — teks yang
ditemukan selagi `skipDepth > 0` tidak pernah diperiksa sama sekali,
berapa pun dalam nested-nya. Regex HANYA dipakai pada teks yang SUDAH
diisolasi parser sebagai node teks aman (bukan pada string HTML mentah),
prinsip yang sama dengan whitelist renderer `content-block-rendering.ts`.
Dibuktikan empiris (skrip prototipe manual) SEBELUM kode final ditulis —
lihat unit test `tests/unit/internal-tag-linking.test.ts` untuk 25 skenario
tervalidasi termasuk existing-anchor/code/script/figcaption/embed/heading
exclusion dan dua kasus XSS (nama tag mengandung karakter HTML-special,
dan konten yang sudah berisi teks `&lt;script&gt;` ter-escape tidak pernah
diinterpretasi ulang sebagai markup).

### Matching — teks dicocokkan dalam domain ter-escape, tidak pernah didekode

`HTMLRewriter`'s `text()` callback mengembalikan teks level-SOURCE
(sudah di-HTML-entity-encode, `&` tetap `&amp;`), bukan versi ter-decode.
Alih-alih mendekode teks (rawan bug double-escape), setiap nama tag
kandidat di-`escapeHtml()` dengan fungsi PERSIS yang sama dipakai
renderer, sehingga matching seluruhnya terjadi dalam domain yang sudah
ter-escape — tag bernama `Q&A` cocok terhadap teks sumber `Q&amp;A`
(diverifikasi test). Substring yang cocok dipakai apa adanya sebagai teks
anchor, sehingga markup yang dihasilkan selalu well-formed.

### Word boundary — Unicode-aware, bukan `\b` biasa

Pattern regex pakai lookaround `(?<![\p{L}\p{N}_])...(?![\p{L}\p{N}_])`
dengan flag `u` — mencegah tag "makan" cocok sebagai substring di dalam
kata Indonesia yang lebih besar berbagi akar yang sama ("memakan",
"makanan"), sambil tetap mencocokkan kemunculan berdiri sendiri.
Kandidat diurutkan terpanjang-lebih-dulu (berdasarkan panjang bentuk
ter-escape) sebelum digabung jadi satu regex alternation — JS regex
alternation memilih alternatif PERTAMA yang cocok pada posisi yang sama,
bukan yang terpanjang, jadi urutan inilah yang membuat "match terpanjang
menang" benar (tag "Jakarta Selatan" dipilih di atas "Jakarta" pada
posisi yang sama).

### Dua level cap — `maxPerTag`/`linkFirstOccurrenceOnly` dan `maxPerPost`

`linkFirstOccurrenceOnly=true` (default) secara efektif menyamakan
`maxPerTag` ke 1 (`effectiveMaxPerTag = linkFirstOccurrenceOnly ? 1 :
max(1, maxPerTag)`), memenuhi "Avoid duplicate links to the same tag in
one post unless configured" — menaikkan `maxPerTag` DAN mematikan
`linkFirstOccurrenceOnly` memungkinkan lebih dari satu link ke tag yang
sama. `maxPerPost` adalah plafon GLOBAL lintas semua tag dalam satu
dokumen, ditegakkan lewat counter stateful yang persisten sepanjang
seluruh dokumen (bukan per text-node) — dijamin oleh
`createInternalTagLinkEngine`'s closure yang dipanggil berulang oleh
`HTMLRewriter` per node teks, dalam document order.

### Kebijakan tenant — tabel KHUSUS, BUKAN `awcms_mini_blog_settings.settings` seperti Issue #640

Berbeda dari `contentQualityChecklistPolicy` (#640) yang aman ditaruh di
kolom catch-all `awcms_mini_blog_settings.settings` karena
`upsertBlogSettings` sudah di-update untuk ikut me-round-trip key baru
itu — kebijakan issue ini (`enabled`/`caseInsensitive`/`disabledTagIds`)
SENGAJA memakai tabel baru `awcms_mini_blog_internal_tag_link_settings`
(migration 050), satu baris per tenant, pola sama
`awcms_mini_blog_theme_settings` (migration 029). Alasan: `settings`
adalah kolom catch-all yang di-**overwrite utuh** oleh `upsertBlogSettings`
dari daftar key eksplisit (`extras` object) — key BARU yang tidak
ditambahkan ke daftar itu akan DIAM-DIAM HILANG setiap kali admin
memperbarui setting blog lain apa pun via `PATCH /api/v1/blog/settings`,
kecuali file itu ikut disentuh. Tabel khusus menghindari keterikatan ini
sepenuhnya, dan cocok dengan permintaan eksplisit issue akan permission
terpisah (`blog_content.internal_links.*`, BUKAN `blog_content.settings.*`)
— endpoint (`GET`/`PATCH /api/v1/blog/internal-tag-links/settings`)
dan directory (`internal-tag-link-settings-directory.ts`) juga terpisah
total dari `blog-settings-directory.ts`, tidak ada write path ganda.

### Bun.SQL tidak auto-deserialize kolom array Postgres — jebakan nyata ditemukan saat integration test

`disabled_tag_ids uuid[]` yang dibaca lewat `Bun.SQL` kembali sebagai
STRING literal wire-format `"{uuid1,uuid2}"` (`typeof === "string"`),
BUKAN array JS ter-parse — diverifikasi empiris lewat skrip test manual
sebelum menuduh integration test yang salah. Tanpa parsing eksplisit,
`[...rawString]` di kode lama akan diam-diam men-spread STRING itu jadi
array karakter individual (bug nyata yang sempat lolos ke integration
test pertama kali dijalankan). `parsePostgresUuidArray` di
`internal-tag-link-settings-directory.ts` menangani ini — aman khusus
untuk UUID (tidak ada koma/kurung-kurawal/kutip yang perlu di-escape di
dalam satu elemen). **Catatan untuk implementor lanjutan**: bila
menambah kolom `xxx[]` baru di tabel manapun di repo ini, JANGAN
berasumsi Bun.SQL mem-parse-nya otomatis — verifikasi empiris dulu
(lihat `awcms-mini-coder` prompt/skill terkait bila perlu menambah
catatan ini ke referensi umum non-epic-specific).

### `POST /setup/initialize` adalah singleton sekali-per-database — bukan per-tenant

Ditemukan (ulang) saat menulis test cross-tenant: `POST
/api/v1/setup/initialize` menolak (403 "Setup has already been
completed") panggilan KEDUA dalam SATU proses database, bahkan untuk
`tenantCode` yang berbeda — jadi tidak bisa dipanggil dua kali dalam SATU
test case untuk mem-bootstrap dua tenant. Pola yang benar (sudah dipakai
`blog-content-admin-ui.integration.test.ts`/
`blog-content-public-news.integration.test.ts` sebelumnya, direplikasi di
sini sebagai `provisionSecondTenant`): sisipkan tenant KEDUA langsung via
raw SQL admin client (`awcms_mini_tenants`/`awcms_mini_profiles`/
`awcms_mini_identities`/`awcms_mini_tenant_users`/`awcms_mini_roles`/
`awcms_mini_role_permissions`/`awcms_mini_access_assignments`), lalu login
biasa. Untuk skenario yang butuh tenant kedua benar-benar RESOLVABLE lewat
`/news` (bukan cuma API tenant-scoped biasa), tambahkan
`PUBLIC_TENANT_RESOLUTION_MODE=env_default` +
`PUBLIC_DEFAULT_TENANT_ID=<tenantB>` sementara (pola sama
`blog-content-public-news.integration.test.ts`'s cross-tenant test).

### Permission baru — `preview` ditambahkan ke `AccessAction` union

`identity-access/domain/access-control.ts`'s `AccessAction` union
mendapat anggota baru `"preview"` (dipakai HANYA oleh
`blog_content.internal_links.preview`) — mengikuti persis precedent
`verify`/`set_primary` (Issue #562): seed permission dulu, tambah action
ke union saat endpoint nyata membutuhkannya. Tidak dimasukkan ke
`HIGH_RISK_ACTIONS` (read-only, tidak destruktif).

### Rendering wiring — kedua route publik post-detail, bukan hanya `/news`

`renderContentHtmlWithInternalTagLinks` dipanggil di KEDUA
`src/pages/news/[slug].ts` DAN `src/pages/blog/[tenantCode]/[slug].ts`,
tepat setelah `renderContentJsonToHtml` menghasilkan HTML aman dan
sebelum dibungkus `bodyHtml` — basePath tag archive berbeda per route
(`routeSettings.publicBasePath` vs `/blog/${tenantCode}`), tapi orkestrasi
resolusi kebijakan/kandidat SAMA (satu fungsi aplikasi, tidak
diduplikasi). Preview endpoint (`GET /api/v1/blog/posts/{id}/internal-links/preview`)
memakai fungsi orkestrasi yang SAMA (`previewInternalTagLinksForContent`)
supaya "kandidat tag mana yang layak, kebijakan efektif apa" tidak pernah
drift antara render time dan preview time.

### File yang dibuat/diubah (referensi cepat)

- `sql/050_awcms_mini_blog_content_internal_tag_links_schema.sql`,
  `sql/051_awcms_mini_blog_content_internal_tag_links_permissions.sql`.
- `src/modules/blog-content/domain/internal-tag-linking.ts`,
  `domain/internal-tag-linking-config.ts`,
  `domain/internal-tag-linking-policy.ts`;
  `application/internal-tag-link-settings-directory.ts`,
  `application/internal-tag-link-rendering.ts`.
- Diperbarui (aditif): `src/modules/identity-access/domain/access-control.ts`
  (`"preview"` action), `src/modules/blog-content/module.ts` (permissions
  `internal_links.*`, event baru, versi 0.8.0→0.9.0),
  `src/modules/blog-content/application/blog-post-directory.ts`/
  `domain/blog-post-validation.ts`/`application/public-blog-directory.ts`
  (`autoInternalTagLinksDisabled`), `src/pages/news/[slug].ts`,
  `src/pages/blog/[tenantCode]/[slug].ts` (wiring render).
- `src/pages/api/v1/blog/internal-tag-links/settings.ts` (GET/PATCH),
  `src/pages/api/v1/blog/posts/[id]/internal-links/preview.ts` (GET).
- Admin UI: `src/pages/admin/blog/internal-tag-links.astro` (baru),
  `src/pages/admin/blog/posts/[id].astro` (checkbox per-post + panel
  preview), `src/pages/admin/blog/index.astro` (quick link baru).
- `openapi/modules/blog-internal-tag-links.openapi.yaml` (baru),
  `openapi/awcms-mini-public-api.src.yaml` (`BlogPostItem.
autoInternalTagLinksDisabled`, tag baru), `openapi/modules/blog-posts.openapi.yaml`
  (field request baru), `asyncapi/awcms-mini-domain-events.asyncapi.yaml`
  (channel + operation baru).
- `src/lib/config/registry.ts`, `scripts/validate-env.ts`
  (`checkBlogAutoInternalTagLinksConfig`), `.env.example`,
  `18_configuration_env_reference.md` §Blog content — automatic internal
  tag linking.
- `i18n/en.po`/`i18n/id.po` (25 key baru: dashboard link, panel post
  editor, layar settings baru).
- Test: `tests/unit/internal-tag-linking.test.ts` (25 skenario),
  `tests/unit/internal-tag-linking-config.test.ts`,
  `tests/unit/internal-tag-linking-policy.test.ts`,
  `tests/integration/blog-internal-tag-linking.integration.test.ts` (16
  skenario: render wiring, tenant isolation, tiga level disable,
  per-tag disable, settings API CRUD + validasi + audit, preview API);
  diperbarui: `tests/foundation.test.ts` (versi modul, daftar migration).
- Changeset: `.changeset/blog-content-internal-tag-linking-issue-641.md`.

## §690 — R2 media lifecycle cleanup & reconciliation job (epic #679 platform-hardening, BUKAN epic ini — Selesai)

Bukan bagian epic `news_portal` (#631-#642/#649) — datang dari epic
terpisah `#679` (platform-hardening, "runtime/worker hardening" wave,
setelah #691/#689/#694/#695/#687/#697), tapi menyentuh modul ini
langsung (dicatat di sini untuk konteks tetap terpusat, sama seperti
§681).

### Yang diimplementasikan

`bun run news-media:reconcile` (`scripts/news-media-r2-reconcile.ts`,
logika di `news-media-reconciliation.ts` + `news-media-reconciliation-
categorization.ts`) — job pertama modul ini di atas shared worker
runner (#697). Mengisi TIGA celah yang `r2-backup-lifecycle.md` §2/§4
sudah tulis sejak Issue #631/#633 tapi belum ada implementasinya:

1. **Pending TTL cleanup** — baris `pending_upload`/`uploaded` (dan
   `failed`, untuk retry-on-rerun) yang lewat
   `NEWS_MEDIA_R2_PENDING_TTL_MINUTES` (klaim atomik ke `failed` dulu
   — guard `WHERE status IN (...) AND created_at < cutoff` yang SAMA
   dengan pola atomic-claim `finalizeNewsMediaUploadSession` #634 pakai
   — baru hapus objek R2, baru hard-delete baris).
2. **Stale-orphaned physical cleanup** — kolom BARU `orphaned_at`
   (migration 046) di baris `status='orphaned'`, dipakai untuk mengukur
   `NEWS_MEDIA_R2_ORPHAN_GRACE_DAYS` (default+minimum 30 hari). Job ini
   TIDAK menentukan sendiri kapan baris jadi `orphaned` (cross-
   referencing ke seluruh titik referensi `blog_content` — §4's
   "Implementasi konkret" — masih di luar cakupan, belum berubah).
3. **Rekonsiliasi drift DB-vs-R2** — dua kategori BARU yang beda dari
   status enum `orphaned` yang sudah ada: **orphan-in-DB** (row
   `uploaded`/`verified`/`attached` tapi objek R2 hilang — report-only,
   TIDAK PERNAH dimutasi otomatis) dan **orphan-in-R2** (objek R2 tanpa
   baris DB sama sekali — celah nyata karena `purgeNewsMediaObject`
   tidak menghapus objek R2-nya; dihapus fisik setelah lewat masa
   tenggang yang sama, DENGAN pengecekan ulang tepat sebelum
   penghapusan — `objectKeyExistsForTenant` — supaya baris baru yang
   dibuat tepat sebelum delete tidak pernah kehilangan objeknya).

### Kenapa urutan "klaim DB dulu, baru R2" — BUKAN "R2 dulu" seperti tertulis di `r2-backup-lifecycle.md` §2 aslinya

Doc lifecycle (ditulis sebelum implementasi ada) minta "hapus objek R2
dulu, baru baris metadata" murni untuk keamanan-terhadap-crash. Job ini
membalik urutan itu karena ada concern LAIN yang lebih kritis: klaim DB
harus terjadi PERTAMA supaya guard atomiknya bisa menyerialkan
terhadap `finalize()` yang genuinely sedang berjalan bersamaan untuk
baris yang sama (kalau R2 dihapus duluan, sebuah `finalize()` yang
sedang berjalan bisa kehilangan objeknya di tengah jalan). Kegagalan-
parsial yang doc aslinya khawatirkan (objek R2 yatim tanpa baris)
tetap tertangani — bukan jalan buntu — karena persis itulah kategori
orphan-in-R2 yang dideteksi/dibersihkan job ini sendiri di run
berikutnya (self-healing lintas run, bukan hanya lintas pass dalam satu
run).

### Race-condition test yang paling kritis

Acceptance criteria issue #690 eksplisit minta test untuk skenario:
baris DB baru dibuat SESAAT SEBELUM reconciliation run menghapus objek
yang (di titik snapshot awal) terlihat seperti orphan-in-R2.
`tests/integration/news-media-r2-reconciliation-job.integration.test.ts`
membuktikan ini dengan cara: wrap R2 client asli sehingga panggilan
`listObjects` PERTAMA (yang terjadi tepat setelah snapshot DB diambil)
JUGA menyisipkan baris baru untuk key yang sama — mensimulasikan race
sungguhan — lalu assert `objectKeyExistsForTenant`'s pengecekan ulang
(dijalankan tepat sebelum delete) menemukan baris baru itu dan
membatalkan penghapusan (`raceAverted`), TIDAK PERNAH menghapus
objeknya.

### File yang dibuat/diubah (referensi cepat)

- `sql/046_awcms_mini_news_media_orphan_lifecycle.sql` — kolom
  `orphaned_at` + CHECK constraint + GRANT `awcms_mini_worker`.
- `src/modules/news-portal/domain/news-media-reconciliation-
categorization.ts` — logika kategorisasi murni (tanpa I/O).
- `src/modules/news-portal/application/news-media-reconciliation.ts` —
  orkestrasi per-tenant/semua-tenant (DB + R2 client asli).
- `src/modules/news-portal/application/news-media-object-directory.ts`
  — fungsi atomik baru: `purgeExpiredPendingNewsMediaObject`,
  `markStaleOrphanedNewsMediaObjectDeleted`, `objectKeyExistsForTenant`,
  `fetchNewsMediaObjectsForReconciliation`;
  `markNewsMediaObjectFailed` dapat parameter `olderThan` opsional;
  `markNewsMediaObjectOrphaned` sekarang mengisi `orphaned_at`.
- `src/modules/news-portal/infrastructure/news-media-r2-client.ts` —
  `listObjects`/`deleteObject` baru (circuit breaker + timeout sama
  seperti method lain di file ini).
- `src/modules/news-portal/domain/news-media-r2-config.ts` —
  `orphanGraceDays`/`NEWS_MEDIA_R2_ORPHAN_GRACE_DAYS`/
  `isOrphanGraceTooShort`.
- `scripts/news-media-r2-reconcile.ts` — CLI, `bun run
news-media:reconcile`, dibangun di atas `runJob` sejak awal.
- `docs/awcms-mini/news-portal/r2-backup-lifecycle.md` — §2/§4 diupdate
  - §Operator SOP baru.

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
- `docs/awcms-mini/news-portal/r2-backup-lifecycle.md` — backup/lifecycle/retensi + §Operator SOP `news-media:reconcile` (Issue #690).
- `docs/awcms-mini/deployment-profiles.md` §Shared worker runner / §Job registry lainnya — `news-media:reconcile` (Issue #690).
- `docs/awcms-mini/news-portal/newsroom-user-guide.md` — panduan editor.
- `src/modules/sync-storage/README.md` — R2 usage yang sudah ada (bucket terpisah, Keputusan kunci #1).
- `src/modules/blog-content/README.md` §Media/Gallery, §Ads — perilaku sebelum #636 mengubahnya.
- `docs/adr/0006-offline-first-sync-outbox.md` — provider eksternal opsional/di luar transaksi.
- `docs/awcms-mini/deployment-profiles.md` §News portal — ringkasan per profil deployment.
- `AGENTS.md` skill table.
