/**
 * Support-access grants — PostgreSQL integration (Issue #879, ADR-0022 §5/§6,
 * FIX MEDIUM-5). Proves the AC "support access expires automatically and cannot
 * be reused for another tenant", plus approval-by-distinct-actor, revocation,
 * and fail-closed expiry — against real RLS and the real trigger state machine.
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
  approveSupportAccess,
  hasActiveSupportGrant,
  requestSupportAccess,
  revokeSupportAccess
} from "../../src/modules/identity-access/application/support-access";

const describeIf = integrationEnabled ? describe : describe.skip;

let tenantSeq = 0;

/** Create a minimal target tenant directly (admin) and return its id. */
async function createTenant(label: string): Promise<string> {
  tenantSeq += 1;
  const admin = getAdminSql();
  const rows = (await admin`
    INSERT INTO awcms_mini_tenants (tenant_code, tenant_name)
    VALUES (${`sa-${label}-${tenantSeq}`}, ${`SA ${label}`})
    RETURNING id
  `) as { id: string }[];
  return rows[0]!.id;
}

/** Create a global identity (needs a tenant + profile) and return its id. */
async function createOperatorIdentity(tenantId: string): Promise<string> {
  tenantSeq += 1;
  const admin = getAdminSql();
  const profile = (await admin`
    INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
    VALUES (${tenantId}, ${"person"}, ${"Operator"})
    RETURNING id
  `) as { id: string }[];
  const identity = (await admin`
    INSERT INTO awcms_mini_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${tenantId}, ${profile[0]!.id}, ${`op-${tenantSeq}@example.com`}, ${"x"})
    RETURNING id
  `) as { id: string }[];
  return identity[0]!.id;
}

describeIf("support-access grants (integration)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });
  beforeEach(async () => {
    await resetDatabase();
  });

  test("approved grant is active; expiry and revocation both fail closed; a grant for tenant A is invisible/inactive for tenant B", async () => {
    const sql = getTestSql();
    const tenantA = await createTenant("a");
    const tenantB = await createTenant("b");
    const operatorId = await createOperatorIdentity(tenantA);
    const requester = crypto.randomUUID();
    const approver = crypto.randomUUID();
    const now = new Date();

    // MAKER: request in tenant A's context.
    const grantId = await withTenant(sql, tenantA, async (tx) => {
      const res = await requestSupportAccess(tx, tenantA, {
        operatorIdentityId: operatorId,
        reason: "investigate ticket #42",
        requestedBy: requester
      });
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error("request failed");
      // Not yet active — only requested.
      expect(await hasActiveSupportGrant(tx, tenantA, operatorId, now)).toBe(
        false
      );
      return res.grantId;
    });

    // A second live request for the same operator is a clean conflict.
    await withTenant(sql, tenantA, async (tx) => {
      const dup = await requestSupportAccess(tx, tenantA, {
        operatorIdentityId: operatorId,
        reason: "again",
        requestedBy: requester
      });
      expect(dup.ok).toBe(false);
    });

    // CHECKER: approve (distinct actor), 1h window.
    await withTenant(sql, tenantA, async (tx) => {
      const res = await approveSupportAccess(tx, tenantA, grantId, {
        approverTenantUserId: approver,
        ttlSeconds: 3600,
        now
      });
      expect(res.ok).toBe(true);
    });

    // Now ACTIVE in tenant A.
    await withTenant(sql, tenantA, async (tx) => {
      expect(await hasActiveSupportGrant(tx, tenantA, operatorId, now)).toBe(
        true
      );
    });

    // EXPIRY fail-closed: evaluated at a time beyond the window -> inactive.
    await withTenant(sql, tenantA, async (tx) => {
      const later = new Date(now.getTime() + 3601 * 1000);
      expect(await hasActiveSupportGrant(tx, tenantA, operatorId, later)).toBe(
        false
      );
    });

    // CROSS-TENANT: the grant is scoped to tenant A. In tenant B's RLS context
    // it is invisible AND inactive — never reusable for another tenant.
    await withTenant(sql, tenantB, async (tx) => {
      const visible = (await tx`
        SELECT id FROM awcms_mini_control_plane_support_access_grants
        WHERE operator_identity_id = ${operatorId}
      `) as { id: string }[];
      expect(visible).toHaveLength(0);
      expect(await hasActiveSupportGrant(tx, tenantB, operatorId, now)).toBe(
        false
      );
    });

    // REVOKE -> immediately inactive in tenant A.
    await withTenant(sql, tenantA, async (tx) => {
      const res = await revokeSupportAccess(tx, tenantA, grantId, {
        revokerTenantUserId: approver
      });
      expect(res.ok).toBe(true);
      expect(await hasActiveSupportGrant(tx, tenantA, operatorId, now)).toBe(
        false
      );
    });
  });

  test("the trigger rejects an illegal transition (revoked is terminal)", async () => {
    const sql = getTestSql();
    const tenantA = await createTenant("t");
    const operatorId = await createOperatorIdentity(tenantA);
    const now = new Date();

    const grantId = await withTenant(sql, tenantA, async (tx) => {
      const req = await requestSupportAccess(tx, tenantA, {
        operatorIdentityId: operatorId,
        reason: "x",
        requestedBy: crypto.randomUUID()
      });
      if (!req.ok) throw new Error("req");
      await approveSupportAccess(tx, tenantA, req.grantId, {
        approverTenantUserId: crypto.randomUUID(),
        ttlSeconds: 60,
        now
      });
      await revokeSupportAccess(tx, tenantA, req.grantId, {
        revokerTenantUserId: crypto.randomUUID()
      });
      return req.grantId;
    });

    // A raw re-approve of a revoked (terminal) grant must be rejected by the trigger.
    await withTenant(sql, tenantA, async (tx) => {
      let threw = false;
      try {
        await tx`
          UPDATE awcms_mini_control_plane_support_access_grants
          SET status = 'approved'
          WHERE tenant_id = ${tenantA} AND id = ${grantId}
        `;
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    });
  });
});
