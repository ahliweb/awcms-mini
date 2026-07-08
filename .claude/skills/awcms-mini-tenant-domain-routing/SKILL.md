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

| Issue | Scope                                                         | Status                               |
| ----- | ------------------------------------------------------------- | ------------------------------------ |
| #556  | Online public mode config (`PUBLIC_*` env vars)               | **Selesai** — lihat §Config di bawah |
| #557  | Tenant domain/subdomain mapping schema                        | **Selesai** — lihat §Schema di bawah |
| #558  | Register module descriptor `tenant_domain`                    | Belum                                |
| #559  | Public host tenant resolver (dengan fallback)                 | Belum                                |
| #560  | Rute publik `/news` untuk `blog_content`                      | Belum                                |
| #561  | Dokumentasi legacy `/blog/{tenantCode}`                       | Belum                                |
| #562  | Tenant domain management API                                  | Belum                                |
| #563  | Admin UI domain/subdomain                                     | Belum                                |
| #564  | Tenant settings untuk rute `/news` vs legacy (`blog_content`) | Belum                                |
| #565  | Tenant module presets (online/news/LAN/minimal)               | Belum                                |
| #566  | Tenant-module matrix admin UI                                 | Belum                                |
| #567  | Cloudflare DNS adapter (opsional)                             | Belum                                |

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
  semua tabel tenant-scoped lain) — **tapi ini menciptakan bootstrap gap
  yang wajib diselesaikan #559**: query hostname→tenant_id butuh
  dijalankan SEBELUM tenant context ada, sementara FORCE RLS + fail-closed
  GUC (migration 013) membuat query tanpa `withTenant` selalu 0 baris.
  `awcms_mini_tenants` (migration 013) sengaja RLS-free untuk masalah
  bootstrap yang sama persis (lookup `tenantCode → tenant_id`, ADR-0009),
  tapi `tenant_domains` TIDAK BOLEH ikut jadi RLS-free (kolom
  `verification_token_hash` dkk. tenant-manageable). Resolusi yang
  didokumentasikan di migration 031's komentar untuk #559: buat jalur baca
  khusus (mis. fungsi `SECURITY DEFINER` yang cuma return `(tenant_id,
status, is_primary)`, atau role baca least-privilege terpisah) untuk
  satu query bootstrap ini — jangan lepas `FORCE ROW LEVEL SECURITY` dari
  tabel ini untuk mengakalinya.
- Permission seed: `module_key` `tenant_domain`, `activity_code` `domains`
  — `read`/`create`/`update`/`delete`/`verify`/`set_primary` (persis
  §Seed permissions issue #557). Belum ada role/access assignment yang
  memakainya (menunggu #562 dkk.).
- Test: `tests/integration/tenant-domain-schema.integration.test.ts`
  (idempotency, unique constraint case-insensitive, primary-per-tenant,
  soft-delete-frees-hostname, RLS isolation, fail-closed tanpa GUC, tidak
  ada kolom secret provider).

## Aturan lintas-issue yang wajib diikuti

1. **Backward compatibility non-negotiable**: setiap deployment offline/LAN existing yang tidak pernah set `PUBLIC_*` apa pun harus tetap `config:validate` PASS dan berperilaku persis seperti sebelum epic ini — jangan pernah membuat salah satu dari enam var config ini menjadi wajib secara default.
2. **`PUBLIC_TRUST_PROXY=false` harus tetap default aman** di setiap lapisan baru (resolver #559, dst.) — jangan baca `X-Forwarded-Host`/`X-Forwarded-Proto` kecuali `PUBLIC_TRUST_PROXY=true` eksplisit diset.
3. **`/blog/{tenantCode}` (ADR-0009, skill `awcms-mini-blog-content`) TIDAK dihapus** — epic #555 secara eksplisit out-of-scope untuk "removing legacy `/blog/{tenantCode}` routes in the MVP". `/news` (#560) adalah rute **tambahan**, bukan pengganti. Issue #561 mendokumentasikan `/blog/{tenantCode}` sebagai legacy, bukan menghapusnya.
4. **Jangan trust `X-Forwarded-Host` tanpa proxy tepercaya** — ulangi dari epic #555 §Security notes, berlaku untuk resolver #559 dan API domain #562 manapun yang membaca header host.
5. **Tenant existence tidak boleh bocor**: domain/tenant yang unknown, failed, suspended, atau inactive harus menghasilkan respons yang identik/tidak bisa dibedakan (pola sama seperti ADR-0009's 404 identik untuk `tenantCode` tak dikenal vs tenant tidak aktif) — berlaku untuk resolver #559 dan rute publik `/news` #560.
6. **Module disabled tetap diblokir server-side** — kalau tenant module presets (#565) atau tenant-module matrix (#566) menonaktifkan sebuah modul, endpoint modul itu wajib tetap menolak di server (guard ABAC/tenant-module lifecycle yang sudah ada dari `module_management`), bukan hanya disembunyikan di UI.
7. **Provider secret (mis. Cloudflare API token, #567) tidak pernah disimpan di module descriptor atau kolom DB biasa** — pakai environment variable seperti provider lain (Mailketing, R2), dan `configure`-only permission gate seperti pola `email`/`sync-storage` provider config.
8. **Semua mutasi domain/module (create/update/delete domain mapping, enable/disable module preset) wajib diaudit** — pola `recordAuditEvent` yang sama dipakai modul lain, action literal sesuai konvensi modul (`tenant_domain.<resource>.<verb>` mengikuti pola `blog.<resource>.<verb>` dari blog_content).
9. **Cloudflare DNS adapter (#567) adalah opsional/enhancement**, bukan hard dependency — epic #555 §Out of scope eksplisit menyebut "making Cloudflare DNS automation a hard dependency" di luar scope. Tenant domain mapping (#557/#562) harus tetap berfungsi tanpa Cloudflare sama sekali (manual DNS setup oleh operator).

## Belum ada — jangan asumsikan sudah dikerjakan

Semua isu #558-#567 (module descriptor `tenant_domain`, resolver
host-based, rute publik `/news`, dokumentasi legacy, API tenant domain,
admin UI domain, tenant settings rute `/news`/legacy di `blog_content`,
module presets, matrix UI admin, dan adapter Cloudflare DNS) **belum ada**
— hanya lapisan config (#556) dan schema `awcms_mini_tenant_domains`
(#557) yang selesai. Jangan asumsikan resolver host-based sudah bisa
dipakai; env var `PUBLIC_PLATFORM_ROOT_DOMAIN`/`PUBLIC_TRUST_PROXY` baru
**divalidasi dan didokumentasikan**, belum **dikonsumsi** oleh kode
resolver apa pun. Tabel `awcms_mini_tenant_domains` baru berisi schema +
constraint + RLS + permission catalog seed — belum ada baris yang pernah
ditulis lewat kode aplikasi (menunggu #562's API), dan belum ada resolver
yang membacanya (menunggu #559, yang juga harus menyelesaikan RLS
bootstrap gap yang didokumentasikan di §Schema di atas dan di migration
031's komentar sebelum bisa query tabel ini tanpa tenant context).
