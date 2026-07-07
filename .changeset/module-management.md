---
"awcms-mini": minor
---

Add a database-backed, tenant-aware Module Management system (epic #510,
Issues #511-#521): extends the code-only module registry
(`src/modules/index.ts`) with a synced database registry
(`awcms_mini_modules`/`_dependencies`/`_navigation`/`_jobs`/`_health_checks`,
`sql/025`), tenant module lifecycle with server-side dependency
validation (`POST /api/v1/tenant/modules/{moduleKey}/{enable,disable}`),
non-secret tenant module settings
(`GET/PATCH /api/v1/tenant/modules/{moduleKey}/settings`), module
permission sync/status reporting
(`GET /api/v1/modules/{moduleKey}/permissions`), an admin navigation
registry (`module_management.navigation.read`, first real consumer of a
permission seeded since Issue #512), a documentation-only operational job
registry (`GET /api/v1/modules/{moduleKey}/jobs`), module health/readiness
checks (`GET /api/v1/modules/{moduleKey}/health`,
`POST .../health/check`, an explicit and bounded live provider check for
`email`), and a full admin UI (`/admin/modules`,
`/admin/modules/{moduleKey}`) covering every one of the above as a
permission-gated panel. Also adds `enable`/`disable`/`check` to the ABAC
action vocabulary, and enforces `403 MODULE_DISABLED` for any request to
a tenant-disabled module directly in the shared access guard (not just
the lifecycle endpoint itself). See `src/modules/module-management/README.md`.
