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

| Issue | Scope                                                  | Status                                             |
| ----- | ------------------------------------------------------ | -------------------------------------------------- |
| #587  | Gate bersama `AUTH_ONLINE_SECURITY_ENABLED`/`_PROFILE` | **Selesai** — lihat §Gate bersama di bawah         |
| #588  | Cloudflare Turnstile untuk form auth publik            | **Selesai** — lihat §Cloudflare Turnstile di bawah |
| #589  | MFA/TOTP login challenge                               | **Selesai** — lihat §MFA/TOTP di bawah             |
| #590  | Google OIDC login                                      | Belum dikerjakan                                   |
| #591  | Generic tenant OIDC SSO provider                       | Belum dikerjakan                                   |
| #592  | Admin UI kebijakan auth security online                | Belum dikerjakan (depends #587 selesai + #591)     |
| #593  | Docs/kontrak/readiness penutup epic                    | Belum dikerjakan (finalisasi setelah #588-592)     |

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

### Cloudflare Turnstile (Issue #588, `src/lib/security/turnstile.ts`)

Fitur konkret **pertama** yang dibangun di atas gate #587 — pola
referensi untuk #589-#592 berikutnya. Gate gabungan:

```txt
isTurnstileRequired(env)
  = isFullOnlineSecurityActive(env) AND isTurnstileEnabled(env)
  (isTurnstileEnabled = TURNSTILE_ENABLED === "true")
```

- **Satu fungsi enforcement dipanggil dari 4 endpoint**:
  `enforceTurnstileIfRequired(turnstileToken, remoteIp, env)` — dipanggil
  di `POST /api/v1/auth/login`, `/auth/password/forgot`, `/auth/password/reset`,
  dan `/setup/initialize`, tepat setelah body divalidasi tapi **sebelum**
  DB/password hashing (issue's security note: verifikasi Turnstile lebih
  murah, jangan buang kerja mahal untuk request yang bahkan tidak lolos
  bot-check). Mengembalikan `{ok:true}` atau `{ok:false, code:
"TURNSTILE_REQUIRED" | "TURNSTILE_INVALID"}` — **fail closed**:
  misconfiguration (`resolveTurnstileConfig` → `null`) diperlakukan sama
  seperti token invalid, bukan dilewati.
- **Verifikasi env var independen dari gate #587**: `TURNSTILE_ENABLED=true`
  sendiri sudah mewajibkan `TURNSTILE_SITE_KEY`+`TURNSTILE_SECRET_KEY`
  di `config:validate`/`security-readiness` (`checkTurnstileConfig`,
  `scripts/validate-env.ts`) — operator boleh isi kredensial ini lebih
  dulu tanpa menyalakan `AUTH_ONLINE_SECURITY_ENABLED`; aktivasi runtime
  tetap butuh KEDUA gate setuju.
