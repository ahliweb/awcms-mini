# `data_exchange`

Provider-neutral staged CSV/JSON import/export framework (Issue #752, epic
`platform-evolution` #738 Wave 3, `docs/adr/0017-data-exchange-module-admission.md`).
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
GET /imports/{id}/preview                   -- zero-mutation, masked unless preview_errors.read
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
  import history). See that file's adversarial round-trip test.
- **Unbounded parsing**: HTTP body capped (5 MiB, `readFormBody("large")`)
  BEFORE any parsing. CSV parsing (`domain/csv-codec.ts`) is a hand-written
  state machine that aborts MID-PARSE the instant `maxRowCount`/
  `maxFieldsPerRow` is exceeded. JSON parsing is bounded by the same
  byte cap before `JSON.parse`, then checked immediately after (see that
  file's own header for why JSON cannot abort mid-parse the way CSV does).
- **Cross-tenant isolation**: every table (`import_batches`, `staged_rows`,
  `export_jobs`, `reconciliation_reports`, `reference_items`) has RLS
  predicate `tenant_id` only, `ENABLE`+`FORCE ROW LEVEL SECURITY`. The
  commit/export pipeline always runs inside `withTenant`, so an owning
  adapter only ever sees the tenant currently being processed.
- **Async idempotent commit**: `runImportCommitPass` only ever selects
  `commit_status = 'pending'` staged rows; a worker restart mid-commit
  (`requestImportRetry`) can never re-apply an already-`'committed'` row.
  The reference adapter's `commitRow` is ALSO idempotent per `naturalKey`
  as defense-in-depth (re-checks current state before writing).
- **Idempotency-Key** required on every mutating endpoint: stage-upload,
  commit, cancel, retry, pause, resume (imports); create, cancel
  (exports).
- **Preview/error artifact masking**: `data_exchange.preview_errors.read`
  is a separate permission from `data_exchange.imports.read` — raw invalid
  row values are masked by default.
- **Export downloads**: `data_exchange.export_downloads.read` is a
  separate, more sensitive permission from `data_exchange.exports.read`.

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
  `json-codec.ts`, `safe-filename.ts`, `import-batch-state.ts`,
  `export-job-state.ts`, `reconciliation.ts`, `exchange-registry.ts`,
  `reference-item-validation.ts`.
- `application/` — `import-batch-directory.ts`, `import-parse-validate-job.ts`,
  `import-commit-job.ts`, `export-job-directory.ts`, `export-execute-job.ts`,
  `reconciliation-service.ts`, `staged-row-directory.ts`,
  `reference-items-directory.ts`, `reference-items-exchange-adapter.ts`,
  `data-exchange-worker.ts`.
- `infrastructure/exchange-adapter-registry.ts` — static registry, same
  shape as `domain-event-runtime/infrastructure/consumer-registry.ts`.
- `sql/066_awcms_mini_data_exchange_schema.sql`,
  `sql/067_awcms_mini_data_exchange_permissions.sql`.
- `scripts/data-exchange-worker.ts` (`bun run data-exchange:worker`).
- Admin UI: `src/pages/admin/data-exchange/imports.astro`,
  `imports/[id].astro`, `exports.astro`.
