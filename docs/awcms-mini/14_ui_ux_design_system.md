# Bagian 14 — UI/UX Design System

## Tujuan

Design system base agar semua aplikasi turunan konsisten: token, komponen inti, pola layar, aksesibilitas, dan i18n. Layar domain (POS, gudang, dsb.) mengikuti pola ini di paket aplikasinya.

## Prinsip UI

1. Keyboard-first untuk layar operasional; semua aksi utama punya shortcut.
2. Theme `light/dark/system` dari preferensi tenant (`default_theme`).
3. Locale `id/en/ms/ar`; `ar` dirender RTL (`textDirection`).
4. Status dan error memakai istilah konsisten dengan error code doc 05.
5. Tidak menampilkan data sensitif penuh — selalu `masked_value`.

## Design tokens (CSS custom properties)

```css
:root {
  /* warna semantic */
  --color-bg: #ffffff;
  --color-surface: #f8fafc;
  --color-border: #e2e8f0;
  --color-text: #0f172a;
  --color-text-muted: #64748b;
  --color-primary: #0f6ab4;
  --color-primary-contrast: #ffffff;
  --color-success: #15803d;
  --color-warning: #b45309;
  --color-danger: #b91c1c;

  /* tipografi & spacing (skala 4px) */
  --font-sans: system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-mono: ui-monospace, "JetBrains Mono", monospace;
  --text-sm: 0.875rem;
  --text-base: 1rem;
  --text-lg: 1.125rem;
  --text-xl: 1.5rem;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
  --space-8: 32px;
  --radius: 8px;
  --shadow-card: 0 1px 3px rgb(15 23 42 / 0.1);
}
[data-theme="dark"] {
  --color-bg: #0b1220;
  --color-surface: #111a2c;
  --color-border: #1e293b;
  --color-text: #e2e8f0;
  --color-text-muted: #94a3b8;
}
```

Token adalah satu-satunya sumber warna/ukuran — komponen tidak memakai nilai hardcode.

## Komponen inti (urutan implementasi)

1. `Button` (primary/secondary/danger; disabled; loading).
2. `Input`/`Select`/`Checkbox` + label + pesan error (terhubung `details[].field`).
3. `Dialog` (fokus terkunci, `Esc` menutup).
4. `Table` (header sticky, keyset pagination, empty state).
5. `StatusBadge` (memetakan status lifecycle → warna semantic).
6. `Toast` untuk hasil aksi; error memakai pesan dari envelope.

## Pola layar base

| Layar         | Pola                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| Login         | Form tunggal; error generik (tanpa membocorkan penyebab)                                                |
| Setup wizard  | Stepper 3 langkah: tenant → owner → konfirmasi; sekali jalan                                            |
| Admin shell   | Sidebar navigasi (dari module registry + permission), header (tenant, user, theme, locale), area konten |
| List + detail | Table + filter → drawer/halaman detail                                                                  |
| Audit/log     | Read-only table + filter waktu + correlation id                                                         |

## Navigation registry

Sidebar dibangun dari `src/modules/index.ts`: modul `active` dengan permission `read` pada activity utamanya muncul otomatis; modul `experimental` hanya untuk role Owner/dev flag. Tidak ada menu hardcode.

## Aksesibilitas (a11y)

- Semua kontrol dapat dijangkau Tab; fokus terlihat (`outline` token).
- Label form eksplisit (`<label for>`); error `aria-describedby`.
- Kontras teks minimal WCAG AA; jangan menyampaikan status hanya dengan warna.
- Dialog: `role="dialog"`, fokus kembali ke pemicu saat ditutup.

## i18n di UI

- Semua string lewat kamus `localization_ui` — tidak ada literal di komponen.
- Format tanggal/angka mengikuti locale + `APP_TIMEZONE`.
- Layout siap RTL: gunakan properti logical (`margin-inline-start`, bukan `margin-left`).
