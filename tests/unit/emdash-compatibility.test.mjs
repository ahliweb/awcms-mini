import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzeEmdashCompatibilityLedger,
  buildEmdashCompatibilityLedger,
  EMDASH_MINI_COMPATIBILITY_MIGRATIONS,
} from "../../src/db/migrations/emdash-compatibility.mjs";

test("buildEmdashCompatibilityLedger returns deterministic contiguous migration timestamps", async () => {
  const ledger = buildEmdashCompatibilityLedger(new Date("2026-01-01T00:00:00.000Z"));

  assert.equal(ledger.length, EMDASH_MINI_COMPATIBILITY_MIGRATIONS.length);
  assert.deepEqual(
    ledger.map((entry) => entry.name),
    EMDASH_MINI_COMPATIBILITY_MIGRATIONS,
  );
  assert.equal(ledger[0]?.timestamp, "2026-01-01T00:00:00.000Z");
  assert.equal(ledger[1]?.timestamp, "2026-01-01T00:01:00.000Z");
  assert.equal(ledger.at(-1)?.timestamp, "2026-01-01T00:08:00.000Z");
});

test("analyzeEmdashCompatibilityLedger accepts a valid Mini compatibility prefix", async () => {
  const analysis = analyzeEmdashCompatibilityLedger([
    "001_initial",
    "002_media_status",
    "003_schema_registry",
  ]);

  assert.equal(analysis.compatiblePrefix, true);
  assert.deepEqual(analysis.mismatches, []);
  assert.deepEqual(analysis.unexpected, []);
  assert.deepEqual(analysis.missing, EMDASH_MINI_COMPATIBILITY_MIGRATIONS.slice(3));
});

test("analyzeEmdashCompatibilityLedger flags out-of-order applied migrations", async () => {
  const analysis = analyzeEmdashCompatibilityLedger([
    "001_initial",
    "003_schema_registry",
    "002_media_status",
  ]);

  assert.equal(analysis.compatiblePrefix, false);
  assert.deepEqual(analysis.mismatches, [
    {
      index: 1,
      expected: "002_media_status",
      actual: "003_schema_registry",
    },
    {
      index: 2,
      expected: "003_schema_registry",
      actual: "002_media_status",
    },
  ]);
});

test("analyzeEmdashCompatibilityLedger flags unexpected migrations outside the Mini compatibility set", async () => {
  const analysis = analyzeEmdashCompatibilityLedger([
    "001_initial",
    "002_media_status",
    "026_cron_tasks",
  ]);

  assert.equal(analysis.compatiblePrefix, false);
  assert.deepEqual(analysis.unexpected, ["026_cron_tasks"]);
});
