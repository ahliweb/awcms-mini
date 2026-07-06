---
name: awcms-mini-i18n
description: Tambah/ubah string UI atau konten multi-bahasa AWCMS-Mini yang benar. Gunakan saat menambah teks UI baru, menambah locale, memformat angka/mata uang/tanggal, atau menambah field konten yang perlu multi-bahasa. Menegakkan katalog .po gettext (default en, min en+id), resolusi locale via middleware, dan konvensi konten multi-bahasa doc 04 sesuai Issue #433.
---

# AWCMS-Mini — i18n (String UI & Konten Multi-bahasa)

Sumber kebenaran: **`docs/awcms-mini/14_ui_ux_design_system.md`** §Internationalization dan **`docs/awcms-mini/04_erd_data_dictionary.md`** §Konten multi-bahasa. Implementasi referensi: `src/lib/i18n/`, `i18n/{messages.pot,en.po,id.po}` (Issue #433).

## Dua lapisan — jangan campur

1. **String UI statis** (label, tombol, pesan error, navigasi) → katalog `.po`/`.pot` gettext, **bukan** database. Kunci `namespace.key` (mis. `admin.settings.save_button`, `error.access_denied`).
2. **Konten data multi-bahasa** (input pengguna — nama produk, deskripsi, dst.) → disimpan di database **per locale aktif** (JSONB per-locale atau tabel translasi `(entity_id, locale, field, value)`), **bukan** di `.po`. Base ini sendiri belum punya field yang memakainya — ikuti pola doc 04 saat menambahkannya.

## Menambah string UI baru

1. Tambah key **paralel** di ketiga berkas: `i18n/messages.pot`, `i18n/en.po`, `i18n/id.po` — keyset harus identik di ketiganya (diverifikasi via diff terurut, lihat pola PR #440/#441).
2. Pakai di server: `const t = await createTranslator(locale)` (`src/lib/i18n/translate.ts`), lalu `t("namespace.key", params?)`. Fallback chain: `locale → en → key mentah` — tidak pernah crash pada key hilang.
3. Pakai di client script (`<script>` inline di halaman `.astro`): **tidak bisa** memanggil `createTranslator` (katalog server-side only) — injeksikan string yang dibutuhkan lewat `<script type="application/json" set:html={JSON.stringify(clientStrings)} />` di frontmatter, baca di client script (pola `login.astro`, `admin/access-users.astro`).
4. Pesan error banner: petakan kode error (doc 05) ke key ter-lokalisasi via `translateErrorCode`/`buildClientErrorMessages` (`src/lib/i18n/error-messages.ts`) — jangan hardcode pesan per kode error di tiap halaman.

## Resolusi locale — WAJIB di middleware, bukan di layout

**Gotcha nyata (Issue #433)**: frontmatter sebuah halaman Astro berjalan **lebih dulu** daripada frontmatter layout yang membungkusnya. Me-resolve locale (cookie → `default_locale` tenant → `en`) di dalam layout (`AdminLayout.astro`) membuat shell ter-render benar tapi konten halaman tetap bahasa default — bug nyata yang pernah terjadi dan sudah diperbaiki.

- Resolusi locale **HARUS** terjadi di `src/middleware.ts` (`resolveRequestLocale`/`resolveLocale`, `src/lib/i18n/locale.ts`), disimpan di `Astro.locals.locale`, dan setiap halaman/layout membaca `Astro.locals.locale` langsung — **jangan** re-resolve locale sendiri di layout atau halaman manapun.
- Precedence: cookie `awcms_mini_locale` → `SsrContext.tenantDefaultLocale` (dibawa dari query yang sudah ada di `resolveSsrContext`, tanpa round-trip DB baru) → fallback `en`.

## Language switcher

`src/components/LanguageSwitcher.astro` — set cookie lalu **reload penuh** (`window.location.reload()`), **bukan** swap instan seperti theme toggle. Alasan: locale mengubah teks yang di-render SSR, bukan cuma CSS — swap instan tidak bisa membaca ulang katalog server-side. Tampilkan ikon bendera + nama asli bahasa (`LOCALE_FLAGS`/`LOCALE_LABELS`, `src/lib/i18n/locale.ts`), bukan kode locale mentah (`en`/`id`).

## Formatter locale-aware

`src/lib/i18n/format.ts` — `formatNumber`/`formatCurrencyIDR`/`formatDate`/`formatDateTime` (`Intl.NumberFormat`/`DateTimeFormat`, tag `en-US`/`id-ID`, timezone tetap `Asia/Jakarta`). **Gotcha**: `Intl.NumberFormat` currency style menyisipkan U+00A0 (no-break space) antara simbol dan angka, bukan spasi biasa — assertion test harus pakai karakter itu persis, bukan `" "`.

## Menambah locale baru (`ms`/`ar`, dst.)

1. Tambah ke `SUPPORTED_LOCALES` (`src/lib/i18n/locale.ts`) + `LOCALE_LABELS`/`LOCALE_FLAGS` + tag `INTL_LOCALE_TAG` (`format.ts`).
2. Tambah `i18n/<locale>.po` dengan keyset identik ke `en.po`.
3. Kolom DB `default_locale` mungkin sudah menerima nilai itu (doc 04 §ERD) untuk kompatibilitas mundur — tapi UI (`LanguageSwitcher`, dropdown Settings) hanya boleh menawarkan locale yang **benar-benar punya katalog** (`SUPPORTED_LOCALES`), jangan tawarkan locale tanpa terjemahan nyata.

## Verifikasi

- Ganti locale (switcher/cookie/`default_locale` tenant) → seluruh UI berpindah bahasa tanpa string tersisa hardcode, **termasuk konten halaman**, bukan cuma shell layout.
- Tidak ada flash bahasa salah saat SSR.
- `bun run check` hijau; keyset `.po` identik di tiga berkas (skrip verifikasi cepat: bandingkan key sorted dari ketiganya).
- Formatter IDR/tanggal mengikuti locale/timezone yang benar.

## Skill terkait

`awcms-mini-ui-screen` (memakai `t()`/formatter saat membangun layar), `awcms-mini-ux-review` (audit string hardcode yang lolos ekstraksi).
