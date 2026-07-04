# Bagian 14 — UI/UX Design System dan Spesifikasi Layar

> **Standar base + contoh domain.** Dokumen ini adalah **standar/pola reusable** base AWCMS-Mini. Contoh yang dipakai memakai domain retail/POS bergaya AWPOS sebagai ilustrasi — ganti detail domainnya dengan kebutuhan aplikasi turunan Anda. Lihat [README paket dokumen](README.md) §Reusable vs domain turunan.

## Tujuan

Dokumen ini melengkapi kebutuhan **desain UI/UX** AWCMS-Mini yang sebelumnya hanya tersirat di SOP (doc 08) dan blueprint (doc 11). Berisi design principle, design token, component library, information architecture, spesifikasi layar (wireframe), state pattern, aksesibilitas, i18n, dan theming — agar frontend dapat diimplementasikan konsisten.

Terkait: `15_frontend_architecture_integration.md` (arsitektur & wiring), `08_sop_operasional_user_guide.md` (alur operasional). Skill penegak: **`awcms-mini-ui-screen`** (`.claude/skills/`).

## Prinsip desain UI/UX

1. **Offline-first terlihat** — status koneksi & sync selalu jelas; aksi tetap bisa saat offline.
2. **Keyboard-first untuk operator** — semua aksi POS dapat tanpa mouse.
3. **Role-aware** — navigasi & aksi menyesuaikan permission (bukan kontrol utama; backend tetap validasi).
4. **State eksplisit** — setiap layar punya loading, empty, error, dan success state.
5. **Aman** — tidak menampilkan data sensitif penuh; mengikuti masking (doc 04).
6. **Aksesibel** — target WCAG 2.1 AA, kontras cukup, fokus terlihat, navigasi keyboard.
7. **Responsif** — admin desktop-first, operator fullscreen, customer portal mobile-first.
8. **Konsisten** — semua layar memakai token & komponen yang sama.

## Design tokens

Token diimplementasikan sebagai CSS custom properties, di-scope ke `:root` dan override via `:root[data-theme="dark"]`. Nilai berikut adalah **placeholder brand-neutral** yang boleh diganti brand tenant.

### Warna semantik

| Token                      | Light     | Dark      | Fungsi               |
| -------------------------- | --------- | --------- | -------------------- |
| `--color-bg`               | `#f7f8fa` | `#0e1116` | Latar aplikasi       |
| `--color-surface`          | `#ffffff` | `#161b22` | Kartu/panel          |
| `--color-surface-2`        | `#eef1f5` | `#1f262e` | Panel sekunder       |
| `--color-border`           | `#d8dee6` | `#2b333c` | Garis/pembatas       |
| `--color-text`             | `#1a1f26` | `#e6edf3` | Teks utama           |
| `--color-text-muted`       | `#5b6672` | `#9aa7b2` | Teks sekunder        |
| `--color-primary`          | `#2563eb` | `#3b82f6` | Aksi utama           |
| `--color-primary-contrast` | `#ffffff` | `#ffffff` | Teks di atas primary |
| `--color-success`          | `#16a34a` | `#22c55e` | Sukses/posted        |
| `--color-warning`          | `#d97706` | `#f59e0b` | Peringatan/held      |
| `--color-danger`           | `#dc2626` | `#ef4444` | Error/stok kurang    |
| `--color-info`             | `#0891b2` | `#06b6d4` | Info/sync            |
| `--color-focus`            | `#2563eb` | `#60a5fa` | Cincin fokus         |

### Skala lain

