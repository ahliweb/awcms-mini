# Lingkup di Luar Base Repo — Isu yang Sengaja Tidak Dikerjakan

> **Dokumen base (bukan contoh domain).** Dokumen ini mengkonsolidasikan **isu dan
> kapabilitas yang secara sadar TIDAK dikerjakan di repo base generik `awcms-mini`** —
> beserta alasan penutupan dan **ke mana** kapabilitas itu seharusnya dibangun.
> Sejak **ADR-0024**, "ke mana" itu **bukan** repo aplikasi-turunan terpisah: logika
> domain (POS/retail, akuntansi, pajak, CRM), adapter provider nyata, dan dataset
> region tetap **BUKAN** bagian base generik ini, tetapi ditambahkan **langsung di
> `src/modules/`** template keluarga AWCMS yang scope-nya paling dekat (fork `awcms`
> untuk lineage ERP, `awcms-micro` untuk website/e-commerce, atau `awcms-mini`
> sendiri) — bukan repo turunan lewat `application-registry.ts` (jalur itu **dihapus**).
> Contoh domain seperti **AWPOS** di dokumen ini bersifat **ilustratif**: ia mewakili
> aplikasi domain yang dibangun di atas template, bukan lagi repo turunan wajib.
> Tujuannya: menutup celah "kenapa fitur X tidak ada di sini?" secara permanen,
> supaya tidak diinvestigasi ulang dari nol dan tidak diimplementasikan keliru di base.
>
> Sumber otoritatif angka isu = GitHub (`ahliweb/awcms-mini`) + snapshot
> [`github/README.md`](github/README.md); backlog historis = [`06_github_issues_detail.md`](06_github_issues_detail.md).
> Keputusan batas = ADR-0012/0020/0022 dan **ADR-0024** — yang **men-supersede**
> ADR-0013/0014/0015 (jalur aplikasi-turunan repo terpisah + `application-registry.ts`
>
> - gerbang `extension:check` dihapus) dan **meng-amend** ADR-0012/0020 ("Derived
>   Application" tak lagi berarti repo terpisah; ekstensi ERP boleh hidup langsung di
>   `src/modules/`). Bila dokumen ini dan ADR berbeda, **ADR yang berlaku**.

## 1. Prinsip lingkup base

