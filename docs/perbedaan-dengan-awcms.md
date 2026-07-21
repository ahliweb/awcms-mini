# Perbedaan awcms-mini vs awcms

> **Tujuan dokumen.** Menjelaskan secara rinci hubungan dan perbedaan antara repo
> ini (**awcms-mini**) dan repo turunannya (**awcms**), agar kontributor/agent
> paham posisi masing-masing dan alur kerja lintas-repo. Angka pada dokumen ini
> berlaku per **2026-07-21** (awcms-mini v1.0.0 vs awcms v5.1.1).

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

| Dimensi                         | **awcms-mini** (fondasi)               | **awcms** (turunan ERP-scope)                                                                |
| ------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------- |
| Versi                           | 1.0.0                                  | 5.1.1 (melanjutkan legacy major, ADR-0024)                                                   |
| Deskripsi                       | "Modular Monolith Standard"            | "basis/fondasi untuk pengembangan ERP"                                                       |
| Modul di `src/modules/`         | ~23                                    | **10** (naik dari 4 — 6 modul fondasi diport)                                                |
| Migrasi `sql/`                  | 76 (`awcms_mini_…`)                    | **16** (`awcms_…`, `001`–`016`)                                                              |
| Route `src/pages/api`           | ~290                                   | **86**                                                                                       |
| Path OpenAPI                    | ~289                                   | **86**                                                                                       |
| AsyncAPI channels               | ~96                                    | **~28** (sudah publish domain event sejak port domain-event-runtime)                         |
| Script `package.json`           | ~73                                    | **26**                                                                                       |
| Gate `bun run check`            | ~22 gate (+ e2e Playwright)            | ~10 gate                                                                                     |
| UI (`components/layouts/pages`) | 15 komponen, 56 halaman admin + portal | tidak ada (backend/kontrak-only)                                                             |
| Test (`*.test.ts`)              | ~317 (+ Playwright e2e)                | **~50** (tanpa e2e/UI)                                                                       |
| `.env.example`                  | ~540 baris                             | ~31 baris                                                                                    |
| Docs paket teknis               | `docs/awcms-mini/` (49 file)           | `docs/awcms/` (~49 file, sebagian warisan mini sebagai "target")                             |
| ADR                             | 22 (`0000`–`0021`)                     | 25 (`0000`–`0024`; +0022 ERP-di-repo-terpisah, +0023 docs bilingual, +0024 penomoran legacy) |

> Catatan: versi awcms **5.1.1 bukan tanda lebih matang** dari mini —
> penomorannya melanjutkan garis major legacy (ADR-0024 di awcms), bukan hasil
> evolusi melewati mini.

## 3. Status port modul

**10 modul yang kini sudah ada di awcms** (dari ~23 di mini):

- **Fondasi awal (Sprint 1–2):** `logging`, `tenant-admin`, `profile-identity`,
  `identity-access`.
- **Diport dari mini (2026-07-16/17):** `module-management`,
  `domain-event-runtime`, `sync-storage`, `workflow-approval`, `email`,
  `reporting` — masing-masing dengan migrasi (`008`–`016`), RLS+FORCE pada tabel
  tenant-scoped, kontrak OpenAPI/AsyncAPI, ABAC default-deny + audit +
  idempotency, dan test unit/domain. Migrasi `001`–`016` diverifikasi apply
  bersih di PostgreSQL 18.4.

**13 modul awcms-mini yang belum di-port ke awcms:**

| Kategori                 | Modul                                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| Governance & alur bisnis | `organization-structure`, `data-lifecycle`                                                           |
| Data & integrasi         | `reference-data`, `data-exchange`, `integration-hub`, `document-infrastructure`, `idn-admin-regions` |
| Komunikasi/notifikasi    | `form-drafts`                                                                                        |
| Konten/portal (CMS)      | `blog-content`, `news-portal`, `social-publishing`, `visitor-analytics`                              |
| Tenant online            | `tenant-domain`                                                                                      |

Sebagian modul CMS (blog/news/social/visitor-analytics) mungkin **tidak** di-port
apa adanya ke awcms karena skopnya CMS, bukan fondasi ERP — di awcms ia menjadi
pola/referensi, bukan fitur wajib.

## 4. Perbedaan toolchain yang menonjol

Sejalan dengan port modul, sebagian toolchain sudah ikut ada di awcms; sisanya
masih khusus mini.

**Sudah diport ke awcms** (mengikuti modul terkait): `domain-events:dispatch`,
`sync:objects:dispatch`, `email:dispatch` (+ `email:provider:health`,
`email:templates:seed-defaults`), `workflow:escalations:dispatch`,
`reporting:projections:refresh`, `reporting:projections:registry:check`,
`reporting:exports:dispatch`.

**Masih hanya di awcms-mini** (belum diport):

- **Kontrak & inventory:** `openapi:bundle`, `api:docs:generate/check`,
  `repo:inventory:generate/check`, `modules:compose:check`,
  `modules:composition:inventory:check`, `extension:check`,
  `db:work-class:generate/check`.
- **Dispatcher outbox:** `social-publishing:dispatch`,
  `integration-hub:outbound:dispatch`, `data-exchange:worker`.
- **Lifecycle & analytics:** `data-lifecycle:archive-purge`,
  `analytics:rollup/purge`, `logs:audit:purge`, `form-drafts:purge`.
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
  (`awcms-mini-*` vs `awcms-*`). awcms menambah skill `awcms-port-from-mini`
  (playbook port modul dari mini).

## 6. Rujukan

- [`awcms-mini/README.md`](awcms-mini/README.md) — paket dokumen teknis standar repo ini.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — arsitektur kode awcms-mini.
- Repo turunan: **github.com/ahliweb/awcms** — lihat `docs/awcms/alur-pengembangan-mini-first.md` di sana untuk kontrak alur port dari sisi awcms.
