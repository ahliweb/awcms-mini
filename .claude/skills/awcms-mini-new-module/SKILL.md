---
name: awpos-new-module
description: Scaffold modul baru pada modular monolith AWPOS. Gunakan saat membuat modul domain baru di src/modules/ (mis. warehouse-management, accounting-tax) atau saat memerlukan struktur module.ts + domain/application/infrastructure/api + README. Ikuti struktur standar doc 10 & 11.
---

# AWPOS — New Module Scaffold

Buat modul mengikuti struktur standar di `docs/awpos/10_template_kode_coding_standard.md` dan `docs/awpos/11_implementation_blueprint.md`.

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
  status: "active", // active | experimental | deprecated
  description: "...",
  dependencies: ["tenant_admin", "identity_access", "observability_logging"],
  api: { openApiPath: "openapi/modules/<module>.openapi.yaml", basePath: "/api/v1" },
  events: {
    asyncApiPath: "asyncapi/modules/<module>-events.asyncapi.yaml",
    publishes: [],
    subscribes: []
  }
};
```

## Aturan

1. Daftarkan modul di `src/modules/index.ts` (`modules[]`).
2. `key` = `snake_case`; folder = `kebab-case`; type = `PascalCase`.
3. Route tipis → guard → validasi → service → repository (lihat `awpos-abac-guard`).
4. Sertakan TODO jelas; jangan klaim production-ready.
5. Jika modul punya tabel → `awpos-new-migration`. Jika ada API → `awpos-new-endpoint`. Jika ada event → `awpos-new-event`.

## Nama modul valid

`tenant-admin`, `identity-access`, `profile-identity`, `catalog-inventory`, `sales-pos`, `shared-stock-routing`, `warehouse-management`, `accounting-tax`, `crm-communication`, `sync-storage`, `ai-analyst`, `localization-ui`, `observability-logging`, `database-connectivity`, `workflow-approval`, `management-reporting`, `ui-experience`, `production-security-readiness`.

## Verifikasi

- `bun run build` pass.
- Modul terdaftar di registry.
- README modul terisi.
