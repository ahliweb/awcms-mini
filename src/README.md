# `src/` — struktur frontend + backend

Ringkasan folder tingkat atas di `src/` (lihat `AGENTS.md` §Struktur repository dan §Peta modul untuk kontrak lengkap):

- `src/modules/` — modular monolith (domain/application/infrastructure/api per modul).
- `src/lib/` — infrastruktur bersama lintas modul (`database/`, `auth/`, dst.).
- `src/pages/` — route Astro (`api/v1/*` untuk REST, halaman untuk frontend).
- `src/layouts/`, `src/components/`, `src/styles/` — frontend admin shell (Issue 8.1, lihat di bawah).

## Admin layout shell (Issue 8.1 — Build Admin Layout Shell)

Frontend pertama di repo ini. Cakupan: token desain, theming, layout admin SSR, dan tiga komponen presentational minimal — **bukan** modul backend (`src/modules/<module>/{module.ts,...}`), jadi tidak didaftarkan ke `src/modules/index.ts`.

- `src/styles/tokens.css` — CSS custom properties (`docs/awcms-mini/14_ui_ux_design_system.md` §Design tokens), `:root` (light) + `:root[data-theme="dark"]`, plus reset minimal.
- `src/lib/auth/ssr-session.ts` — `resolveSsrContext(cookies, now)`, membaca cookie SSR (`awcms_mini_session`, `awcms_mini_tenant_id`) dan mendelegasikan ke `resolveTenantContext`/`fetchGrantedPermissionKeys` (`src/modules/identity-access/application/auth-context.ts`), sama seperti yang dipakai `POST /access/evaluate`. Lihat `src/modules/identity-access/README.md` §SSR session cookies untuk perubahan additive pada `login.ts`/`logout.ts`.
- `src/layouts/AdminLayout.astro` — SSR shell: topbar (nama tenant, tenant-switcher stub, sync-indicator stub, theme toggle, user menu + logout), sidebar (nav difilter permission efektif), breadcrumb, `<slot />`. Redirect ke `/login` bila sesi tidak valid.
- `src/components/TenantSwitcher.astro`, `SyncIndicator.astro`, `ThemeToggle.astro` — lihat catatan backlog masing-masing di `src/modules/identity-access/README.md`.
- `src/pages/login.astro`, `src/pages/admin/index.astro`, `src/pages/admin/settings.astro` — halaman baru; dashboard dan pengaturan sengaja hanya placeholder (Issue 9.1 memiliki dashboard nyata; pengaturan belum ada issue tersendiri).

### Backlog yang sengaja tidak dikerjakan di issue ini

- **Tenant switcher nyata** — perlu cross-tenant identity linking yang belum ada di skema (`awcms_mini_identities.tenant_id` masih 1:1).
- **Sync indicator berbasis data nyata** — perlu endpoint sync-health yang admin-facing (bukan HMAC node auth); scope Issue 9.1.
- **Katalog i18n/PO** — doc 14 menyinggung migration message catalog, tetapi tidak ada issue GitHub untuk ini di `docs/awcms-mini/06_github_issues_detail.md`; string UI di issue ini hardcode Bahasa Indonesia (`id`).
- **PWA/service worker/IndexedDB outbox** — itu scope offline-first POS (Issue 8.2/8.3), yang sudah ditutup `not planned` di repo ini (base generik, bukan aplikasi POS).
- **Komponen UI lengkap** (Button, DataGrid, Dialog, Toast, dst. — doc 14 §Component library) — hanya dibangun sesuai kebutuhan issue yang benar-benar memakainya; issue ini hanya butuh tiga komponen di atas.