| Kategori    | Token                           | Nilai                                     |
| ----------- | ------------------------------- | ----------------------------------------- |
| Font family | `--font-sans`                   | system-ui, Inter, sans-serif              |
| Font mono   | `--font-mono`                   | ui-monospace, monospace (harga/SKU/angka) |
| Font size   | `--fs-xs..2xl`                  | 12 · 14 · 16 · 18 · 20 · 24 · 32 px       |
| Spacing     | `--sp-1..8`                     | 4 · 8 · 12 · 16 · 24 · 32 · 48 · 64 px    |
| Radius      | `--radius-sm/md/lg/full`        | 4 · 8 · 12 · 9999 px                      |
| Shadow      | `--shadow-sm/md/lg`             | elevasi kartu/dialog                      |
| Z-index     | `--z-nav/dropdown/dialog/toast` | 100 · 200 · 300 · 400                     |
| Breakpoint  | `sm/md/lg/xl`                   | 640 · 768 · 1024 · 1280 px                |

### Theming

```mermaid
flowchart LR
  Sys[Preferensi OS<br/>prefers-color-scheme] --> Resolve
  Pref[Pilihan user<br/>light/dark/system] --> Resolve[Resolver theme]
  Resolve --> Attr[data-theme di html]
  Attr --> Tokens[CSS variables aktif]
  Tokens --> UI[Semua komponen]
```

Aturan: default `system`; pilihan user disimpan (localStorage + `awcms_mini_tenant_settings.default_theme`); `data-theme` di-set pada `<html>` sebelum paint untuk mencegah flash.

## Component library

Komponen dasar di `src/components/ui`, dipakai lintas persona.

| Komponen                                  | Catatan penting                                                 |
| ----------------------------------------- | --------------------------------------------------------------- |
| Button                                    | varian primary/secondary/ghost/danger; state loading & disabled |
| Input / NumberInput                       | label, hint, error; NumberInput untuk qty/harga (mono)          |
| Select / Combobox                         | Combobox mendukung search produk/customer                       |
| Checkbox / Radio / Switch                 | switch untuk consent & feature toggle                           |
| Dialog / Drawer                           | fokus terperangkap, `Esc` menutup                               |
| Toast                                     | sukses/error/info; non-blocking                                 |
| Table / DataGrid                          | sort, pagination keyset, kolom sticky, row density              |
| Badge / StatusPill                        | status lifecycle (draft/held/posted/quarantine) berkode warna   |
| ArchiveFilter                             | toggle/filter `aktif`, `arsip`, `semua` untuk role berizin      |
| Card / Panel                              | kontainer konten                                                |
| FormField                                 | membungkus label+input+error konsisten                          |
| Tabs                                      | detail entity (produk, transfer, profile)                       |
| Pagination                                | keyset (next/prev), bukan offset besar                          |
| SearchBar                                 | debounce, hasil <300ms (doc 07)                                 |
| EmptyState / ErrorState / LoadingSkeleton | wajib untuk tiap list/detail                                    |
| KeyboardHint                              | menampilkan shortcut aktif di POS                               |
| SyncIndicator / OfflineBanner             | status koneksi & antrean sync                                   |
| MoneyText / MaskedText                    | format IDR & masking data sensitif                              |

## Information architecture (navigasi role-aware)

```mermaid
flowchart TD
  Root[AWCMS-Mini] --> Auth[Login]
  Auth --> Setup[Setup Wizard - sebelum locked]
  Auth --> Shell{Persona}
  Shell -->|Admin/Owner| Admin[Admin Shell]
  Shell -->|Kasir| POS[POS Fullscreen]
  Shell -->|Customer| Portal[Customer Portal]

  Admin --> Dash[Dashboard]
  Admin --> Prod[Produk & Stok]
  Admin --> Wh[Warehouse]
  Admin --> Tax[Pajak/Coretax]
  Admin --> Crm[CRM & Receipt]
  Admin --> Rep[Laporan]
  Admin --> Ai[AI Analyst]
  Admin --> Usr[User & Akses]
  Admin --> Logs[Logs & Security]
  Admin --> Setg[Pengaturan]
```

Item menu difilter oleh permission efektif user (lihat doc 17). Menu tanpa akses disembunyikan, tetapi endpoint tetap dilindungi ABAC.

