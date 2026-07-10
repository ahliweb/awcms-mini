---
name: awcms-mini-visitor-analytics
description: Kerjakan bagian mana pun dari epic visitor analytics AWCMS-Mini (Issue #617-#624). Gunakan saat menambah/mengubah VISITOR_ANALYTICS_* env config, skema session/event/rollup, helper identity/UA/bot classification, middleware collector, API/dashboard `/admin/analytics`, enrichment geolokasi, atau job rollup/retention purge. Merangkum keputusan yang sudah dibuat supaya issue lanjutan tidak mengulang/kontradiksi.
---

# AWCMS-Mini — Visitor Analytics

Epic visitor analytics (#617-#624) menambah **statistik pengunjung manusia
privacy-first** untuk rute admin dan publik, di konfigurasi online maupun
offline/LAN. Modul baru `visitor_analytics` (`type: "system"`) — bukan
diperluas dari `reporting`/`logging` yang sudah ada, karena volume,
retensi, dan kontrol privasi visitor telemetry berbeda dari keduanya
(lihat `src/modules/visitor-analytics/README.md` §Why a separate module).

## Kapan pakai skill ini vs skill generik

Skill ini melengkapi (bukan menggantikan) `awcms-mini-new-endpoint`,
`awcms-mini-new-migration`, `awcms-mini-new-module`,
`awcms-mini-abac-guard`, `awcms-mini-sensitive-data` (IP/user-agent/geo
adalah data sensitif), `awcms-mini-ui-screen` (dashboard #622), dan
`awcms-mini-observability` (retensi/purge, korelasi dengan audit log yang
sudah ada). Skill ini menyediakan konteks **cross-cutting epic
spesifik** yang menjembatani beberapa issue sekaligus.

## Status per issue (jangan bangun ulang yang sudah ada)

| Issue | Scope                                                          | Status                               |
| ----- | -------------------------------------------------------------- | ------------------------------------ |
| #617  | Module descriptor, permission catalog, config gate             | **Selesai** — lihat §Config di bawah |
| #618  | Visitor session/event/rollup schema + RLS                      | **Selesai** — lihat §Schema di bawah |
| #619  | Visitor identity, user-agent, human/bot classification helpers | Belum dikerjakan                     |
| #620  | Middleware telemetry collection (admin + public)               | Belum dikerjakan                     |
| #621  | Analytics API + OpenAPI contract (`/api/v1/analytics`)         | Belum dikerjakan                     |
| #623  | Trusted online geolocation enrichment                          | Belum dikerjakan                     |
| #622  | Admin visitor analytics dashboard UI (`/admin/analytics`)      | Belum dikerjakan                     |
| #624  | Rollup job, retention purge job, readiness checks, docs pass   | Belum dikerjakan                     |

Urutan dependency (dari body issue masing-masing): 617 → 618 → 619 → 620 →
621 → 622; 623 boleh setelah 620 (paralel dengan 621/622); 624 butuh
617+618+620+621 dan melengkapi 622/623.

## Yang sudah ada — pakai ulang, jangan re-derive

### Config (Issue #617, `src/modules/visitor-analytics/domain/visitor-analytics-config.ts`)

Enam belas env var, semuanya **opsional** dan privacy-first — kalau tidak
di-set sama sekali, `config:validate` tetap PASS dan tidak ada raw IP/raw
user-agent/geolokasi yang tersimpan:

- `VISITOR_ANALYTICS_ENABLED` (default `true`) — master switch.
- `VISITOR_ANALYTICS_MODE` (default `basic`) — enum `basic | detailed`
  (`VISITOR_ANALYTICS_MODES`, `isKnownVisitorAnalyticsMode`). Nilai tak
  dikenal jatuh ke `basic`, tidak pernah throw.
- `VISITOR_ANALYTICS_COLLECT_ADMIN` / `_COLLECT_PUBLIC` / `_COLLECT_API` —
  toggle per permukaan (default `true`/`true`/`false`).
- `VISITOR_ANALYTICS_DETAILED_ENABLED` — cadangan mode `detailed` (default
  `false`, belum dikonsumsi apa pun).
- `VISITOR_ANALYTICS_RAW_IP_ENABLED` / `_RAW_USER_AGENT_ENABLED` /
  `_GEO_ENABLED` — **default `false` semuanya**, ini inti privacy-first
  gate-nya. Independen dari `VISITOR_ANALYTICS_MODE` — mode tidak pernah
  menyalakan ketiganya secara implisit.
- `VISITOR_ANALYTICS_TRUST_PROXY` / `_TRUST_CLOUDFLARE` — default `false`;
  sama prinsip keamanan dengan `PUBLIC_TRUST_PROXY` (skill
  `awcms-mini-tenant-domain-routing`) — hanya `true` di belakang proxy
  tepercaya yang benar-benar mengisi ulang header, bukan meneruskan nilai
  klien.
- Empat var retensi/jendela — `VISITOR_ANALYTICS_ONLINE_WINDOW_SECONDS`
  (300), `_EVENT_RETENTION_DAYS` (90), `_RAW_DETAIL_RETENTION_DAYS` (30),
  `_ROLLUP_RETENTION_DAYS` (730) — divalidasi `parsePositiveInt`, wajib
  integer positif **bila diisi**; tak diisi → default di atas, tidak
  pernah gagal validasi.
- `VISITOR_ANALYTICS_HASH_SALT` (default `""`) — salt untuk fingerprint
  visitor pseudonymous, dikonsumsi Issue #619 (belum ada fungsi hashing
  apa pun yang membacanya sampai issue itu).

Entry point: `resolveVisitorAnalyticsConfig(env)` — SATU fungsi yang
harus dipanggil issue lanjutan (#619 helper, #620 middleware), jangan
re-derive baca `process.env.VISITOR_ANALYTICS_*` langsung. Gate boolean
tunggal: `isVisitorAnalyticsEnabled(env)`.

Validasi: `checkVisitorAnalyticsConfig()` (`scripts/validate-env.ts`),
dipanggil dari `runEnvValidation()`. Didokumentasikan di
`docs/awcms-mini/18_configuration_env_reference.md` §Visitor analytics.
Test: `tests/unit/visitor-analytics-config.test.ts`,
`tests/validate-env.test.ts`'s `describe("checkVisitorAnalyticsConfig", ...)`.

### Module descriptor (Issue #617, `src/modules/visitor-analytics/module.ts`)

Modul `visitor_analytics` terdaftar di `src/modules/index.ts`'s
`listModules()`. **Hanya descriptor + config** — tidak ada tabel/API/UI/
middleware di sini, itu semua issue lanjutan.

- `key: "visitor_analytics"`, `type: "system"` (bukan `"domain"`) —
  observability infrastructure yang dipakai bersama semua tenant, sama
  alasan dengan `reporting`/`logging`/`tenant_domain`.
- `dependencies: ["tenant_admin", "identity_access", "logging", "reporting"]`
  (persis daftar di body issue #617).
- `api: { basePath: "/api/v1/analytics", openApiPath:
"openapi/awcms-mini-public-api.openapi.yaml" }` dan `navigation: [{
path: "/admin/analytics", requiredPermission:
"visitor_analytics.dashboard.read", order: 70 }]` **dideklarasikan
  sekarang** meski API (#621)/dashboard (#622) belum ada — konvensi sama
  dengan `tenant_domain`'s descriptor sebelum #562. Konsekuensinya sama:
  Module Management's `openApiDocumentedSignal` akan `fail` untuk modul
  ini sampai #621 menambah path OpenAPI nyata.
- `permissions`: 8 entry (`dashboard.read`, `realtime.read`,
  `sessions.read`, `events.read`, `raw_detail.read`, `settings.read`,
  `settings.update`, `retention.purge`), match persis seed migration 038
  — divalidasi `tests/modules/visitor-analytics-module.test.ts`.
  `raw_detail.read` **sengaja terpisah** dari `dashboard.read` — operator
  bisa memberi akses dashboard agregat tanpa memberi akses PII mentah
  (IP/user-agent).
- Tidak ada field `settings`/`jobs`/`health` — belum ada
  settings-API/job/health-check nyata untuk didokumentasikan (konsisten
  konvensi `module_management/README.md`, lihat juga precedent
  `tenant_domain` Issue #558).
- Tidak ada folder `application/`/`infrastructure`/`api` yang dibuat di
  Issue #617 — hanya `module.ts` + `domain/visitor-analytics-config.ts` +
  `README.md`. Folder lain menyusul issue yang benar-benar butuh
  (#618 schema, #619 helpers, #620 middleware, #621 API).

Permission migration: `sql/038_awcms_mini_visitor_analytics_permissions.sql`
— pola sama `sql/032_awcms_mini_tenant_domain_permissions.sql` (`INSERT ...
ON CONFLICT (module_key, activity_code, action) DO NOTHING`), belum ada
role/access assignment yang memakainya.

### Schema (Issue #618, `sql/039_awcms_mini_visitor_analytics_schema.sql`)

Tiga tabel tenant-scoped, semua `ENABLE`+`FORCE ROW LEVEL SECURITY` dengan
policy standar `tenant_id = current_setting('app.current_tenant_id')::uuid`.
**Schema saja — belum ada writer**: middleware (#620) belum menulis apa
pun ke sini.

- `awcms_mini_visitor_sessions` — satu baris per sesi presence. `area IN
('admin','public','api','auth','setup','unknown')`, `device_type IN
('desktop','mobile','tablet','bot','unknown')` (nullable). `ip_address`
  (raw `inet`) nullable, hanya diisi kalau
  `VISITOR_ANALYTICS_RAW_IP_ENABLED=true`. `login_identifier_snapshot`
  nullable, **tidak boleh** diisi untuk pengunjung publik anonim.
- `awcms_mini_visit_events` — satu baris per page-view/API call.
  `human_status IN ('human','bot','unknown')`, `status_code` (nullable)
  wajib 100-599 bila diisi. Dua kolom `jsonb` catch-all
  (`user_agent_parsed`, `geo`) default `'{}'::jsonb` — hanya untuk nilai
  hasil parse (Issue #619/#623), tidak pernah raw request data.
- `awcms_mini_visitor_daily_rollups` — `PRIMARY KEY (tenant_id, date,
area)`, sekaligus target upsert job rollup (#624). Tidak ada index
  terpisah `(tenant_id, date, area)` — PK sudah menyediakannya, index
  redundan yang diminta issue sengaja tidak dibuat.

Tidak ada `deleted_at`/soft delete di tiga tabel ini (bukan master/config
data) — lifecycle-nya purge berbasis retensi (job Issue #624), pola sama
`awcms_mini_audit_events` (migration 011).

Test: `tests/integration/visitor-analytics-schema.integration.test.ts` —
constraint check per tabel, RLS isolation lintas tenant, fail-closed tanpa
GUC, dan scan kolom memastikan tidak ada kolom berbentuk secret (password/
token/cookie/authorization/request_body).

Docs: `docs/awcms-mini/04_erd_data_dictionary.md` §Visitor Analytics
(ERD ringkas) dan §Retention awal (dua baris retensi baru).

**Temuan security-auditor Issue #618 (Medium, binding untuk Issue #620,
bukan blocker PR #618 sendiri — schema-only, belum ada writer):** FK biasa
(`identity_id uuid REFERENCES awcms_mini_identities (id)`,
`visitor_session_id uuid REFERENCES awcms_mini_visitor_sessions (id)`)
**tidak dilindungi RLS** — constraint-check FK PostgreSQL berjalan dengan
privilege owner tabel, bukan role pemanggil (dokumentasi resmi
`CREATE POLICY`: "foreign key references are not restricted by row
security"). Kalau nilai `identity_id`/`visitor_session_id` yang ditulis
Issue #620 pernah berasal dari input yang dikontrol client (bukan
di-derive dari session/tenant context di server), ini jadi **existence
oracle lintas tenant** (attacker bisa binary-search UUID buat tahu
"row ini ada di suatu tenant" vs "row ini tidak ada sama sekali", lepas
dari RLS). **Wajib dipertahankan Issue #620**: `identity_id` selalu
di-derive dari identity sesi terautentikasi milik request itu sendiri
(tidak pernah dari field yang bisa diisi client), `visitor_session_id`
selalu di-resolve server-side dari cookie/token opaque yang di-lookup di
dalam tenant context pemanggil sendiri (tidak pernah dari raw UUID
client yang langsung dicocokkan ke FK). Tambahkan test integrasi di #620
yang membuktikan UUID palsu/lintas-tenant di salah satu field ditolak
sebelum sempat menyentuh FK.

## Prinsip yang wajib dipertahankan di setiap issue lanjutan

1. **Privacy-first default** — raw IP, raw user-agent, geolokasi selalu
   default mati. Jangan pernah membuat issue lanjutan menyalakannya secara
   implisit lewat `VISITOR_ANALYTICS_MODE=detailed` atau flag lain; wajib
   opt-in eksplisit per flag masing-masing.
2. **`raw_detail.read` terpisah dari `dashboard.read`** — endpoint/UI yang
   menampilkan IP/user-agent mentah wajib cek permission `raw_detail.read`
   secara eksplisit, bukan cukup `dashboard.read`.
3. **Tenant isolation** — skema (#618, sudah selesai) tenant-scoped + RLS
   `ENABLE`+`FORCE`, sama pola semua tabel tenant-scoped lain di repo ini
   (lihat `docs/adr/0003-postgresql-rls-multi-tenant.md`). Issue
   lanjutan yang menulis ke tabel ini (mis. #620) tetap wajib lewat
   `withTenant`, tidak pernah query langsung tanpa tenant context.
4. **Bukan dependency operasional** — koleksi telemetry tidak boleh
   memblokir/memperlambat request admin/publik yang sebenarnya (mis. tulis
   event lewat outbox/fire-and-forget, bukan inline blocking DB write di
   jalur request kritis) — prinsip sama ADR-0006 untuk provider eksternal.
5. **Retensi lebih pendek untuk data lebih sensitif** — raw detail (30
   hari default) < event (90 hari default) < rollup agregat (730 hari
   default). Jangan balik urutan ini di issue lanjutan tanpa alasan eksplisit.
6. **`VISITOR_ANALYTICS_HASH_SALT` bukan credential provider** — dipakai
   untuk fingerprint pseudonymous (dedup visitor tanpa cookie persisten),
   bukan untuk autentikasi apa pun. Jangan expose di response/log/audit.

## Referensi

- `src/modules/visitor-analytics/README.md` — detail per-issue di dalam modul.
- `docs/awcms-mini/18_configuration_env_reference.md` §Visitor analytics.
- `AGENTS.md` skill table.
