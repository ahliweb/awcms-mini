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
| #557  | Tenant domain/subdomain mapping schema                        | Belum                                |
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

Semua isu #557-#567 (schema tenant domain, module descriptor
`tenant_domain`, resolver host-based, rute publik `/news`, dokumentasi
legacy, API tenant domain, admin UI domain, tenant settings rute
`/news`/legacy di `blog_content`, module presets, matrix UI admin, dan
adapter Cloudflare DNS) **belum ada** — hanya lapisan config (#556) yang
selesai. Jangan asumsikan resolver host-based sudah bisa dipakai; env var
`PUBLIC_PLATFORM_ROOT_DOMAIN`/`PUBLIC_TRUST_PROXY` baru **divalidasi dan
didokumentasikan**, belum **dikonsumsi** oleh kode resolver apa pun.
