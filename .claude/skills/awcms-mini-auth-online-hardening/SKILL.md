---
name: awcms-mini-auth-online-hardening
description: Kerjakan bagian mana pun dari epic full-online auth security hardening AWCMS-Mini (Issue #587-#593). Gunakan saat menambah/mengubah AUTH_ONLINE_SECURITY_* gate, Cloudflare Turnstile, MFA/TOTP, Google OIDC login, generic tenant OIDC SSO, atau admin auth policy UI. Merangkum keputusan yang sudah dibuat supaya issue lanjutan tidak mengulang/kontradiksi.
---

# AWCMS-Mini — Full-Online Auth Security Hardening

Epic menambahkan enam fitur hardening auth **online-only** (Cloudflare
Turnstile, MFA/TOTP, Google OIDC login, generic tenant OIDC SSO, admin
policy UI, plus penutup docs/kontrak) di atas login lokal/password +
session opaque yang sudah ada, tanpa mengubah perilaku default
offline/LAN/local sama sekali. Target model:

```txt
AUTH_ONLINE_SECURITY_ENABLED + AUTH_ONLINE_SECURITY_PROFILE=full_online
  -> isFullOnlineSecurityActive(env) === true
    -> Turnstile / MFA / Google OIDC / generic SSO boleh aktif
```

## Kapan pakai skill ini vs skill generik

Skill ini melengkapi (bukan menggantikan) `awcms-mini-new-endpoint`,
`awcms-mini-new-migration`, `awcms-mini-idempotency`,
`awcms-mini-abac-guard`, `awcms-mini-audit-log`, dan
`awcms-mini-sensitive-data` (kredensial provider, TOTP seed, recovery
code semua data sensitif). Skill ini menyediakan konteks **cross-cutting
epic ini spesifik**: gate bersama yang wajib dicek setiap fitur, dan
keputusan desain yang mengikat semua issue di epic ini sekaligus.

## Status per issue (jangan bangun ulang yang sudah ada)

| Issue | Scope                                                  | Status                                         |
| ----- | ------------------------------------------------------ | ---------------------------------------------- |
| #587  | Gate bersama `AUTH_ONLINE_SECURITY_ENABLED`/`_PROFILE` | **Selesai** — lihat §Gate bersama di bawah     |
| #588  | Cloudflare Turnstile untuk form auth publik            | Belum dikerjakan                               |
| #589  | MFA/TOTP login challenge                               | Belum dikerjakan                               |
| #590  | Google OIDC login                                      | Belum dikerjakan                               |
| #591  | Generic tenant OIDC SSO provider                       | Belum dikerjakan                               |
| #592  | Admin UI kebijakan auth security online                | Belum dikerjakan (depends #587 selesai + #591) |
| #593  | Docs/kontrak/readiness penutup epic                    | Belum dikerjakan (finalisasi setelah #588-592) |

## Yang sudah ada — pakai ulang, jangan re-derive

### Gate bersama (Issue #587, `src/lib/auth/online-security-config.ts`)

Dua env var, **keduanya opsional/backward-compatible** — tidak di-set
sama sekali (default setiap deployment offline/LAN/local), `config:validate`
tetap PASS dan tidak ada perubahan perilaku login sama sekali:

- `AUTH_ONLINE_SECURITY_ENABLED` — `"true"` mengaktifkan gate,
  nilai lain (termasuk unset) berarti nonaktif.
- `AUTH_ONLINE_SECURITY_PROFILE` — `"disabled"` (default) atau
  `"full_online"`. **Wajib** `"full_online"` kalau `AUTH_ONLINE_SECURITY_ENABLED=true`
  — kombinasi lain gagal `bun run config:validate`
  (`checkOnlineAuthSecurityConfig`, `scripts/validate-env.ts`).

Tiga fungsi diekspor:

- `isOnlineSecurityEnabled(env)` — cek flag saja.
- `resolveOnlineSecurityProfile(env)` — selalu jatuh ke `"disabled"`
  untuk nilai kosong/tidak dikenal, tidak pernah throw.
- **`isFullOnlineSecurityActive(env)` — satu-satunya fungsi yang WAJIB
  dipanggil setiap fitur #588-#592 sebelum melakukan apa pun yang
  online/provider-terkait.** Jangan re-derive aturan "keduanya harus
  setuju" di modul lain — impor fungsi ini langsung.

`scripts/security-readiness.ts`'s `checkOnlineAuthSecurityReady`
melaporkan status gate ini (severity `critical` supaya misconfiguration
sungguhan tetap blokir go-live, tapi `status: pass` untuk kondisi
disabled — informational, bukan kegagalan, sesuai acceptance criteria
#587). Detail env var lengkap: `docs/awcms-mini/18_configuration_env_reference.md`
§Full-online auth security hardening,
`docs/awcms-mini/deployment-profiles.md` §Full-online auth security
hardening, `src/modules/identity-access/README.md` §Full-online-only
auth security feature gate.

## Aturan lintas-issue yang wajib diikuti (#588-#593)

1. **Setiap fitur (#588-#592) WAJIB memanggil `isFullOnlineSecurityActive(env)`
   sebelum melakukan apa pun online/provider-terkait** — jangan cek
   `AUTH_ONLINE_SECURITY_ENABLED`/`_PROFILE` langsung atau bikin gate
   sendiri. Tidak aktifnya gate ini harus berarti: tidak ada panggilan
   Cloudflare/Google/OIDC apa pun, tidak ada MFA challenge, form login
   tetap seperti hari ini persis.
2. **`AUTH_ONLINE_SECURITY_ENABLED=false`/unset tidak boleh pernah
   mewajibkan credential provider apa pun** — `.env.example` default dan
   setiap deployment offline/LAN yang tidak pernah menyentuh var
   `AUTH_ONLINE_SECURITY_*`/`AUTH_SSO_*`/`AUTH_MFA_*`/`AUTH_GOOGLE_*`/
   `TURNSTILE_*` harus tetap `config:validate` PASS dan berperilaku
   identik dengan sebelum epic ini ada.
3. **`APP_ENV=production` BUKAN setara dengan full-online** — deployment
   offline/LAN bisa production-grade secara operasional (lihat
   `deployment-profiles.md`) tanpa pernah mengaktifkan gate ini. Jangan
   pernah menjadikan `APP_ENV=production` sebagai proxy untuk
   `isFullOnlineSecurityActive`.
4. **Login password lokal tidak pernah dihapus/dinonaktifkan secara
   default** oleh fitur mana pun di epic ini — `sso_required`/kebijakan
   serupa (#591) hanya boleh aktif kalau ada break-glass local
   owner/account valid, dicek server-side sebelum kebijakan itu bisa
   disimpan.
5. **Kredensial provider (Google client secret, OIDC client secret,
   Turnstile secret key, TOTP seed, recovery code) tidak pernah
   disimpan plaintext** — dari environment variable/secret manager, atau
   dienkripsi at-rest dengan key dari environment (`AUTH_SSO_CREDENTIAL_ENCRYPTION_KEY`/
   `AUTH_MFA_SECRET_ENCRYPTION_KEY`, dsb.) — tidak pernah muncul di
   response API, log, atau audit attributes (`awcms-mini-sensitive-data`).
6. **Link/unlink provider account, perubahan kebijakan auth, enroll/disable
   MFA, dan regenerate recovery code semuanya high-risk actions** — wajib
   diaudit (`awcms-mini-audit-log`) dan idempotent kalau mutation
   (`awcms-mini-idempotency`).
7. **Provider identifier stabil adalah `sub` (subject OIDC), bukan
   email** — auto-link by email (kalau diimplementasikan) wajib
   mensyaratkan email terverifikasi + kebijakan allowed-domain eksplisit,
   tidak pernah linking implisit murni dari kecocokan string email.
8. **Semua panggilan provider eksternal (OIDC discovery/JWKS, Turnstile
   siteverify) wajib timeout-bounded** — pola sama seperti
   `cloudflare-dns-adapter.ts`/`mailketing-provider.ts` (`withTimeout`,
   circuit breaker `getProviderCircuitBreaker`), dan tidak pernah
   dipanggil di dalam DB transaction (ADR-0006).
9. **Tabel baru yang tenant-scoped (`awcms_mini_auth_providers`,
   `awcms_mini_identity_provider_accounts`, `awcms_mini_tenant_auth_policies`,
   `awcms_mini_identity_mfa_factors`, dst.) wajib RLS `ENABLE` + `FORCE`**
   — pola sama seperti setiap migration sejak 013 (`awcms-mini-new-migration`).
10. **MFA reset password tidak boleh jadi bypass MFA** — reset password
    yang berhasil tidak otomatis menonaktifkan MFA milik identity itu.

## Belum ada — jangan asumsikan sudah dikerjakan

Semua enam fitur konkret (#588-#592) plus dokumentasi/kontrak penutup
(#593) masih backlog per 2026-07-09 — hanya gate bersama (#587) yang
sudah ada di repo ini. Jangan asumsikan `awcms_mini_auth_providers`,
endpoint `/api/v1/auth/mfa/*`/`/api/v1/auth/providers/google/*`/`/api/v1/auth/sso/*`,
atau `src/lib/security/turnstile.ts` sudah ada — cek langsung sebelum
membangun di atasnya.
