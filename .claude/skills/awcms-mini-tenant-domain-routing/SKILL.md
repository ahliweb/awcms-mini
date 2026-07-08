---
name: awcms-mini-tenant-domain-routing
description: Kerjakan bagian mana pun dari epic online public tenant routing & tenant domain management AWCMS-Mini (Issue #556-#567, epic #555). Gunakan saat menambah/mengubah PUBLIC_* env config, skema/API/UI tenant domain, resolver tenant berbasis host, rute publik `/news`, module presets, atau adapter Cloudflare DNS. Merangkum keputusan yang sudah dibuat supaya issue lanjutan tidak mengulang/kontradiksi.
---

# AWCMS-Mini — Online Public Tenant Routing & Tenant Domain Management

Epic #555 menambah **mode routing publik online-primary** (domain/subdomain
→ tenant, tanpa perlu `tenantCode` di path) sambil **mempertahankan**
kapabilitas offline/LAN-first yang sudah ada (`/blog/{tenantCode}` tetap
jalan — lihat ADR-0009 dan skill `awcms-mini-blog-content`). Target model:

```txt
Domain/Subdomain -> Public Tenant Resolver -> Tenant Context -> /news Public Routes -> blog_content
```

## Kapan pakai skill ini vs skill generik

Skill ini melengkapi (bukan menggantikan) `awcms-mini-new-endpoint`,
`awcms-mini-new-migration`, `awcms-mini-new-module`,
`awcms-mini-blog-content` (untuk sisi `/news` di modul `blog_content`),
dan `awcms-mini-module-management` (untuk sisi module presets/matrix UI).
Skill ini menyediakan konteks **cross-cutting epic #555 spesifik** yang
menjembatani beberapa modul sekaligus (config, `tenant_domain` module baru,
`blog_content`, `module_management`).

## Status per issue (jangan bangun ulang yang sudah ada)

| Issue | Scope                                                         | Status                                                                           |
| ----- | ------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| #556  | Online public mode config (`PUBLIC_*` env vars)               | **Selesai** — lihat §Config di bawah                                             |
| #557  | Tenant domain/subdomain mapping schema                        | **Selesai** — lihat §Schema di bawah                                             |
| #558  | Register module descriptor `tenant_domain`                    | **Selesai** — lihat §Module descriptor di bawah                                  |
| #559  | Public host tenant resolver (dengan fallback)                 | **Selesai** — lihat §Resolver di bawah                                           |
| #560  | Rute publik `/news` untuk `blog_content`                      | **Selesai** — lihat §Rute publik `/news` di bawah                                |
| #561  | Dokumentasi legacy `/blog/{tenantCode}`                       | **Selesai** — lihat ADR-0010, `blog-content/README.md`, `deployment-profiles.md` |
| #562  | Tenant domain management API                                  | **Selesai** — lihat §API di bawah                                                |
| #563  | Admin UI domain/subdomain                                     | Belum                                                                            |
| #564  | Tenant settings untuk rute `/news` vs legacy (`blog_content`) | Belum                                                                            |
| #565  | Tenant module presets (online/news/LAN/minimal)               | Belum                                                                            |
| #566  | Tenant-module matrix admin UI                                 | Belum                                                                            |
| #567  | Cloudflare DNS adapter (opsional)                             | Belum                                                                            |

## Yang sudah ada — pakai ulang, jangan re-derive

### Config (Issue #556, `scripts/validate-env.ts`)

Enam env var baru, semuanya **opsional** dan backward-compatible — kalau
tidak diset sama sekali, `config:validate` tetap PASS dan perilaku tetap
offline/LAN-first (`tenant_code_legacy` implisit):

