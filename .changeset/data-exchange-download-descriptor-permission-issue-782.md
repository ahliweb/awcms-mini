---
"awcms-mini": patch
---

Fix a High security-auditor finding on PR #782 (Issue #752, data_exchange
module): `GET /api/v1/data-exchange/exports/{id}/download` — the route
serving the raw materialized export FILE CONTENT — never called
`authorizeExchangeDescriptorPermission` before serving it, unlike every
other route that resolves an `ExchangeDescriptor` (stage, preview,
commit, retry, export-create). Not live-exploitable today (no shipped
descriptor sets `requiredPermission` yet), but a future owning module
registering a sensitive export descriptor (e.g. payroll, HR) with its own
`requiredPermission` would have had that gate silently skipped for
downloads, letting any caller holding only the generic
`data_exchange.export_downloads.read` permission download it. `download.ts`
now resolves the job's descriptor and enforces its `requiredPermission`
before serving content, mirroring `exports/index.ts`'s existing pattern.