## Layout shell

### Admin shell (desktop-first)

```text
┌───────────────────────────────────────────────────────────┐
│ Topbar: [Logo] [Tenant switcher] [Search] [Sync●] [🔔] [👤]│
├───────────┬───────────────────────────────────────────────┤
│ Sidebar   │  Breadcrumb                                    │
│  Dashboard│  ┌─────────────────────────────────────────┐  │
│  Produk   │  │  Konten (list/detail/form)              │  │
│  Warehouse│  │  - LoadingSkeleton / EmptyState / Error │  │
│  Pajak    │  │                                         │  │
│  Laporan  │  └─────────────────────────────────────────┘  │
│  User     │                                               │
└───────────┴───────────────────────────────────────────────┘
```

### POS fullscreen (keyboard-first)

```text
┌───────────────────────────────────────────────────────────┐
│ Kasir: <nama> · Office: <office> · Sync● · [F1 Bantuan]    │
├──────────────────────────────┬────────────────────────────┤
│ [F2] Cari/scan produk........ │  Keranjang                 │
│ ┌──────────────────────────┐ │  1. Produk A  x2   20.000  │
│ │ Hasil pencarian          │ │  2. Produk B  x1   15.000  │
│ └──────────────────────────┘ │  ------------------------- │
│                              │  Subtotal        35.000    │
│                              │  Diskon [F6]      0        │
│                              │  Pajak            3.850     │
│                              │  TOTAL           38.850    │
├──────────────────────────────┴────────────────────────────┤
│ [F4] Qty  [F6] Diskon  [F8] Hold  [F9] Bayar  [F10] Posting│
└───────────────────────────────────────────────────────────┘
```

### Customer portal (mobile-first)

```text
┌─────────────────────┐
│  Receipt #INV-000123 │
│  Toko · 2026-07-04   │
├─────────────────────┤
│  Item ............   │
│  Total   38.850     │
│  [⬇ Download PDF]    │
│  Consent WA  [switch]│
│  Consent Email[switch]│
└─────────────────────┘
```

## Screen inventory

| Route                        | Persona         | Tujuan                     | Komponen utama              | API utama                             |
| ---------------------------- | --------------- | -------------------------- | --------------------------- | ------------------------------------- |
| `/login`                     | Semua           | Autentikasi                | FormField, Button           | `POST /auth/login`                    |
| `/setup`                     | Owner awal      | Setup wizard               | Stepper, FormField          | `GET/POST /setup/*`                   |
| `/admin`                     | Admin/Owner     | Dashboard                  | Card, Chart, Table          | `GET /reports/*`                      |
| `/admin/products`            | Admin/Inventory | List/CRUD produk           | DataGrid, SearchBar, Dialog | `/inventory/products`                 |
| `/admin/stock`               | Admin/Inventory | Stok & opening balance     | DataGrid, NumberInput       | `/inventory/stock-balances`           |
| `/admin/warehouse`           | Gudang          | Transfer, bin, cycle count | Tabs, StatusPill            | `/warehouses`, `/warehouse-transfers` |
| `/admin/tax`                 | Tax Officer     | VAT invoice, Coretax       | DataGrid, MaskedText        | `/tax/*`                              |
| `/admin/crm`                 | CRM Staff       | Kontak, receipt, outbox    | Table, Switch               | `/crm/*`                              |
| `/admin/reports`             | Analyst/Owner   | Laporan                    | Chart, Table                | `/reports/*`                          |
| `/admin/ai`                  | Analyst/Owner   | AI analyst chat            | Chat, Card                  | `/ai/business-analyst/chat`           |
| `/admin/users`               | Admin/Owner     | User & akses               | DataGrid, Dialog            | `/access/*`                           |
| `/admin/logs`                | Auditor/Admin   | Logs & security            | DataGrid, Badge             | `/logs/*`, `/security/*`              |
| `/pos`                       | Kasir           | Transaksi POS              | POS shell, Combobox         | `/sales/*`                            |
| `/customer/receipts/{token}` | Customer        | Receipt & consent          | Card, Switch                | `/crm/receipts/*`                     |

