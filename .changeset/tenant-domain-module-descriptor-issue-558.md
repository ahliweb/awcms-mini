---
"awcms-mini": minor
---

Register `tenant_domain` as a first-class AWCMS-Mini module (Issue #558,
epic #555): `src/modules/tenant-domain/module.ts` declares `type:
"system"`, `dependencies: ["tenant_admin", "identity_access"]`,
`api.basePath: "/api/v1/tenant/domains"`, `navigation.path:
"/admin/tenant/domains"`, the six `tenant_domain.domains.*` permissions
seeded by `sql/032_awcms_mini_tenant_domain_permissions.sql`
(`read`/`create`/`update`/`delete`/`verify`/`set_primary`), and
`settings.defaults: { defaultVerificationMethod: "manual" }` (manual DNS
mode only — no automatic provider default). Registered in
`src/modules/index.ts`'s `listModules()` so `bun run modules:sync` picks
it up and Module Management's permission sync/status report has a
descriptor to compare the migration 032 seed against. Descriptor
metadata only — no API implementation, admin UI, host-based resolver, or
Cloudflare DNS adapter in this issue (those are #559/#562/#563/#567).
Covered by `tests/modules/tenant-domain-module.test.ts`.
