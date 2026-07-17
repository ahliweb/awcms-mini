/**
 * Integration tests for the BATCHED SoD-exception lookup (Issue #833, epic
 * #818) against a real PostgreSQL.
 *
 * `business-scope-assignment-service.ts` used to call
 * `findValidSoDConflictException` once PER DETECTED MATCH — an N+1 round
 * trip inside the assignment transaction. #833 collapsed that into one
 * `rule_key = ANY(...)` query, and re-pointed the single-key function at
 * the same statement so the two paths cannot drift.
 *
 * These need a real database, not a mock: the whole risk of this change is
 * in SQL that TYPECHECKS FINE and only fails at runtime — a plain
 * `${array}::text[]` interpolation raises `malformed array literal` against
 * a live server (hence `tx.array(values, "text")`), and the "status is a
 * cache, effective_to vs now() is the real gate" rule is only meaningful
 * against real rows. A unit test with a fake `tx` would have proven none
 * of it.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  getAdminSql,
  getTestSql,
  integrationEnabled,
  provisionAppRole,
  resetDatabase
} from "./harness";

import { withTenant } from "../../src/lib/database/tenant-context";
import {
  findValidSoDConflictException,
  findValidSoDConflictExceptionsByRuleKeys
} from "../../src/modules/identity-access/application/sod-exception-service";

const TENANT_ID = "aa833aaa-0000-4000-8000-000000000001";
const SUBJECT_ID = "aa833aaa-0000-4000-8000-000000000002";
const REQUESTER_ID = "aa833aaa-0000-4000-8000-000000000003";
const APPROVER_ID = "aa833aaa-0000-4000-8000-000000000004";
const SCOPE_ID = "aa833aaa-0000-4000-8000-0000000000a1";
const OTHER_SCOPE_ID = "aa833aaa-0000-4000-8000-0000000000a2";

const NOW = new Date("2026-07-17T12:00:00.000Z");
const REQUESTED_SCOPE = {
  scopeType: "organization_unit",
  scopeId: SCOPE_ID
};

async function seedTenantUser(id: string, name: string): Promise<void> {
  const admin = getAdminSql();
  const profileRows = (await admin`
    INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
    VALUES (${TENANT_ID}, 'person', ${name})
    RETURNING id
  `) as { id: string }[];
  const identityRows = (await admin`
    INSERT INTO awcms_mini_identities
      (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${TENANT_ID}, ${profileRows[0]!.id}, ${`${name}@example.com`}, 'x')
    RETURNING id
  `) as { id: string }[];
  await admin`
    INSERT INTO awcms_mini_tenant_users (id, tenant_id, identity_id)
    VALUES (${id}, ${TENANT_ID}, ${identityRows[0]!.id})
  `;
}

async function seedException(input: {
  ruleKey: string;
  status: string;
  effectiveFrom: Date;
  effectiveTo: Date;
  scopeType: string | null;
  scopeId: string | null;
}): Promise<void> {
  await getAdminSql()`
    INSERT INTO awcms_mini_sod_conflict_exceptions
      (tenant_id, rule_key, subject_tenant_user_id, scope_type, scope_id,
       justification, requested_by_tenant_user_id, approved_by_tenant_user_id,
       status, effective_from, effective_to)
    VALUES (
      ${TENANT_ID}, ${input.ruleKey}, ${SUBJECT_ID}, ${input.scopeType},
      ${input.scopeId}, 'Seeded for the #833 batch-lookup test.',
      ${REQUESTER_ID}, ${APPROVER_ID}, ${input.status},
      ${input.effectiveFrom}, ${input.effectiveTo}
    )
  `;
}

const IN_FORCE = {
  effectiveFrom: new Date("2026-07-01T00:00:00.000Z"),
  effectiveTo: new Date("2026-08-01T00:00:00.000Z")
};
const ALREADY_ELAPSED = {
  effectiveFrom: new Date("2026-06-01T00:00:00.000Z"),
  effectiveTo: new Date("2026-07-01T00:00:00.000Z")
};

function batchLookup(ruleKeys: readonly string[]) {
  return withTenant(getTestSql(), TENANT_ID, (tx) =>
    findValidSoDConflictExceptionsByRuleKeys(
      tx,
      TENANT_ID,
      ruleKeys,
      SUBJECT_ID,
      NOW,
      REQUESTED_SCOPE
    )
  );
}

describe.skipIf(!integrationEnabled)(
  "batched SoD exception lookup (Issue #833)",
  () => {
    beforeAll(async () => {
      await applyMigrations();
      await provisionAppRole();
    });

    beforeEach(async () => {
      await resetDatabase();
      await getAdminSql()`
        INSERT INTO awcms_mini_tenants (id, tenant_code, tenant_name)
        VALUES (${TENANT_ID}, 'a833', 'Issue 833')
      `;
      await seedTenantUser(SUBJECT_ID, "subject");
      await seedTenantUser(REQUESTER_ID, "requester");
      await seedTenantUser(APPROVER_ID, "approver");
    });

    test("resolves many rule keys in ONE query, each to its own valid exception", async () => {
      await seedException({
        ruleKey: "identity_access.rule_one",
        status: "approved",
        scopeType: REQUESTED_SCOPE.scopeType,
        scopeId: REQUESTED_SCOPE.scopeId,
        ...IN_FORCE
      });
      await seedException({
        ruleKey: "data_lifecycle.rule_two",
        status: "approved",
        scopeType: null,
        scopeId: null,
        ...IN_FORCE
      });

      // Includes a duplicate and a key with no exception at all — the real
      // caller passes one entry per detected match, not a clean set.
      const found = await batchLookup([
        "identity_access.rule_one",
        "data_lifecycle.rule_two",
        "identity_access.rule_one",
        "test_module.rule_absent"
      ]);

      expect(found.get("identity_access.rule_one")?.ruleKey).toBe(
        "identity_access.rule_one"
      );
      expect(found.get("data_lifecycle.rule_two")?.ruleKey).toBe(
        "data_lifecycle.rule_two"
      );
      // Absent key means "no valid exception" — the caller must default-deny
      // exactly as it did on the old `null` return.
      expect(found.has("test_module.rule_absent")).toBe(false);
      expect(found.size).toBe(2);
    });

    test("an empty rule-key list resolves to an empty map without querying", async () => {
      expect((await batchLookup([])).size).toBe(0);
    });

    test("an approved-but-elapsed exception is NOT valid, even before the expiry job flips its status", async () => {
      await seedException({
        ruleKey: "identity_access.rule_one",
        status: "approved",
        scopeType: REQUESTED_SCOPE.scopeType,
        scopeId: REQUESTED_SCOPE.scopeId,
        ...ALREADY_ELAPSED
      });

      const found = await batchLookup(["identity_access.rule_one"]);
      expect(found.has("identity_access.rule_one")).toBe(false);
    });

    test("a not-yet-approved exception is NOT valid", async () => {
      await seedException({
        ruleKey: "identity_access.rule_one",
        status: "pending",
        scopeType: REQUESTED_SCOPE.scopeType,
        scopeId: REQUESTED_SCOPE.scopeId,
        ...IN_FORCE
      });

      const found = await batchLookup(["identity_access.rule_one"]);
      expect(found.has("identity_access.rule_one")).toBe(false);
    });

    test("an exception for a DIFFERENT scope does not cover the requested scope", async () => {
      await seedException({
        ruleKey: "identity_access.rule_one",
        status: "approved",
        scopeType: "organization_unit",
        scopeId: OTHER_SCOPE_ID,
        ...IN_FORCE
      });

      const found = await batchLookup(["identity_access.rule_one"]);
      expect(found.has("identity_access.rule_one")).toBe(false);
    });

    test("a valid exception still wins when an elapsed one shares the rule key", async () => {
      // Row order is unspecified without ORDER BY; the lookup must pick the
      // VALID row regardless of which one Postgres hands back first.
      await seedException({
        ruleKey: "identity_access.rule_one",
        status: "approved",
        scopeType: REQUESTED_SCOPE.scopeType,
        scopeId: REQUESTED_SCOPE.scopeId,
        ...ALREADY_ELAPSED
      });
      await seedException({
        ruleKey: "identity_access.rule_one",
        status: "approved",
        scopeType: REQUESTED_SCOPE.scopeType,
        scopeId: REQUESTED_SCOPE.scopeId,
        ...IN_FORCE
      });

      const found = await batchLookup(["identity_access.rule_one"]);
      expect(found.get("identity_access.rule_one")?.effectiveTo).toEqual(
        IN_FORCE.effectiveTo
      );
    });

    test("the single-key function agrees with the batch it now delegates to", async () => {
      await seedException({
        ruleKey: "identity_access.rule_one",
        status: "approved",
        scopeType: REQUESTED_SCOPE.scopeType,
        scopeId: REQUESTED_SCOPE.scopeId,
        ...IN_FORCE
      });
      await seedException({
        ruleKey: "data_lifecycle.rule_two",
        status: "approved",
        scopeType: REQUESTED_SCOPE.scopeType,
        scopeId: REQUESTED_SCOPE.scopeId,
        ...ALREADY_ELAPSED
      });

      const ruleKeys = [
        "identity_access.rule_one",
        "data_lifecycle.rule_two",
        "test_module.rule_absent"
      ];
      const batch = await batchLookup(ruleKeys);

      for (const ruleKey of ruleKeys) {
        const single = await withTenant(getTestSql(), TENANT_ID, (tx) =>
          findValidSoDConflictException(
            tx,
            TENANT_ID,
            ruleKey,
            SUBJECT_ID,
            NOW,
            REQUESTED_SCOPE
          )
        );

        expect(single?.id ?? null).toBe(batch.get(ruleKey)?.id ?? null);
      }
    });

    test("another SUBJECT's approved exception never covers this subject", async () => {
      // Not redundant with RLS: RLS scopes rows to the TENANT, nothing
      // more. If the `subject_tenant_user_id` predicate were ever dropped,
      // any colleague's approved exception would silently clear this
      // subject's conflict — the query itself is the only thing enforcing
      // this.
      await getAdminSql()`
        INSERT INTO awcms_mini_sod_conflict_exceptions
          (tenant_id, rule_key, subject_tenant_user_id, scope_type, scope_id,
           justification, requested_by_tenant_user_id, approved_by_tenant_user_id,
           status, effective_from, effective_to)
        VALUES (
          ${TENANT_ID}, 'identity_access.rule_one', ${REQUESTER_ID},
          ${REQUESTED_SCOPE.scopeType}, ${REQUESTED_SCOPE.scopeId},
          'Approved for a DIFFERENT subject.', ${REQUESTER_ID}, ${APPROVER_ID},
          'approved', ${IN_FORCE.effectiveFrom}, ${IN_FORCE.effectiveTo}
        )
      `;

      const found = await batchLookup(["identity_access.rule_one"]);
      expect(found.has("identity_access.rule_one")).toBe(false);
    });

    test("the query filters by tenant ITSELF, not only through RLS", async () => {
      await seedException({
        ruleKey: "identity_access.rule_one",
        status: "approved",
        scopeType: REQUESTED_SCOPE.scopeType,
        scopeId: REQUESTED_SCOPE.scopeId,
        ...IN_FORCE
      });

      // `getAdminSql()` is the superuser connection — RLS does NOT apply to
      // it. Asking for another tenant's exceptions here therefore probes
      // the statement's OWN `tenant_id` predicate, the defense-in-depth
      // layer an RLS-only test can never see (`business-scope-assignment-
      // service.ts` makes the same argument for its own explicit tenant
      // lookups).
      const found = await findValidSoDConflictExceptionsByRuleKeys(
        getAdminSql(),
        "bb833bbb-0000-4000-8000-000000000009",
        ["identity_access.rule_one"],
        SUBJECT_ID,
        NOW,
        REQUESTED_SCOPE
      );

      expect(found.size).toBe(0);
    });

    test("RLS still isolates another tenant's exception rows", async () => {
      const otherTenantId = "bb833bbb-0000-4000-8000-000000000001";
      await getAdminSql()`
        INSERT INTO awcms_mini_tenants (id, tenant_code, tenant_name)
        VALUES (${otherTenantId}, 'b833', 'Other tenant')
      `;
      await seedException({
        ruleKey: "identity_access.rule_one",
        status: "approved",
        scopeType: REQUESTED_SCOPE.scopeType,
        scopeId: REQUESTED_SCOPE.scopeId,
        ...IN_FORCE
      });

      // Same rule key + same subject id, read under the OTHER tenant's
      // context: the `= ANY(...)` rewrite must not have widened the tenant
      // predicate.
      const found = await withTenant(getTestSql(), otherTenantId, (tx) =>
        findValidSoDConflictExceptionsByRuleKeys(
          tx,
          otherTenantId,
          ["identity_access.rule_one"],
          SUBJECT_ID,
          NOW,
          REQUESTED_SCOPE
        )
      );

      expect(found.size).toBe(0);
    });
  }
);
