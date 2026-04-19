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

export const EMDASH_MINI_COMPATIBILITY_SEED_DATE = "2026-01-01T00:00:00.000Z";

function normalizeLedgerCount(count) {
  if (!Number.isInteger(count)) {
    return EMDASH_MINI_COMPATIBILITY_MIGRATIONS.length;
  }

  return Math.max(0, Math.min(count, EMDASH_MINI_COMPATIBILITY_MIGRATIONS.length));
}

function parseLedgerTimestamp(timestamp) {
  const value = new Date(timestamp).getTime();
  return Number.isNaN(value) ? null : value;
}

export function buildEmdashCompatibilityLedger(
  seedDate = new Date(EMDASH_MINI_COMPATIBILITY_SEED_DATE),
  count = EMDASH_MINI_COMPATIBILITY_MIGRATIONS.length,
) {
  const baseTime = seedDate.getTime();
  const size = normalizeLedgerCount(count);

  return EMDASH_MINI_COMPATIBILITY_MIGRATIONS.slice(0, size).map((name, index) => ({
    name,
    timestamp: new Date(baseTime + index * 60_000).toISOString(),
  }));
}

export function sortEmdashCompatibilityLedgerEntries(entries) {
  const applied = Array.isArray(entries) ? [...entries] : [];

  return applied.sort((left, right) => {
    const leftTime = parseLedgerTimestamp(left?.timestamp);
    const rightTime = parseLedgerTimestamp(right?.timestamp);

    if (leftTime === null && rightTime === null) {
      return String(left?.name ?? "").localeCompare(String(right?.name ?? ""));
    }

    if (leftTime === null) {
      return 1;
    }

    if (rightTime === null) {
      return -1;
    }

    if (leftTime === rightTime) {
      return String(left?.name ?? "").localeCompare(String(right?.name ?? ""));
    }

    return leftTime - rightTime;
  });
}

export function resolveEmdashCompatibilitySeedDate(entries) {
  const ordered = sortEmdashCompatibilityLedgerEntries(entries);
  const firstValidTimestamp = ordered.map((entry) => parseLedgerTimestamp(entry?.timestamp)).find((value) => value !== null);

  if (firstValidTimestamp === undefined) {
    return new Date(EMDASH_MINI_COMPATIBILITY_SEED_DATE);
  }

  return new Date(firstValidTimestamp);
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

export function planEmdashCompatibilityLedgerRepair(entries) {
  const orderedEntries = sortEmdashCompatibilityLedgerEntries(entries);
  const orderedNames = orderedEntries.map((entry) => entry.name);
  const analysis = analyzeEmdashCompatibilityLedger(orderedNames);
  const expectedPrefix = EMDASH_MINI_COMPATIBILITY_MIGRATIONS.slice(0, orderedNames.length);
  const orderedSet = new Set(orderedNames);
  const hasCanonicalPrefixSet =
    orderedNames.length > 0 &&
    analysis.unexpected.length === 0 &&
    expectedPrefix.length === orderedNames.length &&
    expectedPrefix.every((name) => orderedSet.has(name));

  if (orderedEntries.length === 0) {
    return {
      state: "empty",
      orderedEntries,
      orderedNames,
      analysis,
      expectedPrefix,
      targetLedger: [],
    };
  }

  if (analysis.compatiblePrefix) {
    return {
      state: "compatible",
      orderedEntries,
      orderedNames,
      analysis,
      expectedPrefix,
      targetLedger: buildEmdashCompatibilityLedger(resolveEmdashCompatibilitySeedDate(orderedEntries), orderedEntries.length),
    };
  }

  if (hasCanonicalPrefixSet) {
    return {
      state: "repairable",
      orderedEntries,
      orderedNames,
      analysis,
      expectedPrefix,
      targetLedger: buildEmdashCompatibilityLedger(resolveEmdashCompatibilitySeedDate(orderedEntries), orderedEntries.length),
    };
  }

  return {
    state: "unsafe",
    orderedEntries,
    orderedNames,
    analysis,
    expectedPrefix,
    targetLedger: [],
  };
}
