---
"awcms-mini": minor
---

Add the `data_exchange` module (Issue #752, epic `platform-evolution`
#738 Wave 3, ADR-0017) — a provider-neutral, generic staged CSV/JSON
import/export framework: module-contributed exchange descriptors,
checksum/size/row/field-bounded staged intake with formula-injection
(CSV injection) neutralization, zero-mutation preview, an asynchronous
idempotent resumable commit via a new `bun run data-exchange:worker`
job, export jobs with manifest/checksum, and reconciliation. Every
owning module supplies its own schema/validation/mapping/commit
adapter through a new capability port (`DataExchangeAdapterPort`/
`DataExchangeExportSourcePort`); this module never writes to another
module's tables directly. Ships one self-contained reference fixture
(`reference_items`) proving create/update/conflict, partial-failure/
resume, and export/reconciliation end-to-end. Five new tables (RLS
`FORCE`d, tenant-scoped), 13 new permissions, new REST endpoints under
`/api/v1/data-exchange/*`, new admin UI screens, and six new domain
events.
