# Perbedaan awcms-mini vs awcms

> **Tujuan dokumen.** Menjelaskan secara rinci hubungan dan perbedaan antara repo
> ini (**awcms-mini**) dan repo turunannya (**awcms**), agar kontributor/agent
> paham posisi masing-masing dan alur kerja lintas-repo. Angka pada dokumen ini
> berlaku per **2026-07-16** (awcms-mini v0.24.0 vs awcms v5.1.1).

## 1. Hubungan kedua repo

**awcms-mini** adalah _Modular Monolith Standard_ — fondasi/standar yang matang
dan lengkap (Bun + Astro 7 + PostgreSQL/RLS). Ia menjadi **sumber standar** dan
laboratorium tempat pola dimatangkan.

**awcms** (github.com/ahliweb/awcms) adalah **rebuild ber-skop ERP** yang
mengadopsi stack & standar teknis awcms-mini sebagai basis, lalu memport modul
fondasi reusable secara bertahap. Menurut ADR-0001 & ADR-0022 di repo awcms,
perannya adalah **penyedia fondasi + kontrak kesiapan ERP**, _bukan_ pembangun
modul ERP itu sendiri.

**Rantai tiga lapis:**

```
awcms-mini            awcms                       repo turunan/ekstensi
(standar terbukti) →  (fondasi ber-skop ERP,   →  (modul ERP & vertikal nyata
                       port bertahap)              di atas awcms)
```

**Aturan kerja lintas-repo:** setiap penambahan/perubahan fitur **dimatangkan &
diuji lebih dulu di awcms-mini**, baru kemudian di-port ke awcms (dengan rename
prefix `awcms_mini_` → `awcms_` dan penyesuaian skop). Repo awcms bukan tempat
merintis fitur dari nol.

## 2. Ringkasan perbedaan (angka konkret)

| Dimensi                       | **awcms-mini** (fondasi)                   | **awcms** (turunan ERP-scope) |
| ----------------------------- | ------------------------------------------ | ----------------------------- |
| Versi                         | 0.24.0                                     | 5.1.1 (melanjutkan legacy major, ADR-0024) |
| Deskripsi                     | "Modular Monolith Standard"                | "basis/fondasi untuk pengembangan ERP" |
| Modul di `src/modules/`       | ~23                                        | 4                             |
| Migrasi `sql/`                | 76 (`awcms_mini_…`)                        | 7 (`awcms_…`)                 |
| Route `src/pages/api`         | ~290                                       | ~16                           |
| Path OpenAPI                  | ~289                                       | 16                            |
| AsyncAPI channels             | ~96                                        | 0 (belum publish event)       |
| Script `package.json`         | ~73                                        | ~23                           |
| Gate `bun run check`          | ~22 gate (+ e2e Playwright)                | ~9 gate                       |
| UI (`components/layouts/pages`) | 15 komponen, 56 halaman admin + portal   | tidak ada (backend/kontrak-only) |
| Test (`*.test.ts`)            | ~317 (+ Playwright e2e)                     | ~22 (tanpa e2e/UI)            |
| `.env.example`                | ~540 baris                                 | ~31 baris                     |
| Docs paket teknis             | `docs/awcms-mini/` (49 file)               | `docs/awcms/` (48 file, sebagian warisan mini sebagai "target") |
| ADR                           | 22 (`0000`–`0021`)                         | 25 (`0000`–`0024`; +0022 ERP-di-repo-terpisah, +0023 docs bilingual, +0024 penomoran legacy) |

> Catatan: versi awcms **5.1.1 bukan tanda lebih matang** dari mini —
> penomorannya melanjutkan garis major legacy (ADR-0024 di awcms), bukan hasil
> evolusi melewati mini.

## 3. Modul yang belum ada di awcms (backlog port)

Modul fondasi yang **sudah ada di kedua repo**: `logging`, `tenant-admin`,
`profile-identity`, `identity-access`.

**19 modul awcms-mini yang belum di-port ke awcms:**

| Kategori                | Modul                                                                 |
| ----------------------- | --------------------------------------------------------------------- |
| Platform/runtime inti   | `module-management`, `domain-event-runtime`, `sync-storage`           |
| Governance & alur bisnis | `workflow-approval`, `reporting`, `organization-structure`, `data-lifecycle` |
| Data & integrasi        | `reference-data`, `data-exchange`, `integration-hub`, `document-infrastructure`, `idn-admin-regions` |
| Komunikasi/notifikasi   | `email`, `form-drafts`                                                |
| Konten/portal (CMS)     | `blog-content`, `news-portal`, `social-publishing`, `visitor-analytics` |
| Tenant online           | `tenant-domain`                                                       |

Sebagian modul CMS (blog/news/social/visitor-analytics) mungkin **tidak** di-port
apa adanya ke awcms karena skopnya CMS, bukan fondasi ERP — di awcms ia menjadi
pola/referensi, bukan fitur wajib.

## 4. Perbedaan toolchain yang menonjol

awcms-mini punya toolchain jauh lebih lengkap yang **belum** ada di awcms, antara
lain:

- **Kontrak & inventory:** `openapi:bundle`, `api:docs:generate/check`,
  `repo:inventory:generate/check`, `modules:compose:check`,
  `modules:composition:inventory:check`, `extension:check`,
  `db:work-class:generate/check`.
- **Dispatcher outbox:** `email:dispatch`, `domain-events:dispatch`,
  `social-publishing:dispatch`, `integration-hub:outbound:dispatch`,
  `workflow:escalations:dispatch`, `sync:objects:dispatch`,
  `data-exchange:worker`.
- **Lifecycle & reporting:** `data-lifecycle:archive-purge`,
  `reporting:projections:refresh`, `analytics:rollup/purge`, `logs:audit:purge`,
  `form-drafts:purge`.
- **i18n & kualitas:** `i18n:extract`, `i18n:pot:check`, `i18n:parity:check`,
  `security:readiness`, `production:preflight`, `resilience:dr-drill`,
  `performance:suite`, `database:capacity:check`.

Saat memport sebuah modul dari mini ke awcms, script + gate CI pendukungnya juga
perlu ikut di-port agar `bun run check` di awcms mencakup jaminan yang setara.

## 5. Governance & identitas

- **AGENTS.md:** mini ~38 KB (playbook penuh, peta modul lengkap) vs awcms ~7 KB
  (ringkas, banyak bagian bertanda "target").
- **ADR-0001** berbeda judul: mini = arsitektur modular-monolith; awcms =
  _rebuild-on-awcms-foundation-erp-scope_.
- awcms menambah ADR khas identitasnya: **0022** (modul ERP hidup di repo
  ekstensi terpisah), **0023** (docs bilingual: sumber Indonesia, default
  Inggris), **0024** (penomoran melanjutkan garis major legacy).
- Skill/subagent Claude: keduanya ~46 skill; nama agent berbeda prefix
  (`awcms-mini-*` vs `awcms-*`).

## 6. Rujukan

- [`awcms-mini/README.md`](awcms-mini/README.md) — paket dokumen teknis standar repo ini.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — arsitektur kode awcms-mini.
- Repo turunan: **github.com/ahliweb/awcms** — lihat `docs/awcms/alur-pengembangan-mini-first.md` di sana untuk kontrak alur port dari sisi awcms.
