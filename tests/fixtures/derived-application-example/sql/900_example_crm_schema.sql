-- Fixture migration (Issue #741, epic #738 `platform-evolution`, Wave 1)
-- — illustration only, never applied to a real database, never wired
-- into `bun run db:migrate`. Exists solely so
-- `tests/fixtures/derived-application-example/extension.manifest.json`
-- has a real on-disk file to declare a historical checksum against, and
-- `tests/unit/extension-check-fixtures.test.ts` has something real to
-- point `--migrations-dir` at.
CREATE TABLE IF NOT EXISTS example_crm_contacts_fixture_only (
  id bigserial PRIMARY KEY
);
