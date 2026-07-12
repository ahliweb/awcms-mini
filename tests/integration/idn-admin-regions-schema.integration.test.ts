/**
 * Integration tests for the `idn_admin_regions` module's versioned schema
 * (Issue #657, epic #654 — master data wilayah administratif Indonesia,
 * `sql/054`) against a real PostgreSQL. Schema-only issue — no import
 * pipeline (#660), activation/rollback (#661), or lookup API (#662) exists
 * yet, so every query here goes through `getAdminSql()` (the migration
 * owner connection), the same pattern
 * `module-management-schema.integration.test.ts` used before Issue #513
 * gave that registry its first real service — see `sql/054`'s header for
 * why `awcms_mini_app` deliberately has zero grants on these two tables as
 * of this issue.
 *
 * These tables are GLOBAL reference data, not tenant-scoped (deliberate —
 * see `sql/054`'s header and `src/modules/idn-admin-regions/README.md`), so
 * unlike most `*-schema.integration.test.ts` files in this directory there
 * is no RLS-isolation test here. Instead this asserts the ABSENCE of
 * tenant_id/RLS and exercises the real constraints the issue's acceptance
 * criteria calls out: unique `(dataset_id, code)`, the parent-lookup index,
 * the normalized_name search index, and the single-active-dataset
 * constraint.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  getAdminSql,
  integrationEnabled,
  resetDatabase
} from "./harness";

// Copied verbatim from data/idn-admin-regions/manifest.json (Issue #656) —
// proves this schema can actually hold the exact real upstream provenance
// values that a future #660 import would write, not placeholder-shaped
// stand-ins. See src/modules/idn-admin-regions/domain/source-provenance.ts
// for the repository/path/license as trusted code constants.
const REAL_SOURCE_REPOSITORY = "https://github.com/cahyadsn/wilayah";
const REAL_SOURCE_PATH = "https://github.com/cahyadsn/wilayah/tree/master/db";
const REAL_SOURCE_COMMIT_SHA = "cae306278e5be616c83ba2d8096b00767f45b5fe";
const REAL_SOURCE_LICENSE = "MIT";
const REAL_SOURCE_FILE_SHA256 =
  "c4c3396d9380d4edee072af1d9dff83573b574d7cd00a6562cf82e200e954031";

async function insertDataset(
  overrides: Partial<{
    datasetCode: string;
    status: string;
    rowCount: number;
  }> = {}
): Promise<string> {
  const admin = getAdminSql();
  const datasetCode = overrides.datasetCode ?? "idn_admin_regions_2026_07";
  const status = overrides.status ?? "validated";
  const rowCount = overrides.rowCount ?? 91000;

  const rows = (await admin`
    INSERT INTO awcms_mini_idn_region_datasets
      (dataset_code, source_repository, source_path, source_commit_sha,
       source_license, source_file_sha256, row_count, status)
    VALUES
      (${datasetCode}, ${REAL_SOURCE_REPOSITORY}, ${REAL_SOURCE_PATH},
       ${REAL_SOURCE_COMMIT_SHA}, ${REAL_SOURCE_LICENSE},
       ${REAL_SOURCE_FILE_SHA256}, ${rowCount}, ${status})
    RETURNING id
  `) as { id: string }[];

  return rows[0]!.id;
}

const suite = integrationEnabled ? describe : describe.skip;

suite(
  "idn_admin_regions schema (Issue #657, epic #654) — real Postgres",
  () => {
    beforeAll(async () => {
      await applyMigrations();
    });

    beforeEach(async () => {
      await resetDatabase();
    });

    test("awcms_mini_idn_region_datasets has no tenant_id column and RLS is not enabled (global reference data)", async () => {
      const admin = getAdminSql();

      const columns = (await admin`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'awcms_mini_idn_region_datasets' AND column_name = 'tenant_id'
    `) as { column_name: string }[];
      expect(columns).toHaveLength(0);

      const relRows = (await admin`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE relname = 'awcms_mini_idn_region_datasets'
    `) as { relrowsecurity: boolean; relforcerowsecurity: boolean }[];
      expect(relRows[0]!.relrowsecurity).toBe(false);
      expect(relRows[0]!.relforcerowsecurity).toBe(false);
    });

    test("awcms_mini_idn_admin_regions has no tenant_id column and RLS is not enabled (global reference data)", async () => {
      const admin = getAdminSql();

      const columns = (await admin`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'awcms_mini_idn_admin_regions' AND column_name = 'tenant_id'
    `) as { column_name: string }[];
      expect(columns).toHaveLength(0);

      const relRows = (await admin`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE relname = 'awcms_mini_idn_admin_regions'
    `) as { relrowsecurity: boolean; relforcerowsecurity: boolean }[];
      expect(relRows[0]!.relrowsecurity).toBe(false);
      expect(relRows[0]!.relforcerowsecurity).toBe(false);
    });

    test("dataset metadata holds the real upstream provenance (repository, source path, commit SHA, license)", async () => {
      const admin = getAdminSql();
      const datasetId = await insertDataset();

      const rows = (await admin`
      SELECT source_repository, source_path, source_commit_sha, source_license,
             source_file_sha256, source_type, row_count, status
      FROM awcms_mini_idn_region_datasets WHERE id = ${datasetId}
    `) as {
        source_repository: string;
        source_path: string;
        source_commit_sha: string;
        source_license: string;
        source_file_sha256: string;
        source_type: string;
        row_count: number;
        status: string;
      }[];

      expect(rows).toHaveLength(1);
      expect(rows[0]!.source_repository).toBe(REAL_SOURCE_REPOSITORY);
      expect(rows[0]!.source_path).toBe(REAL_SOURCE_PATH);
      expect(rows[0]!.source_commit_sha).toBe(REAL_SOURCE_COMMIT_SHA);
      expect(rows[0]!.source_license).toBe(REAL_SOURCE_LICENSE);
      expect(rows[0]!.source_file_sha256).toBe(REAL_SOURCE_FILE_SHA256);
      // Default applies when not explicitly supplied at insert time.
      expect(rows[0]!.source_type).toBe("third_party_github_repository");
      expect(rows[0]!.status).toBe("validated");
    });

    test("dataset_code is unique", async () => {
      await insertDataset({ datasetCode: "dup_dataset" });

      let didThrow = false;
      try {
        await insertDataset({ datasetCode: "dup_dataset" });
      } catch {
        didThrow = true;
      }
      expect(didThrow).toBe(true);
    });

    test("only one dataset can be active at a time", async () => {
      const admin = getAdminSql();
      const firstId = await insertDataset({
        datasetCode: "dataset_a",
        status: "active"
      });

      // A second dataset trying to become active concurrently must be
      // rejected by the partial unique index on (status) WHERE status='active'.
      let didThrow = false;
      try {
        await insertDataset({ datasetCode: "dataset_b", status: "active" });
      } catch {
        didThrow = true;
      }
      expect(didThrow).toBe(true);

      // A second dataset with a non-active status is fine.
      const secondId = await insertDataset({
        datasetCode: "dataset_c",
        status: "validated"
      });
      expect(secondId).not.toBe(firstId);

      // Rolling the first dataset back to a non-active status frees the slot
      // up for another dataset to become active.
      await admin`
      UPDATE awcms_mini_idn_region_datasets SET status = 'superseded'
      WHERE id = ${firstId}
    `;
      const thirdId = await insertDataset({
        datasetCode: "dataset_d",
        status: "active"
      });
      expect(thirdId).not.toBe(firstId);
    });

    test("status rejects an unknown lifecycle value", async () => {
      let didThrow = false;
      try {
        await insertDataset({ datasetCode: "bogus_status", status: "bogus" });
      } catch {
        didThrow = true;
      }
      expect(didThrow).toBe(true);
    });

    test("unique index exists on (dataset_id, code) and rejects a duplicate code within the same dataset", async () => {
      const admin = getAdminSql();
      const datasetId = await insertDataset();

      await admin`
      INSERT INTO awcms_mini_idn_admin_regions
        (dataset_id, code, level, region_type, official_name, normalized_name, source_row_hash)
      VALUES
        (${datasetId}, '11', 1, 'province', 'ACEH', 'aceh', 'hash-11')
    `;

      let didThrow = false;
      try {
        await admin`
        INSERT INTO awcms_mini_idn_admin_regions
          (dataset_id, code, level, region_type, official_name, normalized_name, source_row_hash)
        VALUES
          (${datasetId}, '11', 1, 'province', 'ACEH DUPLICATE', 'aceh duplicate', 'hash-11-dup')
      `;
      } catch {
        didThrow = true;
      }
      expect(didThrow).toBe(true);

      // The same code IS allowed again under a different dataset (a new
      // dataset version re-imports the full hierarchy from scratch).
      const otherDatasetId = await insertDataset({
        datasetCode: "other_dataset"
      });
      const rows = await admin`
      INSERT INTO awcms_mini_idn_admin_regions
        (dataset_id, code, level, region_type, official_name, normalized_name, source_row_hash)
      VALUES
        (${otherDatasetId}, '11', 1, 'province', 'ACEH', 'aceh', 'hash-11')
      RETURNING id
    `;
      expect(rows).toHaveLength(1);
    });

    test("parent lookup index exists on (dataset_id, parent_code) and supports child lookup", async () => {
      const admin = getAdminSql();
      const datasetId = await insertDataset();

      const indexRows = (await admin`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'awcms_mini_idn_admin_regions'
        AND indexdef ILIKE '%(dataset_id, parent_code)%'
    `) as { indexdef: string }[];
      expect(indexRows.length).toBeGreaterThan(0);

      await admin`
      INSERT INTO awcms_mini_idn_admin_regions
        (dataset_id, code, parent_code, level, region_type, official_name, normalized_name, source_row_hash)
      VALUES
        (${datasetId}, '11', NULL, 1, 'province', 'ACEH', 'aceh', 'hash-11'),
        (${datasetId}, '11.01', '11', 2, 'regency', 'KABUPATEN ACEH SELATAN', 'kabupaten aceh selatan', 'hash-11-01'),
        (${datasetId}, '11.02', '11', 2, 'regency', 'KABUPATEN ACEH TENGGARA', 'kabupaten aceh tenggara', 'hash-11-02')
    `;

      const children = (await admin`
      SELECT code FROM awcms_mini_idn_admin_regions
      WHERE dataset_id = ${datasetId} AND parent_code = '11'
      ORDER BY code
    `) as { code: string }[];
      expect(children.map((row) => row.code)).toEqual(["11.01", "11.02"]);
    });

    test("search index exists for normalized_name", async () => {
      const admin = getAdminSql();

      const indexRows = (await admin`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'awcms_mini_idn_admin_regions'
        AND indexdef ILIKE '%normalized_name%'
    `) as { indexdef: string }[];
      expect(indexRows.length).toBeGreaterThan(0);
    });

    test("level rejects a value outside 1..4 and region_type rejects an unknown value", async () => {
      const admin = getAdminSql();
      const datasetId = await insertDataset();

      let didThrowLevel = false;
      try {
        await admin`
        INSERT INTO awcms_mini_idn_admin_regions
          (dataset_id, code, level, region_type, official_name, normalized_name, source_row_hash)
        VALUES
          (${datasetId}, '99', 5, 'province', 'BOGUS', 'bogus', 'hash-99')
      `;
      } catch {
        didThrowLevel = true;
      }
      expect(didThrowLevel).toBe(true);

      let didThrowType = false;
      try {
        await admin`
        INSERT INTO awcms_mini_idn_admin_regions
          (dataset_id, code, level, region_type, official_name, normalized_name, source_row_hash)
        VALUES
          (${datasetId}, '98', 1, 'kelurahan_bogus', 'BOGUS', 'bogus', 'hash-98')
      `;
      } catch {
        didThrowType = true;
      }
      expect(didThrowType).toBe(true);
    });

    test("awcms_mini_app has zero grants on either table (least privilege, no runtime code path yet)", async () => {
      const admin = getAdminSql();

      const rows = (await admin`
      SELECT c.relname AS table_name, p.privilege_type AS privilege
      FROM pg_class c
      CROSS JOIN LATERAL aclexplode(c.relacl) AS p
      JOIN pg_roles a ON a.oid = p.grantee
      WHERE c.relname IN ('awcms_mini_idn_region_datasets', 'awcms_mini_idn_admin_regions')
        AND a.rolname = 'awcms_mini_app'
    `) as { table_name: string; privilege: string }[];

      expect(rows).toHaveLength(0);
    });
  }
);
