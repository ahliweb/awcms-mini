/**
 * Unit test for `explainQuery`'s tenantId validation (Issue #744, epic
 * #738) — security-auditor finding on PR #775: `explainQuery` interpolated
 * `tenantId` into `SET LOCAL app.current_tenant_id = '...'` with no
 * shape-validation, unlike `tenant-context.ts`'s `withTenant`, which calls
 * `assertUuid` first for the identical interpolation. This proves
 * `explainQuery` rejects a malformed tenantId BEFORE ever touching the
 * database connection passed in (a stub is enough — if `assertUuid`
 * didn't run first, this stub would throw a much less clear error trying
 * to call `.begin` on it).
 */
import { describe, expect, test } from "bun:test";

import {
  explainQuery,
  QUERY_PLAN_QUERIES
} from "../../src/lib/performance/query-plan-runner";

describe("explainQuery — tenantId validation", () => {
  test("rejects a non-UUID-shaped tenantId before ever using the database connection", async () => {
    const neverCalledSql = {
      begin: () => {
        throw new Error(
          "explainQuery should have rejected the malformed tenantId " +
            "before ever calling sql.begin(...)."
        );
      }
    } as unknown as Bun.SQL;

    await expect(
      explainQuery(neverCalledSql, "not-a-uuid", QUERY_PLAN_QUERIES[0]!)
    ).rejects.toBeInstanceOf(Error);
  });

  test("rejects a SQL-injection-shaped tenantId the same way (defense in depth, mirrors withTenant's own guard)", async () => {
    const neverCalledSql = {
      begin: () => {
        throw new Error("must not reach sql.begin(...)");
      }
    } as unknown as Bun.SQL;

    await expect(
      explainQuery(
        neverCalledSql,
        "'; DROP TABLE awcms_mini_audit_events; --",
        QUERY_PLAN_QUERIES[0]!
      )
    ).rejects.toBeInstanceOf(Error);
  });
});
