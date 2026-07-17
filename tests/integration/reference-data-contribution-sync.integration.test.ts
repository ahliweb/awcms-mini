/**
 * Integration tests for `syncReferenceDataContributions`
 * (`reference-data/application/contribution-sync.ts`) against real
 * PostgreSQL, focused on the Issue #835 §2 refactor: existing codes are
 * bulk-read once (`code = ANY(...)`) instead of one SELECT per code, and code
 * translations are RECONCILED BY DIFF instead of delete-all-then-reinsert.
 * The refactor must preserve every existing semantic: idempotent re-sync,
 * per-code create/update, "a manually-created row is never overwritten, it is
 * reported as a conflict", and correct add/change/remove of localized labels.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  getAdminSql,
  integrationEnabled,
  provisionAppRole,
  resetDatabase
} from "./harness";

import { syncReferenceDataContributions } from "../../src/modules/reference-data/application/contribution-sync";
import type {
  ModuleDescriptor,
  ReferenceCodeContribution
} from "../../src/modules/_shared/module-contract";

const VALUE_SET_KEY = "test_contrib_set";

function descriptorWith(codes: ReferenceCodeContribution[]): ModuleDescriptor {
  return {
    key: "reference_data",
    referenceData: {
      contributesValueSets: [
        {
          key: VALUE_SET_KEY,
          name: "Test Contribution Set",
          description: "synthetic value set for the contribution-sync tests",
          overridePolicy: "none",
          codes
        }
      ]
    }
  } as unknown as ModuleDescriptor;
}

async function sync(descriptor: ModuleDescriptor) {
  const admin = getAdminSql();
  return admin.begin((tx) => syncReferenceDataContributions(tx, [descriptor]));
}

async function fetchTranslations(
  code: string
): Promise<{ locale: string; label: string; updated_at: Date }[]> {
  const admin = getAdminSql();
  return (await admin`
    SELECT t.locale, t.label, t.updated_at
    FROM awcms_mini_reference_code_translations t
    JOIN awcms_mini_reference_codes c ON c.id = t.code_id
    JOIN awcms_mini_reference_value_sets vs ON vs.id = c.value_set_id
    WHERE vs.key = ${VALUE_SET_KEY} AND c.code = ${code}
    ORDER BY t.locale
  `) as { locale: string; label: string; updated_at: Date }[];
}

const suite = integrationEnabled ? describe : describe.skip;

suite("reference-data contribution sync — bulk read + translation diff", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  test("creates codes + translations, then an unchanged re-sync writes NO translation churn", async () => {
    const created = await sync(
      descriptorWith([
        {
          code: "ALPHA",
          labels: [
            { locale: "en", label: "Alpha" },
            { locale: "id", label: "Alfa" }
          ]
        },
        { code: "BETA", labels: [{ locale: "en", label: "Beta" }] }
      ])
    );
    expect(created.valueSetsCreated).toEqual([VALUE_SET_KEY]);
    expect(created.codesCreated).toBe(2);
    expect(created.conflicts).toEqual([]);

    const before = await fetchTranslations("ALPHA");
    expect(before.map((r) => r.locale)).toEqual(["en", "id"]);
    const enBefore = before.find((r) => r.locale === "en")!.updated_at;

    // Idempotent re-sync of the SAME descriptor: the diff must touch no
    // translation row (the old delete-all+reinsert rewrote every row here).
    const resynced = await sync(
      descriptorWith([
        {
          code: "ALPHA",
          labels: [
            { locale: "en", label: "Alpha" },
            { locale: "id", label: "Alfa" }
          ]
        },
        { code: "BETA", labels: [{ locale: "en", label: "Beta" }] }
      ])
    );
    expect(resynced.codesCreated).toBe(0);
    expect(resynced.codesUpdated).toBe(2);

    const after = await fetchTranslations("ALPHA");
    const enAfter = after.find((r) => r.locale === "en")!.updated_at;
    // Same row, untouched: updated_at did not move.
    expect(new Date(enAfter).getTime()).toBe(new Date(enBefore).getTime());
  });

  test("re-sync changes only the modified locale and removes a dropped locale", async () => {
    await sync(
      descriptorWith([
        {
          code: "ALPHA",
          labels: [
            { locale: "en", label: "Alpha" },
            { locale: "id", label: "Alfa" }
          ]
        }
      ])
    );
    const before = await fetchTranslations("ALPHA");
    const idBefore = before.find((r) => r.locale === "id")!.updated_at;

    // Change en's label; drop id entirely.
    await sync(
      descriptorWith([
        { code: "ALPHA", labels: [{ locale: "en", label: "Alpha v2" }] }
      ])
    );

    const after = await fetchTranslations("ALPHA");
    expect(after.map((r) => r.locale)).toEqual(["en"]);
    expect(after[0]!.label).toBe("Alpha v2");
    // Sanity: `id` really was removed (not just filtered by the query).
    expect(after.some((r) => r.locale === "id")).toBe(false);
    void idBefore;
  });

  test("a manually-created colliding code is reported as a conflict, never overwritten", async () => {
    // First establish the value set via a normal sync...
    await sync(
      descriptorWith([
        { code: "ALPHA", labels: [{ locale: "en", label: "Alpha" }] }
      ])
    );

    const admin = getAdminSql();
    const valueSetRows = (await admin`
      SELECT id FROM awcms_mini_reference_value_sets WHERE key = ${VALUE_SET_KEY}
    `) as { id: string }[];
    const valueSetId = valueSetRows[0]!.id;

    // ...then insert a MANUAL code (managed_by_descriptor = false) that a
    // later descriptor sync will collide with.
    await admin`
      INSERT INTO awcms_mini_reference_codes
        (value_set_id, code, provenance, managed_by_descriptor)
      VALUES (${valueSetId}, 'GAMMA', 'manual', false)
    `;

    const result = await sync(
      descriptorWith([
        { code: "ALPHA", labels: [{ locale: "en", label: "Alpha" }] },
        {
          code: "GAMMA",
          labels: [{ locale: "en", label: "Gamma from descriptor" }]
        }
      ])
    );

    expect(result.conflicts.length).toBe(1);
    expect(result.conflicts[0]).toContain("GAMMA");

    // The manual row is untouched: no descriptor-managed flag flip, no
    // translation written for it.
    const gammaRows = (await admin`
      SELECT c.managed_by_descriptor,
             (SELECT count(*) FROM awcms_mini_reference_code_translations t WHERE t.code_id = c.id) AS translation_count
      FROM awcms_mini_reference_codes c
      JOIN awcms_mini_reference_value_sets vs ON vs.id = c.value_set_id
      WHERE vs.key = ${VALUE_SET_KEY} AND c.code = 'GAMMA'
    `) as { managed_by_descriptor: boolean; translation_count: number }[];
    expect(gammaRows[0]!.managed_by_descriptor).toBe(false);
    expect(Number(gammaRows[0]!.translation_count)).toBe(0);
  });
});