- **`verifyTurnstileToken`** memanggil Cloudflare siteverify server-side
  (issue's security note: "client widget alone is not security"),
  timeout-bounded (`withTimeout`) + circuit breaker
  (`getProviderCircuitBreaker("turnstile")`), pola sama seperti
  `cloudflare-dns-adapter.ts`/`mailketing-provider.ts` — **dengan satu
  perbedaan penting yang wajib dipertahankan**: `breaker.recordFailure()`
  HANYA dipanggil untuk kegagalan transport genuine ke Cloudflare (HTTP
  non-2xx, body tak terparse, network error/timeout), TIDAK PERNAH untuk
  respons 2xx yang sah dengan `success:false` (itu Cloudflare menjawab
  dengan benar bahwa token client-nya salah — hasil normal yang bisa
  dipicu siapa pun tanpa autentikasi). PR #596 security review menemukan
  versi awal menyamakan keduanya: breaker ini shared/cross-tenant, dan
  `enforceTurnstileIfRequired` fail-closed saat breaker terbuka, jadi
  penyerang bisa mengunci login/password-reset/setup SEMUA tenant hanya
  dengan mengirim segelintir token sampah setiap ~30 detik. Jangan
  regresi pola ini di fitur online lain (#589-#592) yang menambah
  circuit breaker provider baru — bedakan selalu "provider tidak sehat"
  dari "input client ditolak provider dengan benar". Log
  `turnstile.circuit_breaker_open`/`turnstile.provider_call_failed`/
  `turnstile.provider_call_errored` (severity `warning`,
  `src/lib/logging/logger.ts`) memberi visibilitas operasional untuk
  keduanya.
- **CSP** (`astro.config.mjs`): `script-src`/`frame-src` mengizinkan
  `https://challenges.cloudflare.com` **tanpa syarat** (tidak digerbangi
  `TURNSTILE_ENABLED` di build time) — alasannya didokumentasikan
  langsung di file itu: CSP Astro cuma bisa di-bake saat build,
  sedangkan `TURNSTILE_ENABLED` didesain runtime-toggleable seperti flag
  lain; widget sendiri tetap runtime-gated lewat `isTurnstileRequired()`
  di `login.astro`.
- **Widget UI** hanya di-render di `login.astro` (form publik lain —
  forgot/reset/setup — belum punya halaman UI di repo ini, baru endpoint
  API-nya) saat `isTurnstileRequired()` true; token dikirim sebagai field
  opsional `turnstileToken` di body JSON, dibaca dari hidden field
  `cf-turnstile-response` yang otomatis diisi widget.
- Error code i18n: `error.turnstile_required`/`error.turnstile_invalid`
  (`src/lib/i18n/error-messages.ts`, `i18n/en.po`+`id.po`).

### MFA/TOTP (Issue #589, `src/modules/identity-access/application/mfa.ts`)

Gate gabungan sama persis polanya dengan Turnstile:

```txt
isMfaRequired(env)
  = isFullOnlineSecurityActive(env) AND isMfaEnabled(env)
  (isMfaEnabled = AUTH_MFA_ENABLED === "true")
```

- **MFA opt-in per identity, bukan mandatory tenant-wide** — bahkan
  dengan gate aktif, identity yang belum pernah enroll tetap login
  normal (`login.ts` mengecek `findActiveMfaFactor` per identity SETELAH
  password valid, bukan hanya gate env). Jangan asumsikan mengaktifkan
  `AUTH_MFA_ENABLED=true` otomatis mewajibkan MFA untuk semua user.
- **Login yang dijeda, bukan ditolak**: password valid + factor `active`
  → `login.ts` TIDAK membuat session, malah insert row
  `awcms_mini_mfa_challenges` dan balas `401 MFA_REQUIRED` berisi
  `error.details.mfaChallengeToken` (bentuk `details` di sini SENGAJA
  bukan `ErrorDetail[]` seperti endpoint lain — lihat OpenAPI schema
  `LoginMfaRequiredResponse` — karena payload asli (token) harus
  dikembalikan, bukan sekadar array pesan validasi).
  `POST /auth/mfa/totp/verify` adalah **satu-satunya endpoint MFA yang
  TIDAK butuh session** — diautentikasi lewat possession token
  challenge, pola sama seperti `password/reset` diautentikasi lewat
  possession token reset. Kode/recovery code valid → session dibuat
  identik dengan `login.ts` (token, cookie, response shape sama), supaya
  client tidak perlu logic berbeda untuk step kedua.
- **Enkripsi-at-rest, bukan hash, untuk TOTP secret** —
  `src/lib/auth/mfa-secret-crypto.ts` (AES-256-GCM,
  `AUTH_MFA_SECRET_ENCRYPTION_KEY`, base64 32-byte, divalidasi
  `checkMfaConfig`) — satu-satunya secret di aplikasi ini yang
  reversibel, karena verifikasi TOTP butuh menghitung ulang kode dari
  secret asli setiap request, tidak seperti password/token yang cukup
  dibandingkan hash-nya. Recovery code (`mfa-recovery-code.ts`) dan
  challenge token (`mfa-challenge-token.ts`) tetap hash-only (sha256,
  pola sama `session-token.ts`/`password-reset-token.ts`) — TIDAK
  reversibel, karena keduanya tidak pernah perlu ditampilkan ulang
  setelah reveal sekali di awal.
- **Replay prevention, dan WAJIB atomik, bukan read-then-write** —
  `awcms_mini_identity_mfa_factors.last_used_step` menyimpan step
  time-counter TOTP tertinggi yang pernah diterima; verifikasi hanya
  diterima kalau step yang cocok STRICTLY LEBIH BESAR dari nilai ini
  (`src/lib/auth/totp.ts`'s `verifyTotpCode`, default ±1 step window).
  **PR #597 security review menemukan `verifyMfaChallenge` awalnya
  melakukan SELECT lalu UPDATE terpisah** (untuk `last_used_step`,
  `awcms_mini_identity_mfa_recovery_codes.used_at`, DAN
  `awcms_mini_mfa_challenges.failed_attempts`) — di bawah READ COMMITTED
  (default Postgres, `withTenant` tidak mengubah isolation level), request
  verifikasi konkuren semuanya membaca state lama sebelum salah satu
  commit, sehingga replay guard maupun batas `failed_attempts` bisa
  dilewati sepenuhnya oleh penyerang yang mengirim tebakan paralel.
  Diperbaiki dengan: (a) `SELECT ... FOR UPDATE` pada baris challenge di
  awal `verifyMfaChallenge` (mengunci baris itu untuk sisa transaksi,
  men-serialize semua request verifikasi terhadap challenge yang sama),
  (b) compare-and-swap untuk `last_used_step`
  (`UPDATE ... WHERE last_used_step < $step RETURNING id`, 0 baris = gagal
  — melindungi replay lintas-challenge yang FOR UPDATE saja tidak
  jangkau, mis. dua login attempt berbeda membuat dua challenge terpisah
  untuk identity yang sama), (c) compare-and-swap yang sama untuk
  recovery code (`UPDATE ... WHERE used_at IS NULL RETURNING id`). Fitur
  online lain yang menambah state single-use/counter yang bisa
  diverifikasi berkali-kali (kode OTP lain, dsb.) WAJIB pola atomik yang
  sama — jangan pernah SELECT untuk mengevaluasi kondisi lalu UPDATE
  terpisah untuk menandainya terpakai/gagal; regression test-nya:
  `mfa-flow.integration.test.ts` §"concurrent verification attempts..."
  dan §"concurrent wrong-code attempts...".
- **Reset password BUKAN bypass MFA** — `completePasswordReset` tidak
  menyentuh tabel `awcms_mini_identity_mfa_factors` sama sekali;
  diverifikasi test integrasi eksplisit (`mfa-flow.integration.test.ts`
  §"password reset does not disable MFA").
- **Re-enroll ditolak selagi factor aktif** (`409 MFA_ALREADY_ACTIVE`,
  `POST /auth/mfa/totp/enroll/start`) — sesi yang di-hijack tidak bisa
  diam-diam mengganti secret TOTP tanpa lebih dulu `disable`.
- **Disable & regenerate recovery code = high-risk, diaudit**
  (`mfa_disabled`/`mfa_recovery_codes_regenerated`,
  severity `warning`) — pola sama `awcms-mini-audit-log`. **Catatan
  desain yang belum ditutup** (PR #597 review, tidak blocking): kedua
  endpoint ini hanya mensyaratkan sesi valid, tanpa re-autentikasi
  tambahan (password saat ini/kode TOTP saat ini) — sesi yang dibajak
  (bukan hanya dicuri sebelum MFA aktif) cukup untuk mematikan MFA korban
  atau membuang recovery code lama. Diterima sebagai trade-off untuk
  scope issue #589 saat ini; fitur online lanjutan (mis. #592 admin
  policy UI) yang menyentuh area ini sebaiknya mempertimbangkan
  step-up re-auth di titik ini.
- Error code i18n: `error.mfa_required`/`_disabled`/`_already_active`/
  `_not_active`/`_enrollment_not_found`/`_invalid_code`/
  `_challenge_invalid`/`_misconfigured` (`error-messages.ts`,
  `i18n/en.po`+`id.po`).

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

Tiga fitur (#590-#592) plus dokumentasi/kontrak penutup (#593) masih
backlog per 2026-07-09 — gate bersama (#587), Cloudflare Turnstile
(#588), dan MFA/TOTP (#589) sudah ada di repo ini. Jangan asumsikan
`awcms_mini_auth_providers` atau endpoint
`/api/v1/auth/providers/google/*`/`/api/v1/auth/sso/*` sudah ada — cek
langsung sebelum membangun di atasnya.
