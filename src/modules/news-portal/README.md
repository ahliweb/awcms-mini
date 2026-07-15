# News Portal

Modul untuk epic `news_portal` (Issue #631-#642, #649) — lapisan
editorial + media full-online, R2-only di atas `blog_content` (base
module, sudah `active`) dan online public routing (`tenant_domain`).

> **Catatan drift dokumentasi**: bagian di bawah ini ditulis saat Issue
> #632 dan tidak sepenuhnya mengikuti Issue #633-#642/#649/#681/#690 yang
> sudah selesai sejak itu (media registry, upload presigned, gate R2-only
> `blog_content`, homepage section composer, ad placement presets, capability
> ports, reconciliation job) — epic `news_portal` (#631-#642, #649) FULLY
> COMPLETE per 2026-07-13. **Rujukan status yang akurat**:
> `.claude/skills/awcms-mini-news-portal/SKILL.md`'s tabel "Status per
> issue" — jangan asumsikan README ini lengkap sampai diperbarui menyeluruh.

## Scope Issue #632 (status saat penulisan awal README ini)

Modul ini **baru berisi**:

- Module descriptor (`module.ts`) — key `news_portal`, tanpa
  `settings`/`health` (belum ada fitur nyata yang membutuhkannya).
  `permissions`/`navigation`/`api`/`jobs` sudah dideklarasikan sejak issue
  lanjutan (media upload, homepage sections, ad placements, reconciliation
  job) — lihat catatan drift di atas.
- Preset tenant module `news_portal_full_online_r2`
  (`../module-management/domain/module-presets.ts`) yang membundel
  `blog_content` + `tenant_domain` + `visitor_analytics` +
  `module_management` + `identity_access` + `news_portal`.
- Config gate R2-only (`domain/news-media-r2-config.ts`) dan readiness
  gate aktivasi preset (`domain/news-portal-preset-readiness.ts`).
- Sanctioned entry point aktivasi preset
  (`application/apply-news-portal-preset.ts`) — **satu-satunya** jalur
  yang boleh dipakai untuk mengaktifkan preset ini (lihat komentar
  header file itu).

**Belum ada saat README ini pertama ditulis** (issue lanjutan di epic yang
sama, sekarang semuanya sudah selesai — lihat catatan drift di atas):
media object registry / schema (#633), endpoint upload presigned R2
(#634), integrasi `blog_content` mewajibkan media R2 `confirmed` (#636).
Homepage section composer (`POST/GET /api/v1/news-portal/homepage-sections`,
Issue #637) dan ad placement presets
(`POST/GET /api/v1/news-portal/ad-placements`, Issue #638) sudah
diimplementasikan penuh — routes, admin nav (`/admin/news-portal/homepage-sections`,
`/admin/news-portal/ad-placements`), dan `permissions` sudah dideklarasikan
di `module.ts` — **bukan lagi** item "belum ada".

## Kenapa modul ini diregistrasi sekarang, dependencies minimal

Lihat komentar panjang di `module.ts` dan
`.claude/skills/awcms-mini-news-portal/SKILL.md` §632 untuk alasan
lengkap. Ringkas: `dependencies` HANYA `["tenant_admin",
"identity_access"]` — SENGAJA tidak menyertakan
`blog_content`/`tenant_domain`/`visitor_analytics` walau relasi
konseptual "layer di atas" itu nyata, karena menjadikannya dependency
graph nyata memblokir disable ketiga module itu untuk SETIAP tenant
(setiap module enabled by default) lewat
`MODULE_REVERSE_DEPENDENCY_ACTIVE` — regresi nyata yang sempat memecah
test integrasi yang sudah ada sebelum diperbaiki.

## Konvensi penamaan env var — `NEWS_MEDIA_R2_*`, bukan `R2_*`

`src/modules/sync-storage/` sudah memakai `R2_ENABLED`/`R2_ACCOUNT_ID`/
`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`/`R2_BUCKET` sebagai object
queue **privat** untuk sinkronisasi offline/LAN. News media R2 adalah
kebutuhan **publik** yang fundamental berbeda (custom domain, CORS
direct-upload) — bucket dan kredensialnya WAJIB terpisah total, memakai
prefix `NEWS_MEDIA_R2_*` (lihat
`docs/awcms-mini/news-portal/full-online-r2-architecture.md` §2/§4).
`findNewsMediaR2SeparationViolations`
(`domain/news-media-r2-config.ts`) menegakkan ini secara eksplisit di
`bun run config:validate`/`bun run security:readiness` — konfigurasi
yang menyamakan bucket/kredensial keduanya gagal boot/gagal go-live,
bukan hanya diperingatkan.

## Aktivasi preset

```ts
import { applyNewsPortalFullOnlineR2Preset } from "./application/apply-news-portal-preset";

const result = await applyNewsPortalFullOnlineR2Preset(
  tx,
  tenantId,
  actorTenantUserId,
  process.env
);
```

Menolak (tanpa mengubah state module apa pun) kecuali SEMUA berikut
benar:

- `NEWS_PORTAL_ENABLED=true`
- `NEWS_PORTAL_PROFILE=full_online_r2`
- `NEWS_MEDIA_R2_ENABLED=true` dan lima var wajibnya
  (`NEWS_MEDIA_R2_ACCOUNT_ID`/`_ACCESS_KEY_ID`/`_SECRET_ACCESS_KEY`/
  `_BUCKET`/`_PUBLIC_BASE_URL`) terisi
- `NEWS_MEDIA_R2_BUCKET`/`_ACCESS_KEY_ID`/`_SECRET_ACCESS_KEY` berbeda
  dari `R2_BUCKET`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`
  sync-storage

Setiap keputusan (tolak maupun sukses) diaudit
(`news_portal_preset_activation_rejected`/`news_portal_preset_activated`,
`moduleKey: "news_portal"`).

## Tidak ada fallback filesystem lokal

Mode ini tidak pernah punya opsi menyimpan gambar berita ke disk lokal
server — bukan flag yang dimatikan, tapi memang tidak ada kode jalur
itu. `tests/unit/news-portal-no-local-fallback.test.ts` menegakkan ini
secara struktural (grep source tree), gagal loud begitu PR manapun
menambah jalur tulis lokal untuk media berita.

## Referensi

- `.claude/skills/awcms-mini-news-portal/SKILL.md` — status penuh epic +
  keputusan arsitektur.
- `docs/awcms-mini/news-portal/full-online-r2-architecture.md` —
  arsitektur R2-only lengkap.
- `docs/awcms-mini/18_configuration_env_reference.md` §News portal.
- `src/modules/sync-storage/README.md` — R2 usage yang sudah ada
  (bucket privat, terpisah dari modul ini).