- `PUBLIC_TENANT_RESOLUTION_MODE` — enum `host_default | env_default | setup_default | tenant_code_legacy`. Divalidasi `isKnownPublicTenantResolutionMode` (`scripts/validate-env.ts:114`); value lain gagal validasi dengan pesan daftar value yang sah.
- `PUBLIC_DEFAULT_TENANT_ID` / `PUBLIC_DEFAULT_TENANT_CODE` — wajib **minimal salah satu** saat mode `env_default` (bukan keduanya).
- `PUBLIC_PLATFORM_ROOT_DOMAIN` — wajib saat mode `host_default` (landasan untuk resolver berbasis host di Issue #559 — tanpa root domain, resolver tidak bisa membedakan subdomain tenant valid dari `Host` header sembarangan).
- `PUBLIC_CANONICAL_BASE_PATH` — default `/news` (belum ada rute nyata di sana sampai #560), divalidasi `isValidCanonicalBasePath` (`scripts/validate-env.ts:129`): wajib absolute path (`/...`), tanpa whitespace, tanpa `//`, tanpa trailing slash kecuali `/` itu sendiri. Divalidasi **selalu**, independen dari mode.
- `PUBLIC_TRUST_PROXY` — default `false` (aman). Kalau `true`, app **wajib** jalan di belakang reverse proxy tepercaya yang men-sanitize `X-Forwarded-Host` — jangan pernah percaya header itu tanpa proxy tepercaya di depan (catatan keamanan eksplisit epic #555, relevan untuk resolver #559).

Entry point: `checkPublicRoutingConfig()` (`scripts/validate-env.ts:304`),
dipanggil dari `runEnvValidation()`. Semua pesan fail hanya menyebut nama
var, tidak pernah value-nya (pola sama seperti check lain di file ini) —
kecuali `PUBLIC_CANONICAL_BASE_PATH`/`PUBLIC_TENANT_RESOLUTION_MODE` yang
memang bukan secret dan boleh echo value untuk debuggability operator.

Didokumentasikan di `docs/awcms-mini/18_configuration_env_reference.md`
§Public routing dan `docs/awcms-mini/deployment-profiles.md` §Profil
online. Test: `tests/validate-env.test.ts`'s
`describe("checkPublicRoutingConfig", ...)`.

### Schema (Issue #557, `sql/031`/`sql/032`)

Tabel `awcms_mini_tenant_domains` — pemetaan hostname/domain/subdomain →
tenant. **Schema saja**, belum ada module descriptor (#558), resolver
(#559), atau API (#562) yang mengonsumsinya.

- Migration di-split dua file mengikuti pola `blog_content` (026 schema /
  027 permission, diulang lagi di 029/030): `sql/031_awcms_mini_tenant_domain_schema.sql`
  (tabel) dan `sql/032_awcms_mini_tenant_domain_permissions.sql`
  (permission seed).
- Kolom kunci: `hostname` (raw, case asli) + `normalized_hostname` (kolom
  terpisah, bukan functional index — `lower(btrim(hostname))`, dijaga
  konsisten oleh CHECK constraint
  `awcms_mini_tenant_domains_normalized_hostname_matches_check`);
  `domain_type` (`subdomain` | `custom_domain`); `route_mode`
  (`canonical` → rute `/news` #560, | `legacy_blog` → rute
  `/blog/{tenantCode}` ADR-0009 — kolom disiapkan, belum dikonsumsi
  resolver manapun); `status` (`pending_verification` | `active` |
  `suspended` | `failed` — soft delete via `deleted_at` adalah state
  kelima "tidak resolve traffic", tidak digabung ke enum ini);
  `verification_method` (`dns_txt` | `dns_cname` | `file` | `manual`,
  nullable); `verification_token_hash` (sha256 hex, prefix `sha256:`,
  konstruksi sama seperti `lib/auth/password-reset-token.ts`'s
  `hashResetToken` — token CSPRNG high-entropy jadi fast hash sudah benar,
  bukan bcrypt/argon2; raw token tidak pernah disimpan);
  `verification_record_name`/`verification_record_value` (nilai DNS
  publik yang dipublish tenant, BUKAN secret provider); `is_primary` +
  `redirect_to_primary`.
- Constraint kunci: `awcms_mini_tenant_domains_normalized_hostname_dedup`
  (unique index global — LINTAS tenant, bukan per-tenant — pada
  `normalized_hostname` `WHERE deleted_at IS NULL`, karena satu hostname
  cuma boleh milik satu tenant); `awcms_mini_tenant_domains_primary_dedup`
  (unique index pada `tenant_id` `WHERE is_primary = true AND deleted_at IS NULL`
  — satu primary aktif per tenant); soft delete standar
  (`deleted_at`/`deleted_by`/`delete_reason`) membebaskan
  `normalized_hostname` untuk dipakai ulang.
- RLS: `ENABLE` + `FORCE` + policy `tenant_isolation` standar (sama pola
  semua tabel tenant-scoped lain) — ini menciptakan bootstrap gap
  (query hostname→tenant_id butuh dijalankan SEBELUM tenant context ada,
  sementara FORCE RLS + fail-closed GUC dari migration 013 membuat query
  tanpa `withTenant` selalu 0 baris), yang **sudah diselesaikan Issue #559**
  lewat fungsi `SECURITY DEFINER` — lihat §Resolver di bawah untuk mekanisme
  lengkap. `FORCE ROW LEVEL SECURITY` **tidak** dilepas dari tabel ini.
- Permission seed: `module_key` `tenant_domain`, `activity_code` `domains`
  — `read`/`create`/`update`/`delete`/`verify`/`set_primary` (persis
  §Seed permissions issue #557). Belum ada role/access assignment yang
  memakainya (menunggu #562 dkk.).
- Test: `tests/integration/tenant-domain-schema.integration.test.ts`
  (idempotency, unique constraint case-insensitive, primary-per-tenant,
  soft-delete-frees-hostname, RLS isolation, fail-closed tanpa GUC, tidak
  ada kolom secret provider).

### Module descriptor (Issue #558, `src/modules/tenant-domain/module.ts`)

Modul `tenant_domain` terdaftar di `src/modules/index.ts`'s `listModules()`
(12 modul total sekarang). **Hanya descriptor** — tidak ada API/UI/resolver
di sini, itu semua issue lanjutan.

- `key: "tenant_domain"`, `type: "system"` (bukan `"domain"`/`"integration"`)
  — modul ini mengelola routing infrastructure yang dipakai bersama SEMUA
  tenant (resolusi hostname→tenant), bukan fitur bisnis tenant-facing, dan
  bukan didefinisikan oleh integrasi provider eksternal (Cloudflare adapter
  #567 opsional/enhancement, bukan sifat inti modul). Alasan sama seperti
  `module_management`'s `type: "system"`.
- `dependencies: ["tenant_admin", "identity_access"]`. `isCore` **tidak**
  di-set (beda dari `module_management`) — tidak ada yang wajib memakai
  modul ini; tenant yang cuma pakai `/blog/{tenantCode}` legacy tidak
  pernah butuh domain mapping.
- `api: { basePath: "/api/v1/tenant/domains", openApiPath:
"openapi/awcms-mini-public-api.openapi.yaml" }` dan `navigation: [{
path: "/admin/tenant/domains", requiredPermission:
"tenant_domain.domains.read", ... }]` **dideklarasikan sekarang**
  meski API (#562)/UI (#563) belum ada — permintaan eksplisit issue
  #558's descriptor requirements. Konsekuensi: Module Management's
  `openApiDocumentedSignal` (readiness check) akan melaporkan `fail`
  untuk `tenant_domain` sampai #562 menambah path OpenAPI nyata di bawah
  basePath itu — ini diharapkan, bukan regresi. Nav entry hanya muncul di
  sidebar untuk pemegang `tenant_domain.domains.read` (belum ada role yang
  punya izin ini sampai ada assignment eksplisit).
- `permissions`: 6 entry `tenant_domain.domains.*` (`read`/`create`/
  `update`/`delete`/`verify`/`set_primary`), match persis dengan seed
  migration 032 (`activityCode`/`action`/`description` identik) — divalidasi
  `tests/modules/tenant-domain-module.test.ts`.
- `settings: { schemaVersion: 1, defaults: { defaultVerificationMethod:
"manual" } }` — satu-satunya preferensi non-secret yang dideklarasikan;
  **bukan** default ke `dns_txt`/`dns_cname`/provider otomatis apa pun.
  Tidak ada field `jobs`/`health` (belum ada command/health-check nyata
  untuk didokumentasikan, konsisten dengan konvensi
  `module_management/README.md`).
- Tidak ada folder `domain/`/`application/` yang dibuat untuk modul ini di
  Issue #558 — belum ada logic apa pun untuk ditempatkan di sana sampai
  issue yang benar-benar butuh (#559/#562/#563). Hanya `module.ts` +
  `README.md`.

### Resolver (Issue #559, `src/lib/tenant/public-host-tenant-resolver.ts`)

**Dikonsumsi oleh `/news` sejak Issue #560** (lihat §Rute publik `/news` di
bawah) lewat `withNewsTenant()`
(`src/modules/blog-content/application/public-news-tenant-resolution.ts`).
Lima fungsi: `normalizePublicHost`, `resolvePublicTenantByHost`,
`resolveDefaultPublicTenantFromEnv`, `resolveDefaultPublicTenantFromSetupState`,
`resolvePublicTenantFromRequest` (orkestrator).

**Urutan resolusi**: (0) `config.mode === "tenant_code_legacy"` → langsung
`null`, skip langkah 1-4 seluruhnya — lihat §Keputusan `tenant_code_legacy`
di bawah — → (1) host/domain mapping — HANYA jalan kalau
`config.mode === "host_default"` — → (2) `PUBLIC_DEFAULT_TENANT_ID` → (3)
`PUBLIC_DEFAULT_TENANT_CODE` (2-3 satu fungsi,
`resolveDefaultPublicTenantFromEnv`, coba ID dulu lalu CODE) → (4)
`awcms_mini_setup_state.tenant_id` → (5) `null` (404 generic). **Langkah
2-4 SELALU jalan untuk setiap mode KECUALI `tenant_code_legacy` (langkah 0)** — itu "safe fallback" di judul issue #559; untuk mode lain (termasuk
`undefined`/tidak diset), hanya langkah 1 (host lookup) yang digerbangi
mode. Konsekuensi keamanan yang disengaja: deployment yang tidak pernah set
`PUBLIC_TENANT_RESOLUTION_MODE=host_default` (termasuk semua deployment
offline/LAN existing yang tidak set `PUBLIC_*` sama sekali) TIDAK PERNAH
menyentuh fungsi bootstrap `awcms_mini_tenant_domains` — permukaan lebih
kecil, bukan cuma code path lebih pendek.

#### Keputusan `tenant_code_legacy` (diputuskan Issue #560)

Dua reviewer Issue #559 (awcms-mini-reviewer dan awcms-mini-security-auditor)
menandai satu ambiguitas produk yang wajib diputuskan eksplisit sebelum
`/news` dibangun: versi awal `resolvePublicTenantFromRequest()` menjalankan
langkah 2-4 (fallback env→setup) untuk **SEMUA** mode, termasuk
`tenant_code_legacy` — padahal mode itu secara semantik berarti "tidak ada
tebakan tenant default, wajib `tenantCode` eksplisit di path", dan `/news`
sama sekali tidak punya segmen `tenantCode` di path.

**Keputusan final, diimplementasikan Issue #560**: ketika
`config.mode === "tenant_code_legacy"`, `resolvePublicTenantFromRequest()`
langsung `return null` — skip seluruh langkah 1-4, bukan cuma langkah 1
seperti mode lain. Mode `undefined` (default offline/LAN hari ini, operator
tidak pernah men-set var ini sama sekali) **TIDAK** diperlakukan sama
dengan `tenant_code_legacy` eksplisit — `undefined` tetap menjalankan
seluruh fallback chain 2-4, karena operator yang tidak pernah menyentuh
`PUBLIC_TENANT_RESOLUTION_MODE` belum membuat pilihan eksplisit "tidak ada
tebakan tenant default". Hanya operator yang benar-benar men-set
`PUBLIC_TENANT_RESOLUTION_MODE=tenant_code_legacy` yang membuat pilihan itu
secara sadar, dan `/news` menghormatinya dengan tidak pernah resolve tenant
apa pun untuk mode tersebut.

Test: `tests/unit/public-host-tenant-resolver.test.ts`'s
`describe("mode=tenant_code_legacy (Issue #560 decision)", ...)` (termasuk
bukti bahwa `undefined` mode tetap resolve lewat fallback chain, sementara
`tenant_code_legacy` eksplisit tidak, bahkan saat `PUBLIC_DEFAULT_TENANT_ID`/
`_CODE`/setup-state semuanya valid) dan
`tests/integration/blog-content-public-news.integration.test.ts`'s dua test
`mode=tenant_code_legacy`.

**Fungsi `SECURITY DEFINER` bootstrap** — `sql/033_awcms_mini_tenant_domain_lookup_function.sql`
(pakai checklist umum `SECURITY DEFINER` di
`docs/adr/0003-postgresql-rls-multi-tenant.md` §Checklist untuk fungsi baru
lain di masa depan):

```sql
CREATE OR REPLACE FUNCTION awcms_mini_resolve_tenant_domain_lookup(p_normalized_hostname text)
RETURNS TABLE (
  tenant_id uuid, domain_status text, is_primary boolean, route_mode text,
  tenant_status text, tenant_code text, tenant_name text, default_locale text
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, pg_temp
AS $function$
  SELECT d.tenant_id, d.status AS domain_status, d.is_primary, d.route_mode,
         t.status AS tenant_status, t.tenant_code, t.tenant_name, t.default_locale
  FROM awcms_mini_tenant_domains AS d
  JOIN awcms_mini_tenants AS t ON t.id = d.tenant_id
  WHERE d.normalized_hostname = p_normalized_hostname AND d.deleted_at IS NULL;
$function$;

REVOKE ALL ON FUNCTION awcms_mini_resolve_tenant_domain_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION awcms_mini_resolve_tenant_domain_lookup(text) TO awcms_mini_app;
```

**Post-review fix (timing side-channel, Medium finding):** the first
version of this function returned only `(tenant_id, status, is_primary,
route_mode)`, and `resolvePublicTenantByHost()` issued a SECOND,
conditional query against `awcms_mini_tenants` only when the domain row
was found `active` — an unknown/unmapped host returned after exactly one
round trip, a host mapped to an active domain but an inactive tenant
always cost two. That is an observable timing side-channel distinguishing
"no such mapping" from "mapping exists, tenant just isn't active" purely
by response latency. Fixed by joining `awcms_mini_tenants` into this same
function (safe — that table is already RLS-free/publicly `SELECT`-able,
so the join exposes nothing not already unconditionally public; it only
removes a round trip) so `resolvePublicTenantByHost()` now issues **exactly
one query for every outcome**, proven by
`tests/integration/public-tenant-resolution.integration.test.ts`'s
round-trip-counting test (wraps the same `sql` client in a `Proxy` and
asserts the call count is 1 for an unmapped host, a mapped-but-inactive-
tenant host, and a fully active host alike).

Kenapa ini aman — **diverifikasi empiris** (bukan diasumsikan dari
dokumentasi PostgreSQL) terhadap DB yang jalan sebelum migration ini
ditulis, lihat percobaan di riwayat implementasi Issue #559:

- Migration jalan sebagai role pemilik schema (`POSTGRES_USER`,
  `awcms-mini` di `docker-compose.yml`), dan role itu adalah **Postgres
  SUPERUSER sungguhan** (`SELECT rolsuper FROM pg_roles` → `true`).
  Superuser bypass RLS **unconditional**, terlepas dari `FORCE ROW LEVEL
SECURITY` — `FORCE` hanya menghapus exemption RLS milik _table owner_
  ketika owner itu BUKAN superuser; tidak berefek pada owner yang memang
  superuser. Jadi fungsi `SECURITY DEFINER` yang dimiliki role ini bypass
  RLS dengan cara yang sama seperti DDL/DML migration lain di schema ini
  — bukan mekanisme RLS-vs-FORCE yang berbeda.
- Karena keamanan TIDAK datang dari RLS/FORCE di level fungsi ini, dua hal
  lain yang justru jadi pagar sebenarnya: (1) badan fungsi adalah SQL
  statis tetap (bukan dynamic SQL), hanya me-return 4 kolom non-sensitif
  (`tenant_id`/`status`/`is_primary`/`route_mode`) untuk satu
  `normalized_hostname` yang diparameterkan + `deleted_at IS NULL` — tidak
  mungkin dipakai membaca `verification_token_hash`/
  `verification_record_value`/`hostname` mentah/tabel lain; (2) `EXECUTE`
  di-revoke dari `PUBLIC` lalu di-grant eksplisit hanya ke `awcms_mini_app`
  — tidak ada role non-superuser lain yang bisa memanggil fungsi ini, dan
  `awcms_mini_app` sendiri tetap tidak bisa `SELECT` langsung dari
  `awcms_mini_tenant_domains` tanpa `withTenant(...)` (dibuktikan di
  integration test).
- `SET search_path = public, pg_temp` mengunci resolusi nama di dalam
  fungsi (defense-in-depth standar untuk `SECURITY DEFINER`, terlepas dari
  fakta ownernya sudah superuser).
- Diverifikasi di
  `tests/integration/public-tenant-resolution.integration.test.ts`: fungsi
  ini resolve rows lewat `awcms_mini_app` TANPA `app.current_tenant_id`
  GUC di-set; `SELECT` langsung ke tabel dari koneksi yang sama (tanpa
  fungsi) tetap 0 baris; kolom yang dikembalikan fungsi tidak pernah
  memuat `verification_token_hash`/`hostname`/`verification_record_value`.

`resolvePublicTenantByHost()` sendiri masih menambah filter
`domain_status === 'active' && tenant_status === 'active'` di sisi
TypeScript (fungsi SQL sengaja tidak memfilter status — hanya
`deleted_at IS NULL` — supaya keputusan "kombinasi status mana yang boleh
resolve traffic publik" tetap satu tempat, di kode aplikasi yang lebih
mudah diaudit/diubah daripada re-migrate SQL). Fungsi ini juga
me-revalidasi _shape_ `normalizedHost` sendiri (`isValidHostnameShape`,
Low finding — fungsi ini exported dan didokumentasikan bisa dipanggil
langsung oleh #560, jadi tidak boleh hanya mengandalkan "caller sudah
normalize duluan") sebelum query apa pun dijalankan — dibuktikan di
`tests/unit/public-host-tenant-resolver.test.ts` dengan `sql` palsu yang
throw kalau dipanggil sama sekali.

Semua kegagalan — host tidak dikenal, domain non-`active`, domain
soft-deleted, tenant inactive — return `null` yang identik, dalam **satu**
round-trip DB (lihat perbaikan timing side-channel di atas); satu-satunya
yang boleh throw adalah `normalizePublicHost()` dipanggil dengan string
kosong (pelanggaran kontrak pemanggil, bukan hasil resolusi runtime).
`resolvePublicTenantFromRequest()` tidak pernah memanggil
`normalizePublicHost` dengan string kosong — request tanpa `Host` header
cukup melewati langkah 1 seluruhnya.

`X-Forwarded-Host` hanya dibaca kalau `config.trustProxy === true`
(caller yang menentukan, bukan modul ini yang membaca `PUBLIC_TRUST_PROXY`
langsung dari `process.env` — pemanggil bertanggung jawab membangun
`config` dari env; lihat `resolveDefaultPublicTenantFromEnv`'s parameter
`env` untuk satu-satunya fungsi di modul ini yang punya default
`process.env` bawaan). **Aturan operasional mengikat (Medium finding,
post-review):** deployment yang set `PUBLIC_TRUST_PROXY=true` WAJIB
berada di belakang satu trusted edge proxy yang langsung bersebelahan
(directly-adjacent) dan yang MENIMPA (overwrite) `X-Forwarded-Host` secara
penuh di setiap request — tidak pernah append/forward nilai dari client.
Topologi yang didokumentasikan repo ini tidak pernah menghasilkan lebih
dari satu nilai `X-Forwarded-Host` secara sah. Kalau header tetap berisi
lebih dari satu nilai comma-separated saat runtime, `extractHostHeader()`
TIDAK menebak mana yang trustworthy (leftmost = persis yang bisa
di-pre-seed penuh oleh attacker kalau proxy-nya append, bukan overwrite) —
ia log anomali (`public_host_resolver.x_forwarded_host_multi_value`) dan
fallback ke `Host` biasa, persis seperti `trustProxy: false`. Perilaku ini
diuji di `tests/unit/public-host-tenant-resolver.test.ts`.

Test: `tests/unit/public-host-tenant-resolver.test.ts` (murni,
`normalizePublicHost` + percabangan `resolvePublicTenantFromRequest` lewat
mocked `deps`, tanpa DB) dan
`tests/integration/public-tenant-resolution.integration.test.ts` (Postgres
nyata — setiap acceptance criterion issue #559, termasuk bukti RLS/bypass
di atas).

### Rute publik `/news` (Issue #560)

Tujuh rute publik anonim di bawah `src/pages/news/` — persis analog rute
`/blog/{tenantCode}/...` (Issue #540, skill `awcms-mini-blog-content`),
me-reuse SEMUA application/domain service yang sama
(`public-blog-directory.ts`, `public-page-rendering.ts`, `seo-rendering.ts`,
`content-block-rendering.ts`, `blog-search.ts`'s `searchPublicBlogContent`,
`error-responses.ts`). **Satu-satunya perbedaan**: resolusi tenant.
`/blog/{tenantCode}/...` memakai `resolvePublicTenantByCode(sql,
tenantCode)` dari path segment (ADR-0009); `/news/...` memakai
`resolvePublicTenantFromRequest(sql, request, config)` (Issue #559) — tanpa
segmen `tenantCode` di path sama sekali.

```txt
GET /news                         -> index (paginated)
GET /news/{slug}                  -> detail post
GET /news/category/{slug}         -> arsip kategori
GET /news/tag/{slug}              -> arsip tag
GET /news/search?q=               -> search publik
GET /news/feed.xml                -> RSS 2.0
GET /news/sitemap-news.xml        -> sitemap protocol 0.9
```

Semua `.ts` `APIRoute` (bukan `.astro`), pola sama persis rute
`/blog/{tenantCode}` — testable lewat `tests/integration/harness.ts`'s
`invoke()`/`invokeRaw()`.

**Helper bersama**:
`src/modules/blog-content/application/public-news-tenant-resolution.ts`'s
`withNewsTenant(sql, request, handler, env?)` — dipakai ketujuh rute,
memusatkan dua langkah wajib sebelum query post apa pun:

1. `buildPublicHostResolverConfigFromEnv(env)` membangun
   `PublicHostResolverConfig` dari `process.env.PUBLIC_TENANT_RESOLUTION_MODE`/
   `process.env.PUBLIC_TRUST_PROXY` (dua env var Issue #556 — resolver #559
   sendiri sengaja tidak membaca `process.env` untuk keduanya, lihat
   §Resolver), lalu memanggil `resolvePublicTenantFromRequest`. `null` →
   seluruh helper return `null`.
2. **Module-disabled gate (acceptance criterion eksplisit Issue #560, DAN
   gap yang belum ada bahkan di `/blog/{tenantCode}` existing)**: setelah
   tenant resolve, `fetchTenantModuleEntries(tx, tenantId)`
   (`module-management/application/tenant-module-lifecycle.ts`, sudah ada)
   dipanggil **di dalam** `withTenant(...)` yang sama, **sebelum** `handler`
   (yang query post) dijalankan. Kalau entry `blog_content`'s
   `tenantEnabled === false`, helper return `null` — rute memetakannya ke
   404 generic yang identik dengan tenant tidak resolve, tidak pernah
   membedakan "module disabled" vs "tenant tidak ada" vs "host tidak
   dikenal" dari luar.

Setiap rute lalu: `const result = await withNewsTenant(sql, request, async
(tx, tenant) => { ...; return new Response(...); }); return result ??
notFoundHtmlResponse();` (atau `notFoundXmlResponse()` untuk feed/sitemap).
Post-not-found di dalam `handler` juga cukup `return null` — collapse ke
404 generic yang sama, tidak perlu dibedakan dari kasus tenant/module.

**Catatan pre-existing gap, TIDAK diperbaiki di Issue #560 (di luar
scope)**: rute `/blog/{tenantCode}` existing (Issue #540) **tidak** punya
cek module-disabled sama sekali — tenant yang menonaktifkan `blog_content`
lewat `/api/v1/tenant/modules/blog_content/disable` tetap bisa diakses
publik lewat `/blog/{tenantCode}`. Follow-up yang disarankan: issue
terpisah untuk retrofit cek yang sama ke `/blog/{tenantCode}` (reuse
`withNewsTenant`'s pola module-disabled check, atau ekstrak helper yang
lebih generik kalau retrofit itu dikerjakan).

**Helper rendering yang diperluas** (refactor murni, tanpa perubahan
behavior untuk `/blog/{tenantCode}`):
`public-page-rendering.ts`'s `renderPostSummaryListHtml(tenantCode, ...)`
sekarang delegasi ke `renderPostSummaryListHtmlAtBasePath(basePath, ...)`
generik baru (`basePath` = `/blog/{tenantCode}` untuk wrapper lama, `/news`
untuk rute baru) — byte-for-byte identik untuk pemanggil lama.
`renderPaginationNavHtml` sudah generik sejak awal (parameter `basePath`),
tidak perlu diubah.

Canonical URL/feed/sitemap semua literal `/news` (bukan konsumsi
`PUBLIC_CANONICAL_BASE_PATH` — var itu divalidasi sejak Issue #556 tapi
belum dikonsumsi kode manapun; `/news` di issue ini adalah path file tetap,
bukan basePath yang dikonfigurasi via env).

Test: `tests/integration/blog-content-public-news.integration.test.ts` —
setiap acceptance criterion (listing/detail/draft-review-scheduled-archived-
private-unlisted-soft-deleted visibility, canonical URL, feed/sitemap link
base, module-disabled 404, `tenant_code_legacy` 404, isolasi lintas tenant).

### API tenant domain management (Issue #562, `src/pages/api/v1/tenant/domains/**`)

Authenticated, tenant-scoped CRUD + lifecycle di atas
`awcms_mini_tenant_domains` — kode aplikasi PERTAMA yang pernah menulis baris
ke tabel ini (resolver #559 hanya pernah membacanya). Tidak ada admin UI
(#563), tidak ada panggilan Cloudflare DNS (#567) — API-only, persis scope
issue.

```txt
GET    /api/v1/tenant/domains              list, keyset-paginated
POST   /api/v1/tenant/domains              create
GET    /api/v1/tenant/domains/{id}         read one
PATCH  /api/v1/tenant/domains/{id}         partial update
DELETE /api/v1/tenant/domains/{id}         soft delete
POST   /api/v1/tenant/domains/{id}/verify        manual-first verify
POST   /api/v1/tenant/domains/{id}/set-primary   atomic primary swap
```

Pola akses data mengikuti aturan #10 di bawah dengan ketat: setiap query di
`tenant-domain/application/tenant-domain-directory.ts` jalan di dalam
`withTenant(...)` biasa (RLS `FORCE` sebagai defense-in-depth di atas filter
`tenant_id` eksplisit) — **tidak pernah** lewat fungsi `SECURITY DEFINER`
migration 033 (fungsi itu tetap eksklusif untuk resolver publik anonim
#559). Validasi hostname (`tenant-domain/domain/tenant-domain-validation.ts`)
me-reuse `normalizePublicHost()` (#559) langsung, bukan opini shape kedua.

Union `AccessAction` (`identity-access/domain/access-control.ts`) diperluas
dengan `verify`/`set_primary` di issue ini — migrasi 032 sudah menyeed kedua
permission itu sejak #557, tapi tidak ada konsumen sampai sekarang. Keduanya
**tidak** masuk `HIGH_RISK_ACTIONS` (pola sama seperti `retry`/`sync`/
`enable`/`disable`/`check`/`publish` — lihat `identity-access/README.md`),
tapi keduanya tetap **wajib** `Idempotency-Key` (skill
`awcms-mini-idempotency`, scope `tenant_domain_verify`/
`tenant_domain_set_primary`) dan tetap diaudit eksplisit
(`tenant_domain.domain.verified`/`.set_primary`) terlepas dari klasifikasi
itu.

Constraint global `awcms_mini_tenant_domains_normalized_hostname_dedup`
(migration 031, LINTAS tenant) di-catch di `POST /api/v1/tenant/domains` dan
selalu dipetakan ke `409 HOSTNAME_CONFLICT` generik — tidak pernah
membedakan "hostname ini sudah milikmu sendiri" vs "hostname ini sudah
dipakai tenant lain" (binding rule §Security notes issue #562, sejalan
dengan aturan #5 di bawah). Unknown/cross-tenant/soft-deleted id semuanya
jatuh ke 404 generik yang sama lewat filter `tenant_id`/`deleted_at IS NULL`
eksplisit plus RLS `FORCE` di baliknya.

`set-primary` atomic karena `withTenant` sudah membuka satu transaksi
`sql.begin(...)` per request, dan `setPrimaryTenantDomain` menjalankan dua
UPDATE di transaksi yang sama dengan urutan tetap (unset primary lama
DULU, baru set primary baru) — index unique parsial
`awcms_mini_tenant_domains_primary_dedup` tidak pernah dilanggar
mid-transaction untuk swap sekuensial (tenant yang sudah punya primary).
**Post-review fix (Medium finding, security audit #562):** untuk tenant
yang belum PERNAH punya primary, dua request `set-primary` konkuren untuk
dua domain berbeda sama-sama match nol baris di UPDATE "unset" (tidak ada
yang perlu di-unset), jadi keduanya lolos ke UPDATE "set" tanpa saling
memblokir — satu di antaranya kalah ke index unique saat commit.
`setPrimaryTenantDomain` sekarang membungkus UPDATE kedua dengan
`try/catch` yang menangkap pelanggaran `awcms_mini_tenant_domains_primary_dedup`
dan mengembalikan `{ outcome: "conflict" }` (pola sama seperti
`createTenantDomain`'s catch untuk hostname-dedup), dipetakan rute ke
`409 CONCURRENT_UPDATE` generik — bukan 500 dengan raw constraint error.
Diuji `tests/integration/tenant-domain-api.integration.test.ts`'s
"set-primary under concurrent first-time race" (dua request paralel via
`Promise.all`, assert satu 200 + satu 409, dan DB akhirnya cuma satu baris
`is_primary = true`). `verify` manual-first murni (tidak ada panggilan
DNS/HTTP keluar di issue ini), hanya membalik `status` berdasarkan
`verification_method` yang sudah ada di baris. `verification_token_hash`
tidak pernah di-`SELECT` oleh `tenant-domain-directory.ts` sama sekali,
apalagi dikembalikan di response manapun.

Detail lengkap (termasuk kenapa `hostname` immutable setelah create, kenapa
`is_primary` tidak pernah settable lewat `PATCH` generik, dan daftar
lengkap acceptance criterion) ada di
`src/modules/tenant-domain/README.md` §Tenant domain management API. Test:
`tests/integration/tenant-domain-api.integration.test.ts`.

## Aturan lintas-issue yang wajib diikuti

1. **Backward compatibility non-negotiable**: setiap deployment offline/LAN existing yang tidak pernah set `PUBLIC_*` apa pun harus tetap `config:validate` PASS dan berperilaku persis seperti sebelum epic ini — jangan pernah membuat salah satu dari enam var config ini menjadi wajib secara default.
2. **`PUBLIC_TRUST_PROXY=false` harus tetap default aman** di setiap lapisan baru — jangan baca `X-Forwarded-Host`/`X-Forwarded-Proto` kecuali `PUBLIC_TRUST_PROXY=true` eksplisit diset. Resolver #559 sudah menegakkan ini (`resolvePublicTenantFromRequest`'s `config.trustProxy`, default `false`); API domain #562 manapun yang membaca header host langsung (bukan lewat resolver ini) wajib pola yang sama.
3. **`/blog/{tenantCode}` (ADR-0009, skill `awcms-mini-blog-content`) TIDAK dihapus** — epic #555 secara eksplisit out-of-scope untuk "removing legacy `/blog/{tenantCode}` routes in the MVP". `/news` (#560) adalah rute **tambahan**, bukan pengganti. Issue #561 (selesai — `docs/adr/0010-public-host-tenant-routing.md`) mendokumentasikan `/blog/{tenantCode}` sebagai legacy, bukan menghapusnya.
4. **Jangan trust `X-Forwarded-Host` tanpa proxy tepercaya** — ulangi dari epic #555 §Security notes. Berlaku juga untuk API domain #562 manapun yang membaca header host secara independen dari resolver #559.
5. **Tenant existence tidak boleh bocor**: domain/tenant yang unknown, failed, suspended, atau inactive harus menghasilkan respons yang identik/tidak bisa dibedakan (pola sama seperti ADR-0009's 404 identik untuk `tenantCode` tak dikenal vs tenant tidak aktif) — resolver #559 sudah menegakkan ini (`resolvePublicTenantByHost`/`resolveDefaultPublicTenantFromEnv`/`resolveDefaultPublicTenantFromSetupState`/`resolvePublicTenantFromRequest` semua return `null` identik). Rute publik `/news` #560 **wajib** memetakan `null` resolver ini ke 404 generic yang sama, tidak menambah pesan/status yang membedakan kasus.
6. **Module disabled tetap diblokir server-side** — kalau tenant module presets (#565) atau tenant-module matrix (#566) menonaktifkan sebuah modul, endpoint modul itu wajib tetap menolak di server (guard ABAC/tenant-module lifecycle yang sudah ada dari `module_management`), bukan hanya disembunyikan di UI.
7. **Provider secret (mis. Cloudflare API token, #567) tidak pernah disimpan di module descriptor atau kolom DB biasa** — pakai environment variable seperti provider lain (Mailketing, R2), dan `configure`-only permission gate seperti pola `email`/`sync-storage` provider config.
8. **Semua mutasi domain/module (create/update/delete domain mapping, enable/disable module preset) wajib diaudit** — pola `recordAuditEvent` yang sama dipakai modul lain, action literal sesuai konvensi modul (`tenant_domain.<resource>.<verb>` mengikuti pola `blog.<resource>.<verb>` dari blog_content). Resolver #559 sendiri **bukan** mutasi (read-only, anonymous) — tidak diaudit, sama seperti `resolvePublicTenantByCode` (ADR-0009) tidak diaudit.
9. **Cloudflare DNS adapter (#567) adalah opsional/enhancement**, bukan hard dependency — epic #555 §Out of scope eksplisit menyebut "making Cloudflare DNS automation a hard dependency" di luar scope. Tenant domain mapping (#557/#562) harus tetap berfungsi tanpa Cloudflare sama sekali (manual DNS setup oleh operator).
10. **`/news` routes (Issue #560, selesai) reuse `resolvePublicTenantFromRequest()` (Issue #559) langsung** lewat `withNewsTenant()` helper — tidak re-derive hostname→tenant lookup logic lain. `config.mode` untuk panggilan itu dibangun dari `PUBLIC_TENANT_RESOLUTION_MODE`/`PUBLIC_TRUST_PROXY` di `process.env` (resolver sendiri tidak membaca `process.env` untuk keduanya — sengaja, untuk testability; lihat §Resolver). `#562`'s admin API (mutasi domain, tenant-scoped, authenticated) **TIDAK** boleh reuse resolver #559 (yang anonymous/pre-tenant-context) — API #562 memakai `withTenant(...)` biasa seperti endpoint tenant-scoped lain, RLS `awcms_mini_tenant_domains` yang menjaga isolasinya, bukan fungsi `SECURITY DEFINER` (fungsi itu murni untuk bootstrap publik tanpa tenant context).

## Belum ada — jangan asumsikan sudah dikerjakan

Isu #562-#567 (API tenant domain, admin UI domain, tenant settings rute
`/news`/legacy di `blog_content`, module presets, matrix UI admin, dan
adapter Cloudflare DNS) **belum ada** — lapisan config (#556), schema
`awcms_mini_tenant_domains` (#557), module descriptor `tenant_domain`
(#558), resolver host-based (#559), rute publik `/news` (#560), dan
dokumentasi legacy/ADR-0010 (#561) sudah selesai (lihat §Rute publik
`/news` dan aturan #3 di atas). Tabel
`awcms_mini_tenant_domains` masih berisi schema + constraint + RLS +
permission catalog seed + fungsi lookup `SECURITY DEFINER` saja — belum
ada baris yang pernah ditulis lewat kode aplikasi (menunggu #562's API);
resolver #559 hanya bisa MEMBACA baris yang di-seed manual/via test, bukan
menulisnya — `/news` (#560) karena itu, sampai #562 ada, hanya bisa
resolve tenant lewat fallback env/setup-state (langkah 2-4), tidak pernah
lewat host/domain mapping asli (langkah 1) kecuali baris
`awcms_mini_tenant_domains` di-seed manual.

**Follow-up keamanan wajib diselesaikan sebelum `PUBLIC_TENANT_RESOLUTION_MODE=host_default` diaktifkan di production** (ditemukan `awcms-mini-security-auditor` saat audit #560, verdict PASS tapi non-blocking karena `host_default` belum bisa resolve apa pun secara nyata hari ini — lihat alasan di atas):

1. **`fetchTenantModuleEntries` membaca status SEMUA modul terdaftar**, bukan cuma `blog_content` (`public-news-tenant-resolution.ts`) — bukan risiko DoS nyata (satu query indexed murah, filtering di memori), tapi melanggar prinsip "read surface publik seminimal mungkin" resolver #559. Pertimbangkan helper single-module lookup sebagai penyempitan opsional di masa depan (tidak diblokir go-live).

**Follow-up non-blocking dari security audit #562** (verdict PASS, tidak ada Critical/High — kedua item ini dicatat sebagai perbaikan lanjutan, bukan gate merge):

2. **Race idempotency-store lintas-modul** (`src/modules/_shared/idempotency.ts`, dipakai `verify`/`set-primary` #562 dan setiap endpoint idempotent lain di repo): dua request paralel dengan `Idempotency-Key` yang SAMA bisa sama-sama lolos `findIdempotencyRecord` di bawah READ COMMITTED sebelum salah satu commit, lalu `saveIdempotencyRecord`-nya yang kalah gagal pada unique index `awcms_mini_idempotency_keys_scope_key` (migration 012) tanpa ditangkap. Ini gap pre-existing pada helper bersama, bukan regresi khusus #562 — diwariskan tanpa perubahan oleh `verify`/`set-primary`. Track sebagai isu terpisah (bukan spesifik `tenant_domain`), perbaikannya idealnya di `_shared/idempotency.ts` sekali untuk semua konsumen.
3. **Klasifikasi `set_primary` di luar `HIGH_RISK_ACTIONS`** (`identity-access/domain/access-control.ts`) layak ditinjau ulang untuk konsistensi jangka panjang — `isHighRiskAction()` tidak dikonsumsi di mana pun hari ini (murni metadata, audit dan `Idempotency-Key` tetap ditegakkan eksplisit per-endpoint terlepas dari klasifikasi ini), tapi blast radius `set_primary` (mengubah tenant mana yang jadi canonical redirect target untuk traffic publik anonim) berpotensi lebih besar daripada `delete` (yang sudah masuk `HIGH_RISK_ACTIONS`). Tidak berdampak fungsional sekarang; pertimbangkan saat `isHighRiskAction()` mulai dikonsumsi (mis. rate limiting tambahan, step-up auth).

Sudah diperbaiki di #560 (bukan follow-up lagi): guard module-disabled sekarang fail-closed (`!blogContentEntry?.tenantEnabled`, bukan `blogContentEntry && !blogContentEntry.tenantEnabled`) — entry yang hilang dianggap disabled, bukan enabled by default.

Sudah diperbaiki bersamaan dengan #562 (bukan follow-up lagi): **timing side-channel di `withNewsTenant`** (`public-news-tenant-resolution.ts`) — tiga outcome yang seharusnya identik (tenant tidak resolve / `tenant_code_legacy` / module `blog_content` disabled untuk tenant) dulu punya biaya latency berbeda (tenant tidak resolve = tidak buka transaksi sama sekali; tenant resolve tapi module disabled = buka `withTenant` + 1 query `fetchTenantModuleEntries`), sehingga prober eksternal dengan `Host` header berbeda-beda bisa membedakan "hostname termapping ke tenant aktif" dari "hostname tidak dikenal" murni lewat waktu respons begitu #562 mengisi `awcms_mini_tenant_domains` dengan mapping nyata. Fix: `padUnresolvedTenantLatency()` (baru,
`public-news-tenant-resolution.ts`) membebankan biaya round-trip yang SAMA pada jalur "tenant tidak resolve" — buka transaksi lewat `withTenant` yang sama, `SET LOCAL` GUC tenant ke UUID nol (sentinel fail-closed migration 013, tidak pernah cocok dengan tenant nyata), lalu satu `SELECT` ke `awcms_mini_tenant_modules` — persis bentuk round-trip yang sudah dibayar jalur module-disabled lewat `fetchTenantModuleEntries`. Pola "tambahkan cost tetap di jalur tidak-resolve" (bukan "gabungkan jadi satu query" seperti migration 033/#559, karena jalur tidak-resolve secara struktural tidak punya `tenant_id` nyata untuk digabung ke query yang sama). Test:
`tests/integration/blog-content-public-news.integration.test.ts`'s round-trip-counting test (pola Proxy yang sama seperti
`tests/integration/public-tenant-resolution.integration.test.ts`, diperluas untuk mengintersep `sql.begin(...)`/method call pada `tx` juga, bukan cuma pemanggilan `sql` langsung).