## State pattern wajib

```mermaid
stateDiagram-v2
  [*] --> Loading
  Loading --> Empty: data kosong
  Loading --> Ready: data ada
  Loading --> Error: gagal
  Ready --> Submitting: aksi mutation
  Submitting --> Ready: sukses (toast)
  Submitting --> Error: gagal (pesan aman)
  Error --> Loading: retry
```

- **Loading**: skeleton, bukan spinner kosong untuk list.
- **Empty**: pesan + call-to-action (mis. "Belum ada produk. Tambah produk").
- **Error**: pesan user-friendly (petakan error code doc 05), tanpa detail teknis.
- **Optimistic**: keranjang POS update instan; rollback bila server menolak.
- **Offline**: banner + antrean; aksi tetap tersimpan lokal (doc 15).
- **Archived/deleted**: list default menyembunyikan item; role berizin dapat membuka filter arsip, melihat badge `Diarsipkan`, dan menjalankan restore.

## Aksesibilitas (WCAG 2.1 AA)

- Kontras teks minimal 4.5:1 (cek token).
- Semua kontrol dapat difokus & dioperasikan keyboard; urutan tab logis.
- Cincin fokus terlihat (`--color-focus`), jangan `outline:none` tanpa pengganti.
- Label eksplisit untuk setiap input; error diumumkan (`aria-live`).
- Dialog memerangkap fokus; `Esc` menutup; fokus kembali ke pemicu.
- Target sentuh ≥ 44px untuk portal mobile.
- Jangan mengandalkan warna saja untuk status (tambah ikon/teks).

## Internationalization (i18n)

- Locale awal: **id**, **en** (siap ms/ar). Default dari `awcms_mini_tenants.default_locale`.
- Format PO/message catalog (migration `009_awcms_mini_i18n_po_schema.sql`).
- Kunci pesan: `namespace.key` (mis. `pos.button.post`, `error.stock_not_available`).
- Angka/mata uang: IDR, pemisah ribuan lokal; tanggal `Asia/Jakarta`.
- Semua string UI melalui i18n; hindari hardcode teks.

```mermaid
flowchart LR
  Key[Kunci pesan] --> Cat[Catalog per locale]
  Cat --> Fmt[Formatter angka/tanggal/mata uang]
  Fmt --> Render[Render komponen]
  Loc[Locale aktif user/tenant] --> Cat
```

## Peta keyboard POS

| Shortcut | Fungsi                      |
| -------- | --------------------------- |
| F1       | Bantuan/shortcut            |
| F2       | Fokus search/barcode        |
| F4       | Ubah quantity item terpilih |
| F6       | Diskon (sesuai izin)        |
| F8       | Hold transaksi              |
| F9       | Pembayaran                  |
| F10      | Posting transaksi           |
| Enter    | Tambah item terpilih        |
| ↑/↓      | Navigasi hasil/keranjang    |
| Esc      | Tutup dialog                |

## Acceptance criteria UI/UX

- Design token terpasang & theming light/dark/system tanpa flash.
- Komponen dasar tersedia dengan state loading/disabled/error.
- Admin shell, POS fullscreen, dan customer portal render sesuai layout.
- Setiap list/detail memiliki loading/empty/error state.
- Navigasi difilter permission; endpoint tetap dilindungi ABAC.
- POS dapat dioperasikan penuh via keyboard.
- Kontras & fokus memenuhi AA.
- Semua string melalui i18n; angka/mata uang/tanggal terformat lokal.
- Data sensitif tampil ter-mask sesuai role.
- Soft-deleted resource tidak muncul di list/search default; archive filter dan restore hanya muncul bila permission efektif mengizinkan.
