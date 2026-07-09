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
| #563  | Admin UI domain/subdomain                                     | **Selesai** — lihat §Admin UI di bawah                                           |
| #564  | Tenant settings untuk rute `/news` vs legacy (`blog_content`) | **Selesai** — lihat §Tenant settings public route di bawah                       |
| #565  | Tenant module presets (online/news/LAN/minimal)               | **Selesai** — lihat §Tenant module presets di bawah                              |
| #566  | Tenant-module matrix admin UI                                 | **Selesai** — lihat §Tenant-module matrix admin UI di bawah                      |
| #567  | Cloudflare DNS adapter (opsional)                             | **Selesai** — lihat §Cloudflare DNS adapter di bawah                             |

## Yang sudah ada — pakai ulang, jangan re-derive

### Config (Issue #556, `scripts/validate-env.ts`)

Enam env var baru, semuanya **opsional** dan backward-compatible — kalau
tidak diset sama sekali, `config:validate` tetap PASS dan perilaku tetap
offline/LAN-first (`tenant_code_legacy` implisit):

- `PUBLIC_TENANT_RESOLUTION_MODE` — enum `host_default | env_default | setup_default | tenant_code_legacy`. Divalidasi `isKnownPublicTenantResolutionMode` (`scripts/validate-env.ts`, cari nama fungsinya — nomor baris di file ini bergeser tiap ada penyisipan check baru di atasnya, jangan percaya angka baris statis); value lain gagal validasi dengan pesan daftar value yang sah.
- `PUBLIC_DEFAULT_TENANT_ID` / `PUBLIC_DEFAULT_TENANT_CODE` — wajib **minimal salah satu** saat mode `env_default` (bukan keduanya).
- `PUBLIC_PLATFORM_ROOT_DOMAIN` — wajib saat mode `host_default` (landasan untuk resolver berbasis host di Issue #559 — tanpa root domain, resolver tidak bisa membedakan subdomain tenant valid dari `Host` header sembarangan).
- `PUBLIC_CANONICAL_BASE_PATH` — default `/news` (belum ada rute nyata di sana sampai #560), divalidasi `isValidCanonicalBasePath` (`scripts/validate-env.ts`, cari nama fungsinya): wajib absolute path (`/...`), tanpa whitespace, tanpa `//`, tanpa trailing slash kecuali `/` itu sendiri. Divalidasi **selalu**, independen dari mode.
- `PUBLIC_TRUST_PROXY` — default `false` (aman). Kalau `true`, app **wajib** jalan di belakang reverse proxy tepercaya yang men-sanitize `X-Forwarded-Host` — jangan pernah percaya header itu tanpa proxy tepercaya di depan (catatan keamanan eksplisit epic #555, relevan untuk resolver #559).

Entry point: `checkPublicRoutingConfig()` (`scripts/validate-env.ts`, cari nama fungsinya),
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
   tenant resolve, `fetchTenantModuleEntry(tx, tenantId, "blog_content")`
   (`module-management/application/tenant-module-lifecycle.ts` — single-module
   narrowing dari `fetchTenantModuleEntries`, lihat "Sudah diperbaiki" di
   bawah untuk alasannya)
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

### Admin UI (Issue #563, `src/pages/admin/tenant/domains.astro`)

Path/permission gate persis descriptor Issue #558:
`/admin/tenant/domains`, `tenant_domain.domains.read`. **Binding split**
yang wajib diikuti issue turunan manapun yang menambah aksi baru di
halaman ini: SSR initial render boleh baca langsung lewat
`listTenantDomains`/`withTenant` (read-only, sama pola
`admin/blog/categories.astro`), tapi **setiap mutasi** (create/update/
delete/verify/set-primary) **wajib** lewat `fetch` client-side ke
`/api/v1/tenant/domains/**` (#562) — tidak ada shortcut SSR privileged
untuk mutasi apa pun, itu acceptance criterion mengikat issue #563.
`verify`/`set-primary` mengirim `Idempotency-Key` baru
(`newIdempotencyKey()`) per klik, pola sama
`admin/blog/posts/[id].astro`'s tombol lifecycle. Validasi hostname
client-side (`looksLikeValidHostname()` di halaman ini) murni UX —
`normalizePublicHost()` lewat API tetap satu-satunya enforcement.
Badge status pakai enum DB asli (`pending_verification | active |
suspended | failed`) — bukan daftar shorthand issue #563 sendiri yang
menyebut "verified" sebagai status kelima (tidak ada di schema). Link
preview `/news` hanya muncul untuk domain yang `active` **dan**
`isPrimary` sekaligus. Test:
`tests/integration/tenant-domain-admin.integration.test.ts`.

### Tenant settings public route (Issue #564, `blog_content`)

Empat key baru di descriptor `blog_content`'s `settings.defaults`
(`src/modules/blog-content/module.ts`, dibaca lewat
`fetchEffectivePublicRouteSettings`/`isLegacyTenantRouteEnabled`,
`src/modules/blog-content/application/public-route-settings.ts`):
`publicRouteMode` (`domain_default` default, atau `disabled`),
`publicBasePath` (default `/news`), `legacyTenantRouteEnabled` (default
`true`), `publicLabel` (default `"News"`).

**Keputusan mengikat yang wajib diikuti issue lanjutan** (jangan
diulang/dikontradiksi):

1. **`rssEnabled`/`sitemapEnabled` SENGAJA TIDAK** ada di store baru ini
   meski muncul di contoh JSON issue #564 sendiri — keduanya sudah punya
   rumah di `awcms_mini_blog_settings`/`fetchBlogSettings()` sejak Issue
   #543, sudah ditegakkan `/news/feed.xml`/`sitemap-news.xml` sejak Issue
   #560. Menambahkannya ke store generik (`awcms_mini_module_settings`,
   framework Issue #516) akan membuat dua sumber kebenaran independen
   untuk konsep yang sama — bug nyata, bukan kosmetik (admin toggle di
   satu tempat, rute baca dari tempat lain). Test regresi eksplisit
   membuktikan ini: `tests/integration/blog-content-settings.integration.test.ts`
   PATCH `rssEnabled` ke store yang SALAH (baru) → tidak berpengaruh ke
   `/news/feed.xml`; PATCH ke store yang BENAR (lama) → baru berpengaruh.
2. **`publicBasePath` hanya memengaruhi link-generation (canonical
   `<link>`, RSS `<link>`/`<guid>`, sitemap `<loc>`, pagination href,
   cross-link)** — BUKAN routing fisik. `/news/**` tetap file-based route
   Astro yang secara fisik hanya bisa diakses di `/news/*`; mengubah
   `publicBasePath` tidak memindahkan endpoint yang benar-benar merespons.
   Ini keterbatasan yang disengaja (retargeting routing fisik per-tenant
   butuh dynamic catch-all route, jauh di luar scope #564), didokumentasikan
   eksplisit di `blog-content/README.md` §Public route settings — jangan
   "perbaiki" jadi routing dinamis tanpa issue baru yang eksplisit
   membahasnya.
3. **`publicRouteMode=disabled` adalah outcome ke-4 pada gate timing-parity
   `withNewsTenant`** (menambah dari 3 outcome sebelumnya — lihat
   "Timing side-channel" di §Belum ada di bawah). Ditegakkan struktural
   lewat satu fungsi bersama `checkBlogContentAndRouteGate()`
   (`public-news-tenant-resolution.ts`) yang dipanggil baik dari jalur
   tenant resolve sungguhan maupun dari `padUnresolvedTenantLatency()` —
   secara konstruksi tak bisa drift, bukan dua implementasi kebetulan
   sama. **Follow-up non-blocking** (dicatat security audit #564): belum
   ada test `wrapCountingSql`-based yang secara eksplisit membandingkan
   round-trip count outcome `publicRouteMode=disabled` vs 3 outcome
   lainnya (paritas berlaku by construction, tapi belum diuji langsung
   seperti paritas module-disabled vs enabled) — tambahkan bila menyentuh
   area ini lagi.
4. **`legacyTenantRouteEnabled=false` → 404 identik di SEMUA 7 rute
   `/blog/{tenantCode}/**`** (bukan redirect — pilihan eksplisit #564),
   lewat `isLegacyTenantRouteEnabled()` dipanggil tepat setelah
   `withTenant(...)` di ketujuh file, sebelum query lain apa pun. Default
   `true` mempertahankan perilaku hari ini tanpa perubahan (menegakkan
   aturan #3 di bawah — legacy route tidak pernah hilang secara default).
5. **`publicLabel` hanya memengaruhi output `/news`** (heading, `<title>`,
   RSS channel title) — `/blog/{tenantCode}` tetap pakai teks "Blog"
   historis, tidak disentuh. Di-escape lewat `escapeHtml()` yang sudah
   ada — **follow-up non-blocking** (security audit #564): belum ada test
   regresi eksplisit yang mengirim payload `<script>` via `publicLabel`/
   `publicBasePath` lalu assert output ter-escape (mitigasi sudah
   diverifikasi lewat code review manual — `escapeHtml()` dipanggil di
   setiap titik render — tapi belum jadi regression test otomatis).

Validasi nilai: `isPublicRouteMode`/`isValidBasePath`
(`public-route-settings.ts`) — enum-checked untuk mode, absolute-path +
no-whitespace + no-`//` + no-trailing-slash untuk base path; nilai tak
valid jatuh ke default aman, tidak pernah dipakai mentah. `publicLabel`
tidak divalidasi bentuk semantiknya (bebas string label, sama seperti
`blogTitle` di `awcms_mini_blog_settings`), tapi sejak perbaikan
value-shape heuristic (lihat "Sudah diperbaiki" di bawah)
`validateModuleSettingsPatch` tetap menolak kalau isinya credential-shaped
(JWT/PEM/AWS key/Bearer/connection-string) — bebas-string hanya untuk
konten label yang wajar, bukan celah untuk menyimpan secret mentah.

Test: `tests/integration/blog-content-settings.integration.test.ts` (12
test) dan 3 test paritas round-trip di
`tests/integration/blog-content-public-news.integration.test.ts`. Detail
lengkap kelima keputusan di atas: `blog-content/README.md` §Public route
settings.

### Tenant module presets (Issue #565, `module_management`)

Domain+application service layer saja (`src/modules/module-management/domain/module-presets.ts` +
`application/module-presets.ts`) — **belum ada endpoint API/UI** (itu
scope #566's matrix UI dan/atau setup wizard yang belum ada). Lima preset
(`online_website`, `news_portal`, `saas_online`, `pos_lan`, `minimal`),
`applyModulePreset()` bisa dipanggil issue lanjutan mana pun yang butuh
"set tenant module state ke profil X" — jangan re-derive dependency-graph
logic-nya, itu sudah 100% reuse `evaluateModuleEnable`/
`evaluateModuleDisable`/`enableTenantModule`/`disableTenantModule` yang
ada sejak Issue #515.

**Koreksi kunci key modul** yang wajib diikuti issue lanjutan manapun yang
menyebut modul workflow: key registry sungguhan adalah `workflow`
(`src/modules/workflow-approval/module.ts`), **bukan**
`workflow_approval` — issue #565 sendiri salah menyebutnya di contoh
JSON-nya. Grep `key: "` di `src/modules/*/module.ts` sebelum menulis key
modul apa pun secara manual, jangan asumsikan nama direktori = key.

**Preset menerapkan enable DAN disable** (bukan cuma enable) — modul yang
sedang enabled, tidak ada di daftar preset, dan bukan "protected"
(`isCore: true` ditambah closure transitif dependency-nya — dihitung
dinamis lewat `resolveProtectedModuleKeys`, bukan hardcoded; hari ini
resolve ke `{module_management, tenant_admin, identity_access,
profile_identity}`) akan di-disable. Disable leaves-first, skip (bukan
force) untuk modul yang masih dibutuhkan modul lain yang tetap enabled —
termasuk modul yang plan yang SAMA baru saja mau enable (bug post-review:
versi awal cuma menghitung status enabled SEBELUM plan, bukan union
dengan modul yang baru mau di-enable plan itu sendiri — sudah diperbaiki,
lihat komentar `planDisableOrder` di `domain/module-presets.ts`).
Idempotent: re-apply preset yang sama menghasilkan plan kosong (tidak ada
audit event baru). Setiap perubahan modul (bukan satu event "preset
applied" agregat) tetap diaudit lewat `recordAuditEvent` pola sama
`enable.ts`/`disable.ts`.

`applyModulePreset` **tidak** melakukan ABAC check sendiri (sama seperti
`enableTenantModule`/`disableTenantModule` yang dibungkusnya) — pemanggil
masa depan (API #566 atau setup wizard) wajib `authorizeInTransaction`
sendiri sebelum memanggilnya, guard permission yang sesuai (pola sama
`ENABLE_GUARD`/`DISABLE_GUARD` di `enable.ts`/`disable.ts`).

Test: `tests/unit/module-presets.test.ts` (18 test, pure domain logic
lewat synthetic registry) dan
`tests/integration/module-presets.integration.test.ts` (7 test, real
Postgres). Detail lengkap tiga keputusan desain di atas:
`module-management/README.md` §Tenant module presets.

### Tenant-module matrix admin UI (Issue #566, `module_management`)

`/admin/modules/tenants` (`src/pages/admin/modules/tenants.astro` +
`application/module-matrix.ts`'s `fetchModuleMatrix`) — layar admin yang
menampilkan module x atribut relevan **untuk satu tenant**, di atas data
yang sama yang sudah dibaca #521's list/detail (`fetchModuleCatalog`,
`fetchTenantModuleEntries`, `fetchModuleHealthReport`) plus #565's
`resolveProtectedModuleKeys`, dan `evaluateModuleEnable`/
`evaluateModuleDisable` (#515) untuk dua peringatan baru
(`dependencyWarning`/`reverseDependencyWarning`) — bukan graph baru.

**Keputusan scope mengikat (single-tenant, BUKAN cross-tenant)**: kata-kata
issue sendiri ("filter by tenant", "managing module availability across
tenants") terbaca seperti matrix lintas-tenant sungguhan — tapi model
identity repo ini strictly 1:1 tenant-scoped (`identity-access/README.md`,
`TenantSwitcher.astro` adalah stub yang sengaja permanen-disabled). Sudah
diputuskan bersama maintainer: layar ini scoped ke tenant admin sendiri
(`context.tenantId`), sama seperti semua layar admin lain di app ini —
**tidak ada** filter/selector tenant di mana pun di halaman ini. Alasan
lengkap: docblock `tenants.astro` sendiri. Issue lanjutan manapun **jangan**
"perbaiki" ini dengan menambah dropdown tenant satu-opsi palsu atau
membangun filtering lintas-tenant sungguhan — itu butuh konsep
identity/session platform-operator baru yang sama sekali di luar scope
repo ini hari ini.

**Nilai "matrix" konkret** (karena tidak ada sumbu tenant kedua untuk
dijadikan grid sungguhan): (1) peringatan dependency/reverse-dependency
untuk SEMUA modul sekaligus (100% reuse `evaluateModuleEnable`/
`evaluateModuleDisable`, tidak pernah walk graph baru — `dependencyWarning`
hanya dihitung untuk modul yang SEDANG disabled, `reverseDependencyWarning`
hanya untuk modul yang SEDANG enabled, karena memanggil `evaluateModuleEnable`
pada modul yang sudah enabled hanya akan short-circuit ke
`MODULE_ALREADY_ENABLED` sebelum sempat mengecek dependency — bukan
pertanyaan yang didesain untuk state itu); (2) visualisasi core/protected
bulk (`isCore` + `isProtected` per baris, tombol disable disembunyikan untuk
keduanya — protected non-core pun, karena disable-nya pasti ditolak server
lewat `MODULE_REVERSE_DEPENDENCY_ACTIVE`); (3) filter client-side "hanya
tampilkan modul dengan peringatan". Settings editing dan audit-event list
**tidak** diduplikasi — tetap link ke `/admin/modules/{moduleKey}` yang
sudah punya keduanya.

**Preset (#565's `applyModulePreset`) SENGAJA TIDAK diwire ke layar ini** —
butuh endpoint API + OpenAPI + guard + test baru, unit kerja tersendiri yang
cukup besar; dicatat sebagai follow-up terpisah, bukan dipaksakan masuk
issue ini.

**Binding split sama seperti #563**: SSR baca langsung (`withTenant` +
`fetchModuleMatrix`), setiap mutasi (enable/disable) lewat
`/api/v1/tenant/modules/{moduleKey}/enable|disable` (#515) yang sudah ada —
tidak ada shortcut SSR privileged. Kedua endpoint itu **tidak** butuh
`Idempotency-Key` (dicek langsung dari `enable.ts`/`disable.ts`), jadi tidak
dikirim di sini — beda dari `verify`/`set-primary` #563 yang butuh.

Test: `tests/integration/module-tenant-matrix.integration.test.ts`. Detail
lengkap: `module-management/README.md` §Tenant-module matrix admin UI.

### Cloudflare DNS adapter (Issue #567, `tenant_domain`)

Provider boundary saja — **belum ada rute apa pun** di repo ini yang
memanggilnya (menyelesaikan `.../verify` dengan panggilan DNS nyata, atau
"provision platform subdomain", tetap follow-up terbuka). Manual domain
management (`POST /api/v1/tenant/domains/{id}/verify`, #562) tetap default
MVP tanpa perubahan — tidak ada var baru yang wajib.

**Env baru** (`domain/tenant-domain-dns-config.ts`,
`scripts/validate-env.ts`'s `checkTenantDomainDnsConfig`), semuanya
opsional/backward-compatible:

- `TENANT_DOMAIN_DNS_PROVIDER` — `manual` (default) | `cloudflare`.
- `TENANT_DOMAIN_PLATFORM_ROOT_DOMAIN` — wajib bila `cloudflare`. **Var
  terpisah** dari `PUBLIC_PLATFORM_ROOT_DOMAIN` (#556) meski keduanya
  biasanya bernilai sama secara operasional: `PUBLIC_PLATFORM_ROOT_DOMAIN`
  menggerbangi resolver host-based publik (#559, siapa yang boleh
  di-_resolve_ jadi tenant); var ini menggerbangi hostname mana yang
  boleh disentuh adapter Cloudflare (siapa yang boleh dibuatkan/dicek
  record DNS-nya) — juga mencerminkan batasan nyata API Cloudflare (satu
  zone id/token hanya bisa mengelola record di dalam zone-nya sendiri).
  Jangan gabungkan kedua var ini di issue lanjutan mana pun.
- `TENANT_DOMAIN_CLOUDFLARE_ZONE_ID` — wajib bila `cloudflare`.
- `TENANT_DOMAIN_CLOUDFLARE_API_TOKEN` — wajib bila `cloudflare`, secret
  sungguhan. Hanya dari env/secret manager — **tidak pernah** disimpan di
  `awcms_mini_tenant_domains`/`awcms_mini_module_settings`/tabel lain, tidak
  pernah dirender di admin UI mana pun (menegakkan §Aturan lintas-issue #7
  di bawah).
- `TENANT_DOMAIN_CLOUDFLARE_TIMEOUT_MS` — selalu opsional, bahkan saat
  `cloudflare` dipilih. Timeout per panggilan (ms); kosong/tidak valid
  selalu jatuh ke default aman (8 detik), tidak pernah gagalkan boot —
  bukan bagian `TENANT_DOMAIN_CLOUDFLARE_REQUIRED_WHEN_SELECTED`, dan tidak
  dicek `checkTenantDomainDnsConfig` (pola sama `EMAIL_SEND_TIMEOUT_MS`).
  Fix dari security audit follow-up PR #580 — sebelumnya hardcoded, lihat
  "Sudah diperbaiki" di bawah.

**Adapter** (`infrastructure/cloudflare-dns-adapter.ts`) — port
`TenantDomainDnsProvider` dengan dua method, keduanya timeout-bounded
(`withTimeout`, default 8 detik, tunable lewat
`TENANT_DOMAIN_CLOUDFLARE_TIMEOUT_MS`) dan digerbangi circuit breaker bersama
(`getProviderCircuitBreaker("tenant-domain-cloudflare-dns")`), pola persis
`email/infrastructure/mailketing-provider.ts` dan
`sync-storage/infrastructure/object-storage-uploader.ts`. Keduanya dipanggil
di luar transaksi DB mana pun (ADR-0006) — file ini tidak pernah membuka
`sql.begin(...)`:

- `createVerificationRecord({recordType, recordName, recordValue})` —
  **idempotent by construction**: list dulu record yang match
  type/name/content persis, return `{ok:true, alreadyExists:true}` tanpa
  write kedua kalau sudah ada, bukan mengandalkan kode error duplicate
  Cloudflare tertentu.
- `checkVerificationStatus({recordType, recordName, expectedValue})` — list
  record pada name/type itu, bandingkan content (CNAME dinormalisasi:
  strip trailing dot + lowercase sebelum dibandingkan).

**Validasi input mengikat** (`validateDnsRecordInput`, exported, pure):
`recordName` wajib persis `TENANT_DOMAIN_PLATFORM_ROOT_DOMAIN` atau
subdomain-nya — ditolak SEBELUM panggilan network apa pun. Shape check
`recordName` **sengaja bukan** reuse `normalizePublicHost()` (#559): nama
record verifikasi DNS lazim berlabel underscore-prefix (mis.
`_acme-challenge.example.com`, `_awcms-verify.tenant1.platform.example`)
yang shape-check `Host` header (`normalizePublicHost`) menolaknya, padahal
konvensi ini valid dan lazim untuk TXT record verifikasi — lihat
`isValidDnsRecordNameShape` (fungsi baru, dedicated) di file adapter.
`normalizePublicHost()` tetap dipakai ulang, tidak berubah, untuk
memvalidasi _target_ CNAME (hostname sungguhan yang dituju, bukan label
record).

**Redaksi error mengikat**: error HTTP dari Cloudflare tidak pernah
menyertakan `errors[].message` mentah — hanya kode numerik
`errors[].code` yang disurfacekan (aman, tidak identifiable). Teks error
apa pun yang di-throw (network failure, timeout) juga melewati `redact()`
yang menghapus nilai `apiToken`/`zoneId` yang dikonfigurasi sebagai defense
in depth (mis. error jaringan yang pesannya kebetulan menyertakan URL
request, yang menyertakan zone id) sebelum dipotong ke 300 karakter. Tidak
pernah stack trace.

`resolveTenantDomainDnsProvider(env)` — resolver produksi (mirror
`resolveEmailProvider`/`resolveObjectUploader`): membangun provider
Cloudflare sungguhan kalau lengkap terkonfigurasi, atau stub aman yang
selalu `{ok:false}` dengan pesan jelas (tidak pernah throw) untuk mode
`manual`, provider tak dikenal, atau `cloudflare` yang kurang salah satu
dari tiga var wajib. **Belum dipanggil dari mana pun** di issue ini — tidak
ada route yang wire ke sini.

Test: `tests/unit/cloudflare-dns-adapter.test.ts` (`validateDnsRecordInput`
pure cases; lalu terhadap `Bun.serve` fake server lokal — sukses,
idempotent re-create, provider error dengan bukti redaksi terhadap server
yang sengaja meng-echo token/zone id di `errors[].message`, timeout,
circuit breaker trip, dan `resolveTenantDomainDnsProvider`'s perilaku
env hilang/tidak-dikenal/`cloudflare` tidak lengkap).
`tests/validate-env.test.ts`'s `describe("checkTenantDomainDnsConfig", ...)`
menguji aturan gating env di atas. Detail lengkap:
`src/modules/tenant-domain/README.md` §Cloudflare DNS adapter.

## Aturan lintas-issue yang wajib diikuti

1. **Backward compatibility non-negotiable**: setiap deployment offline/LAN existing yang tidak pernah set `PUBLIC_*` apa pun harus tetap `config:validate` PASS dan berperilaku persis seperti sebelum epic ini — jangan pernah membuat salah satu dari enam var config ini menjadi wajib secara default.
2. **`PUBLIC_TRUST_PROXY=false` harus tetap default aman** di setiap lapisan baru — jangan baca `X-Forwarded-Host`/`X-Forwarded-Proto` kecuali `PUBLIC_TRUST_PROXY=true` eksplisit diset. Resolver #559 sudah menegakkan ini (`resolvePublicTenantFromRequest`'s `config.trustProxy`, default `false`); API domain #562 manapun yang membaca header host langsung (bukan lewat resolver ini) wajib pola yang sama.
3. **`/blog/{tenantCode}` (ADR-0009, skill `awcms-mini-blog-content`) TIDAK dihapus** — epic #555 secara eksplisit out-of-scope untuk "removing legacy `/blog/{tenantCode}` routes in the MVP". `/news` (#560) adalah rute **tambahan**, bukan pengganti. Issue #561 (selesai — `docs/adr/0010-public-host-tenant-routing.md`) mendokumentasikan `/blog/{tenantCode}` sebagai legacy, bukan menghapusnya.
4. **Jangan trust `X-Forwarded-Host` tanpa proxy tepercaya** — ulangi dari epic #555 §Security notes. Berlaku juga untuk API domain #562 manapun yang membaca header host secara independen dari resolver #559.
5. **Tenant existence tidak boleh bocor**: domain/tenant yang unknown, failed, suspended, atau inactive harus menghasilkan respons yang identik/tidak bisa dibedakan (pola sama seperti ADR-0009's 404 identik untuk `tenantCode` tak dikenal vs tenant tidak aktif) — resolver #559 sudah menegakkan ini (`resolvePublicTenantByHost`/`resolveDefaultPublicTenantFromEnv`/`resolveDefaultPublicTenantFromSetupState`/`resolvePublicTenantFromRequest` semua return `null` identik). Rute publik `/news` #560 **wajib** memetakan `null` resolver ini ke 404 generic yang sama, tidak menambah pesan/status yang membedakan kasus.
6. **Module disabled tetap diblokir server-side** — kalau tenant module presets (#565, selesai) atau tenant-module matrix (#566) menonaktifkan sebuah modul, endpoint modul itu wajib tetap menolak di server (guard ABAC/tenant-module lifecycle yang sudah ada dari `module_management`), bukan hanya disembunyikan di UI. Ditegakkan otomatis untuk #565 — `applyModulePreset` selalu lewat `disableTenantModule` yang sudah ada (tidak pernah menulis `awcms_mini_tenant_modules` langsung), jadi enforcement server-side yang sudah ada sejak Issue #515 tidak pernah dilewati.
7. **Provider secret (mis. Cloudflare API token, #567) tidak pernah disimpan di module descriptor atau kolom DB biasa** — pakai environment variable seperti provider lain (Mailketing, R2), dan `configure`-only permission gate seperti pola `email`/`sync-storage` provider config.
8. **Semua mutasi domain/module (create/update/delete domain mapping, enable/disable module preset) wajib diaudit** — pola `recordAuditEvent` yang sama dipakai modul lain, action literal sesuai konvensi modul (`tenant_domain.<resource>.<verb>` mengikuti pola `blog.<resource>.<verb>` dari blog_content). Resolver #559 sendiri **bukan** mutasi (read-only, anonymous) — tidak diaudit, sama seperti `resolvePublicTenantByCode` (ADR-0009) tidak diaudit.
9. **Cloudflare DNS adapter (#567) adalah opsional/enhancement**, bukan hard dependency — epic #555 §Out of scope eksplisit menyebut "making Cloudflare DNS automation a hard dependency" di luar scope. Tenant domain mapping (#557/#562) harus tetap berfungsi tanpa Cloudflare sama sekali (manual DNS setup oleh operator).
10. **`/news` routes (Issue #560, selesai) reuse `resolvePublicTenantFromRequest()` (Issue #559) langsung** lewat `withNewsTenant()` helper — tidak re-derive hostname→tenant lookup logic lain. `config.mode` untuk panggilan itu dibangun dari `PUBLIC_TENANT_RESOLUTION_MODE`/`PUBLIC_TRUST_PROXY` di `process.env` (resolver sendiri tidak membaca `process.env` untuk keduanya — sengaja, untuk testability; lihat §Resolver). `#562`'s admin API (mutasi domain, tenant-scoped, authenticated) **TIDAK** boleh reuse resolver #559 (yang anonymous/pre-tenant-context) — API #562 memakai `withTenant(...)` biasa seperti endpoint tenant-scoped lain, RLS `awcms_mini_tenant_domains` yang menjaga isolasinya, bukan fungsi `SECURITY DEFINER` (fungsi itu murni untuk bootstrap publik tanpa tenant context).

## Belum ada — jangan asumsikan sudah dikerjakan

**Epic #555 (#556-#567) sekarang 100% selesai** — semua 12 issue sudah
merge: config (#556), schema `awcms_mini_tenant_domains` (#557), module
descriptor `tenant_domain` (#558), resolver host-based (#559), rute publik
`/news` (#560), dokumentasi legacy/ADR-0010 (#561), API tenant domain
management (#562, §API di atas), admin UI (#563, §Admin UI di atas), tenant
settings public route `blog_content` (#564, §Tenant settings public route di
atas), tenant module presets (#565, §Tenant module presets di atas —
service layer saja), tenant-module matrix admin UI (#566, §Tenant-module
matrix admin UI di atas — single-tenant scope, lihat keputusan mengikat di
bagian itu), dan adapter Cloudflare DNS opsional (#567, §Cloudflare DNS
adapter di atas — provider boundary saja, **belum ada route yang
memanggilnya**, lihat follow-up #4 di bawah).

Tabel `awcms_mini_tenant_domains` sekarang bisa ditulis lewat kode aplikasi
(API #562 + admin UI #563) — bukan lagi schema-only. Operator yang
benar-benar mengisi baris nyata lewat UI/API dan mengaktifkan
`PUBLIC_TENANT_RESOLUTION_MODE=host_default` membuat resolver #559 langkah 1
(host/domain mapping asli) benar-benar reachable di production untuk
pertama kalinya — lihat konsekuensi keamanan di ADR-0010 §Konsekuensi
sebelum mengaktifkan mode itu.

**Follow-up non-blocking untuk issue lanjutan mana pun yang menyentuh area
ini** (bukan gate merge #567, dicatat di sini supaya tidak di-re-derive):

4. `infrastructure/cloudflare-dns-adapter.ts` (#567) belum di-wire ke rute
   apa pun — `POST /api/v1/tenant/domains/{id}/verify` (#562) tetap
   manual-first murni (tidak ada panggilan DNS/HTTP keluar). Issue lanjutan
   yang ingin menambah verifikasi Cloudflare otomatis harus: (a) memanggil
   `resolveTenantDomainDnsProvider(env)`/`createCloudflareDnsProvider` di
   luar transaksi DB `withTenant` mana pun (ADR-0006 — adapter ini sendiri
   tidak pernah membuka transaksi, tapi endpoint pemanggilnya wajib tetap
   menjaga aturan itu), (b) tetap treat hasil provider sebagai _input_ ke
   `verifyTenantDomain` yang sudah ada, bukan menggantikannya, dan (c) tetap
   audit `tenant_domain.domain.verified` seperti sekarang — jangan tambah
   audit event kedua khusus "cloudflare check" kecuali ada kebutuhan produk
   eksplisit.

**Follow-up non-blocking dari security audit #562** (verdict PASS, tidak ada Critical/High — item ini dicatat sebagai perbaikan lanjutan, bukan gate merge):

3. **Klasifikasi `set_primary` di luar `HIGH_RISK_ACTIONS`** (`identity-access/domain/access-control.ts`) layak ditinjau ulang untuk konsistensi jangka panjang — `isHighRiskAction()` tidak dikonsumsi di mana pun hari ini (murni metadata, audit dan `Idempotency-Key` tetap ditegakkan eksplisit per-endpoint terlepas dari klasifikasi ini), tapi blast radius `set_primary` (mengubah tenant mana yang jadi canonical redirect target untuk traffic publik anonim) berpotensi lebih besar daripada `delete` (yang sudah masuk `HIGH_RISK_ACTIONS`). Tidak berdampak fungsional sekarang; pertimbangkan saat `isHighRiskAction()` mulai dikonsumsi (mis. rate limiting tambahan, step-up auth).

Sudah diperbaiki (follow-up lintas-modul dari audit #562, bukan follow-up lagi): **race idempotency-store lintas-modul** (`src/modules/_shared/idempotency.ts`, dipakai `verify`/`set-primary` #562 dan setiap endpoint idempotent lain di repo) — dua request paralel dengan `Idempotency-Key` yang SAMA bisa sama-sama lolos `findIdempotencyRecord` di bawah READ COMMITTED sebelum salah satu commit; yang kalah dulu gagal pada unique index `awcms_mini_idempotency_keys_scope_key` (migration 012) tanpa ditangkap (raw error/500). Fix: `saveIdempotencyRecord` sekarang `INSERT ... ON CONFLICT (tenant_id, request_scope, idempotency_key) DO NOTHING RETURNING id`; kalau kalah race, `SELECT` ulang row pemenang (dijamin sudah committed) dan bandingkan `request_hash` — hash sama (payload identik, retry jaringan murni) → lempar `IdempotencyRaceLostError` membawa `replay` (response pemenang), hash beda (genuine conflict) → `replay: null`. `withTenant` (`src/lib/database/tenant-context.ts`) menangkapnya di satu titik — rollback transaksi (mutation loser tidak pernah persist, "double submit paralel -> tidak dobel" tetap tegak), skip circuit breaker (bukan infra failure), log `idempotency.race_lost` (key di-hash, bukan raw), lalu **replay response pemenang** (bukan 409) kalau hash sama — menegakkan aturan "hash sama → replay" yang sudah ada bahkan saat kalah race — atau `409 IDEMPOTENCY_CONFLICT` bersih kalau hash beda. Berlaku otomatis untuk semua ~25 route pemakai `withTenant`, bukan spesifik `tenant_domain`. Test: `tests/integration/tenant-domain-api.integration.test.ts`'s "set-primary under concurrent SAME Idempotency-Key + SAME payload" (dua-duanya 200 lewat replay, tepat satu audit event + satu row idempotency key) dan "verify under concurrent SAME Idempotency-Key + DIFFERENT payload" (satu 200 satu 409 bersih; sengaja pakai `verify` pada dua domain berbeda, bukan `set-primary`, supaya tidak bercampur dengan race index primary-dedup `set-primary` sendiri yang sudah punya test terpisah). Detail: doc 16 §Idempotency store, skill `awcms-mini-idempotency` §Verifikasi. (Ditemukan awcms-mini-reviewer saat review PR ini: revisi awal hanya melempar 409 tanpa pengecekan hash, melanggar aturan "hash sama → replay" untuk kasus race; diperbaiki sebelum merge.)

Sudah diperbaiki (follow-up dari security audit #560, bukan follow-up lagi): **`fetchTenantModuleEntries` membaca status SEMUA modul terdaftar**, bukan cuma `blog_content` (`public-news-tenant-resolution.ts`) — bukan risiko DoS nyata (satu query indexed murah, filtering di memori), tapi melanggar prinsip "read surface publik seminimal mungkin" resolver #559 untuk gate anonim yang cuma butuh status satu modul. Fix: `fetchTenantModuleEntry` (singular, baru — `module-management/application/tenant-module-lifecycle.ts`) — narrowing yang `SELECT`-nya di-filter `module_key = $2`, bukan membaca semua row tenant lalu filter di memori; dipakai `checkBlogContentAndRouteGate` (satu-satunya pemanggil, dipakai identik oleh jalur resolve sungguhan maupun `padUnresolvedTenantLatency`, jadi paritas round-trip timing #562 tidak berubah — sama-sama tetap 1 query untuk cek modul). `fetchTenantModuleEntries` (plural) tidak dihapus — 3 konsumen lain (`GET /api/v1/tenant/modules`, tenant module presets, tenant-module matrix UI) tetap butuh daftar lengkap dan tetap memakainya. Test: `tests/integration/module-tenant-lifecycle.integration.test.ts`'s "fetchTenantModuleEntry ... matches the plural function's per-entry result before and after a real disable" dan `tests/integration/blog-content-public-news.integration.test.ts`'s round-trip-parity test yang sudah ada (masih hijau tanpa perubahan — jumlah round trip tetap 1 baik pakai fungsi lama maupun baru).

Sudah diperbaiki (follow-up dari security audit PR #580, bukan follow-up lagi): **timeout adapter Cloudflare hardcoded, tidak env-tunable** (`cloudflare-dns-adapter.ts`'s `DEFAULT_TIMEOUT_MS = 8_000`, tidak ada cara mengubahnya per-deployment). Fix: `resolveTenantDomainCloudflareTimeoutMs(env)` (baru, `domain/tenant-domain-dns-config.ts`) — pola persis `email/domain/email-config.ts`'s `resolveEmailSendTimeoutMs`: baca `TENANT_DOMAIN_CLOUDFLARE_TIMEOUT_MS`, jatuh ke default kalau kosong/bukan angka positif, tidak pernah gagalkan boot (bukan bagian `TENANT_DOMAIN_CLOUDFLARE_REQUIRED_WHEN_SELECTED`, tidak dicek `checkTenantDomainDnsConfig`, sama seperti `EMAIL_SEND_TIMEOUT_MS`). `resolveTenantDomainDnsProvider(env)` sekarang memanggilnya untuk mengisi `timeoutMs` provider Cloudflare. Test: `tests/unit/cloudflare-dns-adapter.test.ts`'s `describe("resolveTenantDomainCloudflareTimeoutMs", ...)`.

Sudah diperbaiki di #560 (bukan follow-up lagi): guard module-disabled sekarang fail-closed (`!blogContentEntry?.tenantEnabled`, bukan `blogContentEntry && !blogContentEntry.tenantEnabled`) — entry yang hilang dianggap disabled, bukan enabled by default.

Sudah diperbaiki bersamaan dengan #562 (bukan follow-up lagi): **timing side-channel di `withNewsTenant`** (`public-news-tenant-resolution.ts`) — tiga outcome yang seharusnya identik (tenant tidak resolve / `tenant_code_legacy` / module `blog_content` disabled untuk tenant) dulu punya biaya latency berbeda (tenant tidak resolve = tidak buka transaksi sama sekali; tenant resolve tapi module disabled = buka `withTenant` + 1 query `fetchTenantModuleEntries`), sehingga prober eksternal dengan `Host` header berbeda-beda bisa membedakan "hostname termapping ke tenant aktif" dari "hostname tidak dikenal" murni lewat waktu respons begitu #562 mengisi `awcms_mini_tenant_domains` dengan mapping nyata. Fix: `padUnresolvedTenantLatency()` (baru,
`public-news-tenant-resolution.ts`) membebankan biaya round-trip yang SAMA pada jalur "tenant tidak resolve" — buka transaksi lewat `withTenant` yang sama, `SET LOCAL` GUC tenant ke UUID nol (sentinel fail-closed migration 013, tidak pernah cocok dengan tenant nyata), lalu satu `SELECT` ke `awcms_mini_tenant_modules` — persis bentuk round-trip yang sudah dibayar jalur module-disabled lewat `fetchTenantModuleEntries`. Pola "tambahkan cost tetap di jalur tidak-resolve" (bukan "gabungkan jadi satu query" seperti migration 033/#559, karena jalur tidak-resolve secara struktural tidak punya `tenant_id` nyata untuk digabung ke query yang sama). Test:
`tests/integration/blog-content-public-news.integration.test.ts`'s round-trip-counting test (pola Proxy yang sama seperti
`tests/integration/public-tenant-resolution.integration.test.ts`, diperluas untuk mengintersep `sql.begin(...)`/method call pada `tx` juga, bukan cuma pemanggilan `sql` langsung).

**Diperluas jadi EMPAT outcome bersamaan dengan #564** (bukan follow-up baru, perluasan mekanisme yang sudah ada): `publicRouteMode=disabled` (§Tenant settings public route di atas) adalah outcome ke-4 pada gate yang sama. Paritas ditegakkan struktural lewat `checkBlogContentAndRouteGate()` — dipanggil identik dari jalur resolve sungguhan maupun `padUnresolvedTenantLatency()`, jadi tak bisa drift secara desain. **Follow-up non-blocking dari security audit #564** (verdict PASS, tidak ada Critical/High):

4. Belum ada test `wrapCountingSql`-based yang secara eksplisit membandingkan round-trip count outcome `publicRouteMode=disabled` vs 3 outcome lainnya — paritas berlaku by construction (diverifikasi manual saat audit #564) tapi belum diuji langsung seperti paritas module-disabled vs enabled sudah diuji. Tambahkan test pembanding eksplisit bila menyentuh `checkBlogContentAndRouteGate`/`padUnresolvedTenantLatency` lagi.
5. Belum ada test regresi XSS eksplisit untuk `publicLabel`/`publicBasePath` di output `/news` (mitigasi sudah diverifikasi manual — `escapeHtml()` dipanggil di setiap titik render, tidak ada `set:html`/raw string concatenation — tapi belum jadi regression test otomatis yang mengirim payload `<script>` lalu assert output ter-escape). Tambahkan bila menyentuh rendering `/news` lagi.

Sudah diperbaiki (follow-up dari security audit #564, bukan follow-up lagi): **`validateModuleSettingsPatch` hanya memeriksa nama key, bukan bentuk nilai** (framework generik Issue #516, `module-management/domain/module-settings.ts`) — admin tenant (atau siapa pun dengan sesi admin) bisa menulis nilai credential-shaped ke field non-sensitif-namanya seperti `publicLabel` dan itu tersimpan mentah, terbaca lewat GET yang sama. Bukan regresi #564 (identik untuk semua modul yang pakai framework ini), tidak spesifik `blog_content`. Fix: `_shared/redaction.ts`'s baru `findSecretShapedValues` — heuristik bentuk-value yang sengaja konservatif (JWT tiga segmen, blok PEM private key, AWS access key id, header `Bearer`/`Basic` mentah, connection string ber-`user:pass@`) supaya label/URL/flag biasa tidak pernah salah tertolak — dipanggil `validateModuleSettingsPatch` setelah cek nama key; kalau ada yang cocok, `400 SETTINGS_SECRET_SHAPED_VALUE_REJECTED` (pesan error hanya menyebut _path_ key, tidak pernah value-nya sendiri). Berlaku otomatis untuk semua konsumen `PATCH .../settings` (satu route file, `tenant/modules/{moduleKey}/settings.ts`, sudah generik terhadap `ModuleSettingsErrorCode` apa pun) tanpa ubah route atau modul manapun. Test: `tests/audit-log.test.ts`'s `findSecretShapedValues` (unit, semua pola + no-false-positive pada label/URL/flag biasa) dan `tests/integration/module-settings.integration.test.ts`'s "PATCH rejects a secret-shaped VALUE under an innocently-named key".