`awcms-mini` adalah **base modular monolith generik** — fondasi reusable (tenant,
RBAC/ABAC, RLS PostgreSQL, audit, workflow, module management, reporting, provider
hardening, admin shell, dan — sejak epic #868 — SaaS control plane) untuk aplikasi
domain berikutnya. Base **tidak** memuat:

- **Logika domain spesifik** (POS/retail, akuntansi/GL, pajak Coretax, CRM operasional).
  Itu **bukan** bagian base generik ini — dibangun sebagai **modul domain langsung di
  `src/modules/`** template keluarga AWCMS yang dipakai (fork `awcms`/`awcms-micro`/
  `awcms-mini` yang scope-nya cocok), dengan aplikasi domain seperti AWPOS sebagai
  contoh ilustratif, **bukan** repo turunan terpisah (ADR-0024).
- **Runtime pihak-ketiga yang melanggar aturan platform** (mis. layanan Python,
  runtime AI eksternal) — base ber-aturan **Bun-only backend**; integrasi semacam itu
  hidup sebagai **layanan/kontainer terpisah** yang di-_govern_ base lewat capability
  port + outbox, bukan di-_embed_.
- **Migrasi data legacy** — sengaja di-deskop dari base (lihat §4.1).
- **Adapter provider konkret** (gateway pembayaran spesifik, penyedia AI spesifik) —
  ditambahkan sebagai modul/adapter domain **langsung di `src/modules/`** template
  yang dipakai (ADR-0024), sebagai konfigurasi **opt-in** dengan secret hanya di
  `process.env`, bukan dependency hardcoded di base generik.

Cara menambah modul domain **sejak ADR-0024**: **fork/pakai template keluarga AWCMS
yang scope-nya paling dekat, lalu tambahkan modul domain langsung di `src/modules/`**
dan daftarkan di `src/modules/index.ts`. Validasi komposisi registry tetap dijalankan
via `bun run modules:compose:check` + `bun run modules:composition:inventory:check`.
Jalur lama "repo turunan terpisah + `application-registry.ts` + `composeModuleRegistry()`"
(ADR-0013/0014) sudah **dihapus** — lihat ADR-0024.

## 2. Gelombang 1 — Descope domain POS/retail → AWPOS (2026-07-04)

Backlog awal (38 issue) memuat epic domain POS/retail yang **tidak sesuai konteks
base generik**. **20 issue domain ditutup `not planned`** dan kontennya **dipindahkan
ke aplikasi turunan contoh (AWPOS)**, bukan dihapus historisnya (snapshot
[`github/README.md`](github/README.md) §Ringkasan; [`06_github_issues_detail.md`](06_github_issues_detail.md) §"Riwayat perubahan backlog (2026-07-04)").

Kategori yang di-deskop:

| Kategori domain                                          | Alasan tidak di base                                             | Rumah yang benar                                             |
| -------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------ |
| **Legacy Migration** (impor data sistem lama)            | Data & aturan migrasi spesifik instansi; bukan fondasi generik   | Aplikasi turunan (AWPOS) — lihat §4.1                        |
| **POS MVP** (transaksi penjualan, kasir)                 | Logika retail domain                                             | AWPOS                                                        |
| **Warehouse Management** (stok, transfer, cycle count)   | Domain inventori                                                 | AWPOS / ekstensi ERP                                         |
| **CRM Receipt Delivery** (struk WhatsApp/email domain)   | Alur domain; base hanya sediakan modul email/notifikasi reusable | AWPOS                                                        |
| **Accounting & Coretax** (GL, faktur pajak, e-invoicing) | Akuntansi/pajak = domain ERP, bukan base                         | Ekstensi ERP (ADR-0020) — lihat §4.2                         |
| Sebagian UI/Reporting/AI berbau domain                   | Wording domain ("Petugas", "Sales daily/stock/tax dashboard")    | Di-_genericize_ (2 issue: Admin shell, Management Reporting) |

Dua issue (Admin shell, Management Reporting) **tidak ditutup** melainkan
**di-generalisasi wording-nya** agar tetap di base tanpa istilah domain.
Milestone & label domain yang jadi tak terpakai turut dibersihkan.

## 3. Gelombang 2 — Deferral `not planned` (2026-07-13)

Dua epic ditutup `not planned` pada 2026-07-13 (semua judulnya berprefiks
`PENDING:`). **Terverifikasi via GitHub** (`stateReason = NOT_PLANNED`). Rujukan
memory internal: penutup epic menyatakan **jangan dilanjutkan sampai dibuka lagi**.

### 3.1 Master data wilayah Indonesia via vendoring `cahyadsn/wilayah` (8 isu)

| Isu      | Judul (ringkas)                                                           |
| -------- | ------------------------------------------------------------------------- |
| **#654** | Epic: Master data wilayah administratif Indonesia dari `cahyadsn/wilayah` |
| **#658** | feat(master-data): parser & normalizer dataset cahyadsn wilayah           |
| **#659** | test(master-data): repo validation gate untuk dataset vendored            |
| **#660** | feat(master-data): import dataset region Indonesia tervalidasi            |
| **#661** | feat(master-data): activation rollback & diff dataset region              |
| **#662** | feat(master-data): read-only region lookup API                            |
| **#663** | feat(master-data): admin UI dataset region                                |
| **#664** | docs(master-data): SOP & security review cahyadsn wilayah                 |

**Apa yang di-deskop:** _pendekatan spesifik_ memvendor dataset SQL dari repo
pihak-ketiga `cahyadsn/wilayah` (MIT) ke dalam base (parser, gate validasi file,
import, activation/rollback, lookup API, admin UI khusus dataset itu).

**Penting — kapabilitasnya TETAP ADA di base lewat jalur lain.** Modul
`idn_admin_regions` **aktif dan terdaftar** di `src/modules/index.ts` (dibangun via
epic `idn_admin_regions` tersendiri; skill `awcms-mini-idn-admin-regions`). Jadi yang
gugur adalah **mekanisme vendoring dataset pihak-ketiga #654/#658-664**, bukan
kebutuhan data region Indonesia. Bila aplikasi turunan butuh dataset resmi
Kepmendagri lengkap, sediakan lewat modul/dataset turunan, bukan menghidupkan ulang
#654 di base.

### 3.2 Hermes Agent — control-plane AI agent eksternal (11 isu)

| Isu      | Judul (ringkas)                                                    |
| -------- | ------------------------------------------------------------------ |
| **#668** | Epic: tenant-aware Hermes AI agent management                      |
| **#669** | docs(hermes-agent): arsitektur control-plane, deployment           |
| **#670** | feat(hermes-agent): scaffold modul, tenant schema, RLS, RBAC       |
| **#671** | feat(hermes-agent): deployment profile OpenCode Go + MiMo-V2.5-Pro |
| **#672** | feat(hermes-agent): authenticated Hermes client, readiness check   |
| **#673** | feat(hermes-agent): identitas Telegram aman, chat, topic           |
| **#674** | feat(hermes-agent): capability-based AWCMS module tool gateway     |
| **#675** | feat(hermes-agent): agent runs AWCMS-originated + human approval   |
| **#676** | feat(hermes-agent): tenant-aware Hermes operations dashboard       |
| **#677** | feat(hermes-agent): usage rollups, budget policies, alerts         |
| **#678** | docs(hermes-agent): deployment, backup, upgrade, incident-response |

**Apa yang di-deskop:** modul sistem `hermes_agent` untuk mendaftarkan & meng-govern
profil agent AI Hermes, deployment profile OpenCode Go + MiMo-V2.5-Pro, gateway
Telegram, tool-gateway capability berbasis allowlist, human approval, dashboard, dan
usage/budget.

**Alasan deferral:**

- **Aturan Bun-only.** Hermes adalah layanan **Python** → wajib berjalan sebagai
  **service/kontainer terpisah**; base **tak boleh embed/fork/reimplement runtime
  Hermes**. Base hanya berperan sebagai _tenant-aware control plane_.
- **Full-online only + opt-in per tenant** — bertentangan dengan prinsip
  offline/LAN-first default base.
- Bukan fondasi generik yang dibutuhkan mayoritas aplikasi turunan.

**Rumah yang benar:** layanan Hermes terpisah + (jika dibuka lagi) modul control-plane
opt-in yang mengkonsumsi capability port & outbox (pola sama seperti provider eksternal
lain: email→Mailketing, payment→adapter #877). Jangan dibangun di base sampai epic
dibuka ulang oleh owner.

## 4. Batas kapabilitas tingkat-ADR (bukan isu formal, tapi mengikat)

Selain isu yang ditutup, beberapa kapabilitas **secara arsitektural** di luar base:

### 4.1 Migrasi data legacy — **BACAAN SAJA, di-deskop**

Migrasi data legacy sengaja dihapus dari base (doc 06 §"Riwayat perubahan backlog";
skill `awcms-mini-legacy-migration` = read-only). Command/tabel/isu yang dulu dirujuk
(`legacy:preflight`, `awcms_mini_legacy_migration_runs`, Issue 1.1/1.2) **tidak ada**
di repo ini. Rumah yang benar: aplikasi turunan (AWPOS) yang tahu skema sumbernya.

### 4.2 ERP: General Ledger, AR/AP, pajak, e-invoicing — **lapisan ERP di luar base**

- `subscription_billing` (#876) adalah **state komersial SaaS**, **bukan** general
  ledger / double-entry / AR-AP subledger / tax engine / e-invoicing / rekonsiliasi
  kas-bank / faktur bisnis tenant. `payment_allocation` = _reference_, bukan jurnal.
- Akuntansi/pajak sesungguhnya = **ERP Extension** di luar base
  (`docs/adr/0020`, kontrak kesiapan di [`erp-extension-contracts.md`](erp-extension-contracts.md), Issue #755).

### 4.3 Adapter provider pembayaran/AI konkret — **opt-in modul domain in-repo**

- `payment_gateway` (#877) menyediakan gateway **provider-neutral** + adapter
  **sandbox** untuk test/docs. **Adapter provider produksi nyata** (Stripe, Midtrans,
  dsb.) = konfigurasi **opt-in** sebagai modul/adapter domain **langsung di
  `src/modules/`** template yang dipakai (ADR-0024), **bukan** dependency hardcoded
  di base generik. Secret provider hanya di `process.env`.
- LAN/offline/manual-payment berjalan **tanpa** provider online (modul disabled = inert).

### 4.4 SaaS Control Plane — dahulu "di luar base", kini **di dalam base**

ADR-0013 §1 semula menaruh SaaS Control Plane di luar base. **ADR-0022 (#869)
meng-amend** itu: tujuh modul (`service_catalog`, `tenant_entitlement`,
`tenant_provisioning`, `tenant_lifecycle`, `usage_metering`, `subscription_billing`,
`payment_gateway`) kini **Official Optional Business Foundation in-repo,
default-disabled** (epic #868). Dicatat di sini agar tidak keliru menganggapnya masih
"di luar base" berdasarkan ADR-0013 lama.

## 5. Ke mana membangunnya (ringkas)

| Kebutuhan                                       | Rumah                                                       | Mekanisme                                            |
| ----------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------- |
| Logika domain (POS, warehouse, CRM operasional) | Modul domain in-repo (`src/modules/`)                       | Tambah modul + `modules:compose:check` (ADR-0024)    |
| Migrasi data legacy                             | Modul domain in-repo                                        | Skema sumber spesifik instansi                       |
| GL / AR-AP / pajak / e-invoicing                | Modul ekstensi ERP in-repo                                  | Kontrak `erp-extension-contracts.md` (ADR-0020/0024) |
| Adapter provider pembayaran/AI nyata            | Modul/adapter domain in-repo (opt-in)                       | Modul di `src/modules/`, secret di `process.env`     |
| Runtime AI eksternal (Hermes)                   | Layanan terpisah + (bila dibuka) modul control-plane opt-in | Capability port + outbox; jangan embed               |
| Dataset region Indonesia resmi lengkap          | Modul/dataset domain in-repo                                | Bukan vendoring #654 di base                         |

## 6. Cara memverifikasi status (jangan mengandalkan ingatan)

Angka & status isu **berubah**; verifikasi selalu ke sumber:

```bash
# Semua isu yang ditutup not planned (descoped/deferred)
gh issue list --repo ahliweb/awcms-mini --state closed --limit 300 \
  --json number,title,stateReason,closedAt \
  | jq '[.[] | select(.stateReason=="NOT_PLANNED")]'

# Refresh snapshot dokumentasi GitHub
bun run github:snapshot   # lihat skill awcms-mini-github-snapshot
```

## 7. Referensi silang

- [`06_github_issues_detail.md`](06_github_issues_detail.md) — backlog + §Riwayat perubahan backlog (gelombang 1).
- [`github/README.md`](github/README.md) — snapshot faktual state GitHub (ringkasan closed/not-planned).
- [`21_module_admission_governance.md`](21_module_admission_governance.md) — tata kelola admisi modul (apa yang boleh masuk registry base).
- [`derived-application-guide.md`](derived-application-guide.md) — **DEPRECATED** (ADR-0024): dahulu panduan aplikasi turunan repo terpisah; kini modul domain ditambahkan langsung di `src/modules/`.
- [`erp-extension-contracts.md`](erp-extension-contracts.md) — kontrak kesiapan ekstensi ERP (di luar base).
- ADR: `0012` (module admission & trusted registry), `0020` (ERP extension boundary), `0022` (SaaS control plane admission — amandemen ADR-0013), dan **`0024`** (keluarga AWCMS = template dipakai-langsung; men-supersede ADR-`0013`/`0014`/`0015` — lapisan/komposisi/manifest jalur-turunan — dan meng-amend ADR-`0012`/`0020`).
- Skill: `awcms-mini-legacy-migration` (read-only, kenapa legacy tidak di base), `awcms-mini-idn-admin-regions`, `awcms-mini-github-snapshot`.

## Riwayat perubahan

- **2026-07-21** — dokumen dibuat. Mengkonsolidasikan dua gelombang descope
  (2026-07-04 domain POS/retail → AWPOS; 2026-07-13 `not planned` master-data
  cahyadsn/wilayah #654/#658-664 + hermes-agent #668-678) dan batas kapabilitas
  tingkat-ADR (legacy migration, ERP GL/AR-AP/pajak, adapter provider konkret,
  runtime AI eksternal). Angka `not planned` diverifikasi via GitHub.
