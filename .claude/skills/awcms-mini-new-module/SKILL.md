---
name: awcms-mini-new-module
description: Scaffold modul baru pada modular monolith AWCMS-Mini. Gunakan saat membuat modul domain baru di src/modules/ (mis. warehouse-management, accounting-tax) atau saat memerlukan struktur module.ts + domain/application/infrastructure/api + README. Ikuti struktur standar doc 10 & 11.
---

# AWCMS-Mini — New Module Scaffold

Buat modul mengikuti struktur standar di `docs/awcms-mini/10_template_kode_coding_standard.md` dan `docs/awcms-mini/11_implementation_blueprint.md`.

## Struktur wajib

```text
src/modules/<module-kebab>/
├── module.ts            # ModuleDescriptor
├── domain/              # entities.ts, value-objects.ts, events.ts
├── application/         # services.ts, commands.ts, queries.ts
├── infrastructure/      # repository.ts, mappers.ts
├── api/                 # routes.ts, schemas.ts, handlers.ts
└── README.md            # ringkas: tujuan, tabel, endpoint, event, dependency
```

## Module descriptor (`module.ts`)

```ts
import type { ModuleDescriptor } from "../_shared/module-contract";

export const <camelCase>Module: ModuleDescriptor = {
  key: "<snake_case>",
  name: "<Nama Modul>",
  version: "0.1.0",
  status: "active", // active | experimental | deprecated | maintenance | disabled
  description: "...",
  dependencies: ["tenant_admin", "identity_access", "observability_logging"],
  type: "domain", // base | system | domain | integration | derived — modul domain baru (bukan infrastruktur generik) pakai "domain"
  api: { openApiPath: "openapi/modules/<module>.openapi.yaml", basePath: "/api/v1" },
  events: {
    asyncApiPath: "asyncapi/modules/<module>-events.asyncapi.yaml",
    publishes: [],
    subscribes: []
  }
  // Field opsional lain (Issue #511, epic #510 — Module Management):
  // isCore, permissions, navigation, settings, jobs, health,
  // compatibility, maintainers. Deklarasikan hanya setelah fitur
  // sungguhan yang bersangkutan ADA di modul ini — jangan klaim
  // kapabilitas yang belum diimplementasi (lihat contoh nyata:
  // `src/modules/module-management/module.ts` menambah `navigation`
  // baru setelah Issue #518 selesai, `jobs` setelah #519, satu-satu).
};
```

## Aturan

1. Daftarkan modul di `src/modules/index.ts` (`modules[]`).
2. `key` = `snake_case`; folder = `kebab-case`; type = `PascalCase`.
3. Route tipis → guard → validasi → service → repository (lihat `awcms-mini-abac-guard`).
4. Sertakan TODO jelas; jangan klaim production-ready.
5. Jika modul punya tabel → `awcms-mini-new-migration`. Jika ada API → `awcms-mini-new-endpoint`. Jika ada event → `awcms-mini-new-event`.
6. **Sync descriptor ke database registry wajib** (Issue #513, epic #510) — mendaftarkan modul di `src/modules/index.ts` saja **tidak otomatis** membuat baris `awcms_mini_modules`/`_dependencies`/`_navigation`/`_jobs`. Jalankan `POST /api/v1/modules/sync` (atau `bun run modules:sync` bila skrip CLI tersedia) minimal sekali setelah modul terdaftar — atau andalkan sinkronisasi otomatis yang sudah terpasang di beberapa mutasi tenant-scoped modul lain yang punya FK ke `awcms_mini_modules` (`enableTenantModule`/`disableTenantModule`/`updateModuleSettings`/`runModuleHealthCheck` semua memanggil `syncModuleDescriptors(tx)` sendiri) — **jangan asumsikan** operator sudah sync manual sebelum modul barumu dipakai lewat jalur itu.
7. Jika modul mendeklarasikan `permissions` di descriptor, verifikasi juga migration seed permission-nya konsisten (`GET /api/v1/modules/{moduleKey}/permissions`, Issue #517, akan melaporkan `missing`/`mismatched_description` kalau tidak sinkron).

## Nama modul valid

Domain retail/POS contoh (aspirational, belum tentu ada di base generik ini): `tenant-admin`, `identity-access`, `profile-identity`, `catalog-inventory`, `sales-pos`, `shared-stock-routing`, `warehouse-management`, `accounting-tax`, `crm-communication`, `sync-storage`, `ai-analyst`, `localization-ui`, `observability-logging`, `database-connectivity`, `workflow-approval`, `management-reporting`, `ui-experience`, `production-security-readiness`.

Modul base generik yang **sudah nyata terdaftar** di repo ini (`src/modules/index.ts`, 14 modul): `tenant-admin`, `profile-identity`, `identity-access`, `sync-storage`, `reporting`, `logging`, `workflow-approval`, `form-drafts`, `email`, `module-management`, `blog-content`, `tenant-domain`, `visitor-analytics`, `news-portal`.

## Sebelum scaffold modul baru: cek kebijakan admission

Sebelum membuat modul baru di repo base ini (bukan sekadar mengubah modul
yang sudah ada), baca `docs/awcms-mini/21_module_admission_governance.md`
(kategori Core/System/Official Optional Module/Derived Application/
External Integration, pohon keputusan admission, kriteria dependency &
security review) dan isi
`docs/awcms-mini/templates/module-proposal-template.md` di issue GitHub
terkait. Modul spesifik satu domain bisnis (POS, gudang, pajak, CRM, dll.)
**tidak masuk repo ini** — lihat pohon keputusan di doc 21 §3.

## Verifikasi

- `bun run build` pass.
- Modul terdaftar di registry.
- README modul terisi.
