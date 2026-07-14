-- Fixture migration (Issue #755, epic #738 `platform-evolution`, Wave 4,
-- ADR-0019) — illustration only, never applied to a real database, never
-- wired into `bun run db:migrate`. Demonstrates that ALL of a sample ERP
-- extension's own tables (a minimal posting-result ledger here) live
-- entirely inside the extension's own reserved migration range
-- (900-999, see `../application-registry.ts`), never in this base
-- repository's real `sql/` directory or module registry — ADR-0019's
-- explicit exclusion of chart-of-accounts/journal/inventory-valuation/
-- sales/procurement/AR-AP/payroll/tax/asset/manufacturing tables from the
-- base. Numbered 901 (after the sibling `example_crm` fixture's 900) —
-- see `extension-compatibility.ts`'s `checkMigrations` for why a NEW
-- migration number above the highest already-declared historical
-- checksum needs no `historicalChecksums` manifest entry of its own.
CREATE TABLE IF NOT EXISTS example_erp_extension_posting_results_fixture_only (
  id bigserial PRIMARY KEY,
  request_id text NOT NULL UNIQUE,
  status text NOT NULL
);
