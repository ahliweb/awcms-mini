# `data_exchange`

Provider-neutral staged CSV/JSON import/export framework (Issue #752, epic
`platform-evolution` #738 Wave 3, `docs/adr/0018-data-exchange-module-admission.md`).
Official Optional Module (`type: "domain"`, ADR-0013 §3 "Official Optional
Business Foundation"), opt-in per tenant.

## What this module is

A generic, reusable MECHANISM for staged file import/export: intake,
bounded parse/validate, preview (zero mutation), asynchronous idempotent
commit, export with manifest/checksum, and reconciliation. It does **not**
implement any real business schema itself — every owning module supplies
its own schema/validation/mapping/commit adapter through a capability port
(`DataExchangeAdapterPort`/`DataExchangeExportSourcePort`,
`src/modules/_shared/ports/data-exchange-adapter-port.ts`) and a pure-data
descriptor (`ExchangeDescriptor`, `src/modules/_shared/module-contract.ts`'s
`dataExchange` field) — this module never writes to another module's
tables directly (ADR-0013 §6 "no shared-table write").

This PR (Issue #752) ships exactly ONE self-contained reference
descriptor/adapter pair — `reference_items` — proving the mechanism
end-to-end (create/update/conflict, partial-failure/resume, export/
reconciliation) without touching any other module's files, mirroring the
accepted "foundation issue ships zero real business integrations"
precedent (`domain_event_runtime`, Issue #742). A real owning module wires
its own adapter as a follow-up issue.

## Pipeline

```
POST /imports (multipart/form-data)         -> stage (checksum, size bound, Idempotency-Key)
  |
  v  (worker: bun run data-exchange:worker)
runImportValidatePass  -- bounded passes, staged -> validating -> previewed
  |  (parses CSV/JSON with row/field bounds + formula-injection neutralization)
  v
GET /imports/{id}/preview                   -- zero-mutation, masked per descriptor's sensitiveFields
  |
POST /imports/{id}/commit                   -- previewed -> committing (trigger only, Idempotency-Key)
  |
  v  (worker)
runImportCommitPass -- bounded, resumable passes, per-row idempotent commit via adapter
  |
  v
committed | partially_committed             -- reconciliation report recorded
```

Export mirrors this with `POST /exports` (queue) -> worker `runExportJob`
(paginated read via `DataExchangeExportSourcePort`, formula-injection
neutralization at serialization) -> `completed` -> `GET /exports/{id}/download`.

## Security

- **Formula injection (CSV injection)**: any string field beginning with
  `=`/`+`/`-`/`@`/TAB/CR is neutralized (leading `'` prefix) BOTH at import
  intake (`domain/formula-injection-guard.ts`, before a row is ever
  persisted) AND at export serialization (defense in depth, independent of
  import history) — including a nested array/object field, whose CSV
  `String()` form (e.g. `String(["=1+1"])` === `"=1+1"`) is what is
  actually checked, not just a scalar-only pass (`export-execute-job.ts`'s
  `neutralizeRowForExport`). See that file's and the guard's own
  adversarial round-trip tests.
- **Unbounded parsing**: HTTP body capped (5 MiB, `readFormBody("large")`)
  BEFORE any parsing. CSV parsing (`domain/csv-codec.ts`) is a hand-written
  state machine that aborts MID-PARSE the instant `maxRowCount`/
  `maxFieldsPerRow` is exceeded. JSON parsing is bounded by the same
  byte cap before `JSON.parse`, then checked immediately after (see that
  file's own header for why JSON cannot abort mid-parse the way CSV does).
- **Media-type verification**: the declared upload's `File.type` (as
  Bun's `request.formData()` resolves it — verified directly to be
  filename-extension-derived, not a literal per-part `Content-Type`
  header pass-through, see `domain/media-type-allowlist.ts`'s own header)
  is checked against a per-format allow-list at intake, `415` if not
  allowed — a real, enforced bound, not just documented.
- **Cross-tenant isolation**: every table (`import_batches`, `staged_rows`,
  `export_jobs`, `reconciliation_reports`, `reference_items`) has RLS
  predicate `tenant_id` only, `ENABLE`+`FORCE ROW LEVEL SECURITY`. The
  commit/export pipeline always runs inside `withTenant`, so an owning
  adapter only ever sees the tenant currently being processed.
- **Async idempotent commit, one transaction PER item**: `runImportCommitPass`
  only ever selects `commit_status = 'pending'` staged rows; a worker
  restart mid-commit (`requestImportRetry`) can never re-apply an
  already-`'committed'` row. The reference adapter's `commitRow` is ALSO
  idempotent per `naturalKey` as defense-in-depth. `data-exchange-worker.ts`
  opens a SEPARATE `withTenant` transaction for every batch's validate
  pass, every batch's commit pass, and every export job — an exception in
  ONE never rolls back an unrelated item processed earlier in the same
  pass (verified by an integration test that deliberately throws mid-pass).
- **`ExchangeDescriptor.requiredPermission` enforcement**: every route that
  resolves a descriptor (stage, preview, commit, retry, export-create,
  export-download) checks `application/descriptor-authorization.ts`'s
  `authorizeExchangeDescriptorPermission` — when a descriptor declares an
  extra owning-module permission, the subject must hold it too, default-deny,
  fail-closed on a malformed permission string. `reference_items` itself
  does not set one today; the enforcement point is proven with a
  synthetic descriptor in the integration suite. (Security-auditor finding
  on PR #782: `exports/[id]/download.ts` — the route serving the raw
  materialized export FILE CONTENT, more sensitive than the job metadata
  `exports.read` already covers — was initially missed; a stale README
  claim of full coverage is exactly the kind of gap this epic's reviews
  keep catching, so every call site's coverage here is proven by a test,
  not just asserted in prose.)
- **Idempotency-Key** required on every mutating endpoint: stage-upload,
  commit, cancel, retry, pause, resume (imports); create, cancel
  (exports).
- **Preview raw-value masking is default-deny and descriptor-driven**
  (hardened by Issue #820): a descriptor MUST declare `sensitiveFields`
  (the registry gate rejects one that does not) — declare
  `{ fieldNames: [] }` to state affirmatively that nothing is sensitive.
  Fields named in `fieldNames` are unmasked ONLY for a caller holding the
  permission that same descriptor names in `sensitiveFields.rawValuePermission`
  — its own, narrow permission, never a generic `data_exchange.*` one. A
  descriptor with no policy at all is masked entirely and no permission
  unmasks it. `naturalKey` is masked too when `sensitiveFields.naturalKeyField`
  names a field that is itself sensitive (a profile import's dedup key is
  typically the email/NIK — masking the `fields` copy while echoing the
  same value back as `naturalKey` would mask nothing).
  Before #820 all of this was inverted: omitting `sensitiveFields` returned
  every staged value raw with no check at all, `rawValuePermission` was
  validated at registration but enforced nowhere, and the route gated on a
  hardcoded, far broader `data_exchange.preview_errors.read` instead.
- **An unresolvable descriptor fails closed** (Issue #820): if a batch's
  `importKey`/`exportKey` stops resolving because its owning module was
  disabled or removed via `module_management` after staging, preview/commit/
  retry/download answer `409 INVALID_STATE` rather than proceeding. A batch
  must never become MORE accessible than while its module was running —
  which is what passing a `null` descriptor to the descriptor gate used to
  cause. `authorizeExchangeDescriptorPermission` no longer accepts `null`
  at all, so each route must decide explicitly.
- **Preview pagination is bounded on both ends** (Issue #831): `limit` is
  capped at `PREVIEW_PAGE_SIZE_MAX`, and `offset` at `PREVIEW_OFFSET_MAX`
  (= `MAX_EXCHANGE_ROW_COUNT`, so it can hide no reachable row). A single
  large CSV fills `staged_rows` to deep-offset volume in one shot.
- **Export downloads**: `data_exchange.export_downloads.read` is a
  separate, more sensitive permission from `data_exchange.exports.read`,
  and every download writes its own `recordAuditEvent` entry (distinct
  from the export job's own "completed" audit entry) — WHO downloaded the
  raw artifact is traceable, not just that the job finished.

## Known limitation (v1 scope)

A per-row `retryable` commit failure stops the current worker pass without
marking the row `'failed'` (it stays `'pending'`, retried on the NEXT
scheduled tick) — see `application/import-commit-job.ts`'s header. There is
no automatic escalation from "retryable" to "failed" after N attempts; a
row stuck in a persistent transient-failure loop requires operator
intervention (pause + manual investigation). Not attempted here to keep
this issue's scope bounded — a natural follow-up if a real owning adapter
needs it.

## Files

- `domain/` — pure logic: `formula-injection-guard.ts`, `csv-codec.ts`,
  `json-codec.ts`, `safe-filename.ts`, `media-type-allowlist.ts`,
  `import-batch-state.ts`, `export-job-state.ts`, `reconciliation.ts`,
  `exchange-registry.ts`, `reference-item-validation.ts`.
- `application/` — `import-batch-directory.ts`, `import-parse-validate-job.ts`,
  `import-commit-job.ts`, `export-job-directory.ts`, `export-execute-job.ts`,
  `reconciliation-service.ts`, `staged-row-directory.ts`,
  `reference-items-directory.ts`, `reference-items-exchange-adapter.ts`,
  `descriptor-authorization.ts`, `data-exchange-worker.ts`.
- `infrastructure/exchange-adapter-registry.ts` — static registry, same
  shape as `domain-event-runtime/infrastructure/consumer-registry.ts`.
- `sql/071_awcms_mini_data_exchange_schema.sql`,
  `sql/072_awcms_mini_data_exchange_permissions.sql`.
- `scripts/data-exchange-worker.ts` (`bun run data-exchange:worker`).
- Admin UI: `src/pages/admin/data-exchange/imports.astro`,
  `imports/[id].astro`, `exports.astro`.
