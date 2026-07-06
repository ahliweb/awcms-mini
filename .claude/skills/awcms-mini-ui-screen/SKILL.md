---
name: awcms-mini-ui-screen
description: Implementasikan layar/komponen UI AWCMS-Mini sesuai design system. Gunakan saat membangun halaman admin/POS/portal, komponen UI, island interaktif, atau memasang design token/theme. Menegakkan token doc 14, state pattern, a11y AA, i18n, dan aturan offline-first doc 15.
---

# AWCMS-Mini — UI Screen / Component

Ikuti **`docs/awcms-mini/14_ui_ux_design_system.md`** (token, komponen, layout, layar) dan **`docs/awcms-mini/15_frontend_architecture_integration.md`** (SSR/islands, API client, offline).

## Checklist implementasi layar

1. **Token dulu** — pakai CSS variables doc 14 (`--color-*`, `--sp-*`, `--fs-*`, termasuk `--color-primary-strong`/`--color-success-strong`/`--color-danger-strong` untuk teks putih di atas warna solid, Issue #434 — semua ≥4.5:1 terukur, jangan pakai varian polos untuk itu); jangan hardcode warna/ukuran. Theme via `data-theme` tanpa flash.
2. **Komponen dari library** — Button/FormField/DataGrid/Dialog dst. dari `src/components/ui`; jangan duplikasi. Untuk state akses-ditolak/gagal-sementara pakai `StateNotice.astro` (`src/components/ui`, Issue #434) — jangan bikin blok `.permission-denied` ad-hoc baru.
3. **State pattern wajib** — loading (skeleton), empty (+CTA), error (`StateNotice.astro` — bedakan "akses ditolak" dari "gagal sementara, coba lagi", pesan aman ter-i18n dari error code doc 05), success/submitting.
4. **Island seperlunya** — halaman SSR; interaktivitas hanya di island (POS, form, chat). Data awal via SSR, mutation via API client.
5. **Form/mutation client-side** — pakai `submitJson`/`showBanner`/`lockElement`/`reloadAfterDelay` (`src/lib/ui/admin-form-client.ts`, Issue #434) untuk form/tombol mutation di halaman admin — `lockElement` mencegah double-submit (`disabled`+`aria-busy` selama request, kembali ke semula termasuk saat gagal); jangan duplikasi implementasi `submitJson`/banner per halaman, dan jangan `fetch` mentah.
6. **Navigasi role-aware** — filter menu dari permission `GET /auth/me`; backend tetap validasi (UI hiding bukan kontrol).
7. **i18n** — lihat skill `awcms-mini-i18n` (katalog `.po` gettext, resolusi locale via middleware, formatter locale-aware, `LanguageSwitcher.astro`) — string UI statis **selalu** lewat `t("namespace.key")`, tidak pernah hardcode, termasuk komponen kecil (theme toggle, skip-link, dst. — Issue #434 menemukan `ThemeToggle.astro` lolos ekstraksi awal karena PR i18n tidak menyentuhnya).
8. **A11y (WCAG 2.1 AA)** — kontras ≥4.5:1, fokus terlihat, label eksplisit, dialog trap fokus + Esc, target sentuh ≥44px (mobile), status tidak hanya warna. Skip-link keyboard di layout admin (`AdminLayout.astro`, Issue #434).
9. **Masking** — data sensitif tampil lewat `MaskedText`; jangan cache PII mentah di IndexedDB.
10. **POS khusus** — keyboard map F1–F10 (doc 14), cart optimistic dengan rollback, offline outbox + `SyncIndicator` (doc 15).
11. **Tabel lebar** — bungkus dengan container scroll (`overflow-x: auto`), jangan biarkan tabel memaksa scroll horizontal seluruh halaman (Issue #434).

## Wireframe & inventory

Layout shell (admin/POS/portal) dan tabel route→persona→API ada di doc 14 §Screen inventory — patuhi route dan komponen utamanya.

## Verifikasi

- Render 4 state (loading/empty/error/ready) dapat didemokan.
- Keyboard-only pass untuk POS; axe/kontras pass untuk AA.
- Tidak ada string hardcode; tidak ada warna literal; tidak ada `fetch` mentah.
- Offline: buka layar POS tanpa jaringan → tetap operasional, antrean terlihat.

## Skill terkait

`awcms-mini-new-endpoint` (kontrak API), `awcms-mini-i18n` (katalog `.po`, locale, formatter), `awcms-mini-sensitive-data` (masking), `awcms-mini-testing` (render/state test), `awcms-mini-ux-review` (audit layar yang sudah ada).
