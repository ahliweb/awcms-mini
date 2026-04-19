export const EMDASH_MINI_COMPATIBILITY_MIGRATIONS = Object.freeze([
  "001_initial",
  "002_media_status",
  "003_schema_registry",
  "004_plugins",
  "005_menus",
  "006_taxonomy_defs",
  "007_widgets",
  "008_auth",
  "009_user_disabled",
]);

export function buildEmdashCompatibilityLedger(seedDate = new Date("2026-01-01T00:00:00.000Z")) {
  const baseTime = seedDate.getTime();

  return EMDASH_MINI_COMPATIBILITY_MIGRATIONS.map((name, index) => ({
    name,
    timestamp: new Date(baseTime + index * 60_000).toISOString(),
  }));
}

export function analyzeEmdashCompatibilityLedger(names) {
  const applied = Array.isArray(names) ? names : [];
  const expected = EMDASH_MINI_COMPATIBILITY_MIGRATIONS;
  const mismatches = [];

  for (let index = 0; index < applied.length && index < expected.length; index += 1) {
    if (applied[index] !== expected[index]) {
      mismatches.push({
        index,
        expected: expected[index],
        actual: applied[index],
      });
    }
  }

  const expectedSet = new Set(expected);

  return {
    compatiblePrefix: mismatches.length === 0 && applied.length <= expected.length,
    mismatches,
    missing: expected.filter((name) => !applied.includes(name)),
    unexpected: applied.filter((name) => !expectedSet.has(name)),
  };
}
