/**
 * Integration tests for the dynamic ABAC policy evaluator (Issue #179),
 * against a REAL PostgreSQL and the REAL least-privilege `awcms_mini_app` role
 * (so FORCE'd RLS is actually enforced, exactly like production). They hit the
 * real route handlers:
 *   - POST /api/v1/access/policies            (authoring; only valid DSL)
 *   - POST /api/v1/access/policies/{id}/enable | /disable
 *   - POST /api/v1/access/policies/simulate   (read-only preview, audited)
 *   - POST /api/v1/access/evaluate            (consumes active policies)
 *
 * Proves: create → enable → evaluate changes the decision; explicit deny
 * overrides an RBAC allow; a tenant A policy does NOT affect tenant B (under
 * the non-superuser app role); cache invalidation without restart; and the
 * decision log records policy/version/reason with no raw PII.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  createCookieJar,
  getAdminSql,
  integrationEnabled,
  invoke,
  provisionAppRole,
  resetDatabase
} from "./harness";
import { getDatabaseClient } from "../../src/lib/database/client";
import { withTenant } from "../../src/lib/database/tenant-context";
import { loadActivePolicies } from "../../src/modules/identity-access/application/policy-cache";

import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import { POST as accessEvaluate } from "../../src/pages/api/v1/access/evaluate";
import { POST as createPolicy } from "../../src/pages/api/v1/access/policies/index";
import { POST as enablePolicy } from "../../src/pages/api/v1/access/policies/[id]/enable";
import { POST as disablePolicy } from "../../src/pages/api/v1/access/policies/[id]/disable";
import { POST as simulatePolicy } from "../../src/pages/api/v1/access/policies/simulate";
import { resetPolicyCache } from "../../src/modules/identity-access/application/policy-cache";

const OWNER_PASSWORD = "integration-test-owner-password";

type Bootstrap = { tenantId: string; token: string };

async function bootstrap(tenantCode: string): Promise<Bootstrap> {
  const loginIdentifier = `${tenantCode}-owner@example.com`;
  const setup = await invoke<{ data: { tenantId: string } }>(setupInitialize, {
    method: "POST",
    path: "/api/v1/setup/initialize",
    headers: { "content-type": "application/json" },
    body: {
      tenantName: `Tenant ${tenantCode}`,
      tenantCode,
      officeCode: "hq",
      officeName: "HQ",
      ownerLoginIdentifier: loginIdentifier,
      ownerPassword: OWNER_PASSWORD,
      ownerDisplayName: "Owner"
    }
  });
  expect(setup.status).toBe(200);

  const login = await invoke<{ data: { token: string } }>(authLogin, {
    method: "POST",
    path: "/api/v1/auth/login",
    headers: {
      "content-type": "application/json",
      "x-awcms-mini-tenant-id": setup.body.data.tenantId
    },
    body: { loginIdentifier, password: OWNER_PASSWORD },
    cookies: createCookieJar()
  });
  expect(login.status).toBe(200);

  return { tenantId: setup.body.data.tenantId, token: login.body.data.token };
}

function headers(owner: Bootstrap): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-awcms-mini-tenant-id": owner.tenantId,
    authorization: `Bearer ${owner.token}`
  };
}

// A module/activity/action the setup-wizard owner holds via RBAC, used as the
// evaluation target throughout.
const TARGET = {
  moduleKey: "identity_access",
  activityCode: "access_control",
  action: "read"
};

async function evaluate(
  owner: Bootstrap,
  resourceAttributes?: Record<string, unknown>
) {
  return invoke<{ data: { allowed: boolean; matchedPolicy?: string } }>(
    accessEvaluate,
    {
      method: "POST",
      path: "/api/v1/access/evaluate",
      headers: headers(owner),
      body: { ...TARGET, resourceAttributes }
    }
  );
}

async function createAndReturnId(
  owner: Bootstrap,
  body: Record<string, unknown>
): Promise<{ status: number; id?: string }> {
  const res = await invoke<{ data: { policy: { id: string } } }>(createPolicy, {
    method: "POST",
    path: "/api/v1/access/policies",
    headers: headers(owner),
    body
  });
  return { status: res.status, id: res.body?.data?.policy?.id };
}

/**
 * Provisions a second user IN THE SAME TENANT holding ONLY
 * `identity_access.abac_policies.analyze` — deliberately NOT
 * `user_management.read`. Used to prove the simulation foreign-subject gate:
 * such a principal may simulate a hypothetical role set but must NOT be able to
 * resolve another existing tenant user's real grants (horizontal-read oracle).
 */
async function provisionAnalyzeOnlyUser(
  tenantId: string
): Promise<{ token: string; tenantUserId: string }> {
  const admin = getAdminSql();
  const password = "integration-analyze-only-password";
  const passwordHash = await Bun.password.hash(password);
  const loginIdentifier = `analyze-only-${tenantId.slice(0, 8)}@example.com`;
  let tenantUserId = "";

  await admin.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);
    const profile = (await tx`
      INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
      VALUES (${tenantId}, 'person', 'Analyze Only') RETURNING id
    `) as { id: string }[];
    const identity = (await tx`
      INSERT INTO awcms_mini_identities (tenant_id, profile_id, login_identifier, password_hash)
      VALUES (${tenantId}, ${profile[0]!.id}, ${loginIdentifier}, ${passwordHash})
      RETURNING id
    `) as { id: string }[];
    const tenantUser = (await tx`
      INSERT INTO awcms_mini_tenant_users (tenant_id, identity_id)
      VALUES (${tenantId}, ${identity[0]!.id}) RETURNING id
    `) as { id: string }[];
    tenantUserId = tenantUser[0]!.id;
    const role = (await tx`
      INSERT INTO awcms_mini_roles (tenant_id, role_code, role_name)
      VALUES (${tenantId}, 'abac_analyst', 'ABAC Analyst') RETURNING id
    `) as { id: string }[];
    const permissions = (await tx`
      SELECT id FROM awcms_mini_permissions
      WHERE module_key = 'identity_access'
        AND activity_code = 'abac_policies' AND action = 'analyze'
    `) as { id: string }[];
    for (const permission of permissions) {
      await tx`
        INSERT INTO awcms_mini_role_permissions (tenant_id, role_id, permission_id)
        VALUES (${tenantId}, ${role[0]!.id}, ${permission.id})
      `;
    }
    await tx`
      INSERT INTO awcms_mini_access_assignments (tenant_id, tenant_user_id, role_id)
      VALUES (${tenantId}, ${tenantUser[0]!.id}, ${role[0]!.id})
    `;
  });

  const login = await invoke<{ data: { token: string } }>(authLogin, {
    method: "POST",
    path: "/api/v1/auth/login",
    headers: {
      "content-type": "application/json",
      "x-awcms-mini-tenant-id": tenantId
    },
    body: { loginIdentifier, password },
    cookies: createCookieJar()
  });
  expect(login.status).toBe(200);
  return { token: login.body.data.token, tenantUserId };
}

const suite = integrationEnabled ? describe : describe.skip;

suite("ABAC dynamic policy evaluator (Issue #179)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
    resetPolicyCache();
  });

  test("create → enable → evaluate: an explicit deny overrides the RBAC allow, and disable restores it (cache invalidation, no restart)", async () => {
    const owner = await bootstrap("acme");

    // Baseline: owner holds access_control.read via RBAC → allowed.
    const before = await evaluate(owner);
    expect(before.status).toBe(200);
    expect(before.body.data.allowed).toBe(true);
    expect(before.body.data.matchedPolicy).toBe("role_permission");

    // Author a DENY policy applicable to exactly this action (empty condition
    // = always matches). Created disabled by default.
    const created = await createAndReturnId(owner, {
      policyCode: "deny-access-control-read",
      effect: "deny",
      moduleKey: TARGET.moduleKey,
      activityCode: TARGET.activityCode,
      action: TARGET.action,
      conditions: { allOf: [] }
    });
    expect(created.status).toBe(200);
    const policyId = created.id!;

    // Still allowed while the policy is inactive.
    const whileDisabled = await evaluate(owner);
    expect(whileDisabled.body.data.allowed).toBe(true);

    // Enable → deny takes effect on the very next request (cache invalidated).
    const enabled = await invoke(enablePolicy, {
      method: "POST",
      path: `/api/v1/access/policies/${policyId}/enable`,
      headers: headers(owner),
      params: { id: policyId }
    });
    expect(enabled.status).toBe(200);

    const afterEnable = await evaluate(owner);
    expect(afterEnable.body.data.allowed).toBe(false);
    expect(afterEnable.body.data.matchedPolicy).toBe(
      "deny-access-control-read"
    );

    // Disable → allowed again, no restart.
    const disabled = await invoke(disablePolicy, {
      method: "POST",
      path: `/api/v1/access/policies/${policyId}/disable`,
      headers: headers(owner),
      params: { id: policyId }
    });
    expect(disabled.status).toBe(200);

    const afterDisable = await evaluate(owner);
    expect(afterDisable.body.data.allowed).toBe(true);
  });

  test("a decision log row is written with policy code + version + reason and NO raw resource attributes / PII", async () => {
    const owner = await bootstrap("acme");
    const created = await createAndReturnId(owner, {
      policyCode: "deny-ac-read-logged",
      effect: "deny",
      moduleKey: TARGET.moduleKey,
      activityCode: TARGET.activityCode,
      action: TARGET.action,
      isActive: true,
      conditions: { allOf: [] }
    });
    expect(created.status).toBe(200);

    // Evaluate with a would-be-sensitive resource attribute present.
    const secret = "0000-secret-owner-1111";
    await evaluate(owner, { ownerTenantUserId: secret, status: "posted" });

    const admin = getAdminSql();
    const rows = (await admin`
      SELECT decision, reason, matched_policy, matched_policy_version, resource_id
      FROM awcms_mini_abac_decision_logs
      WHERE tenant_id = ${owner.tenantId}
        AND module_key = ${TARGET.moduleKey}
        AND activity_code = ${TARGET.activityCode}
        AND action = ${TARGET.action}
        AND decision = 'deny'
      ORDER BY created_at DESC
      LIMIT 1
    `) as {
      decision: string;
      reason: string;
      matched_policy: string;
      matched_policy_version: number;
      resource_id: string | null;
    }[];

    expect(rows.length).toBe(1);
    expect(rows[0]!.matched_policy).toBe("deny-ac-read-logged");
    expect(rows[0]!.matched_policy_version).toBe(1);
    expect(rows[0]!.reason).toBe("Denied by ABAC policy.");
    // The sensitive value never reaches the decision log.
    expect(JSON.stringify(rows[0])).not.toContain(secret);
  });

  test("cross-tenant isolation: tenant A's policy is invisible to tenant B's active-policy load under the non-superuser app role + FORCE'd RLS", async () => {
    // Tenant A is the setup-wizard tenant (the wizard is one-time), with an
    // active policy authored through the real API.
    const tenantA = await bootstrap("acme");
    const created = await createAndReturnId(tenantA, {
      policyCode: "deny-ac-read-a-only",
      effect: "deny",
      moduleKey: TARGET.moduleKey,
      activityCode: TARGET.activityCode,
      action: TARGET.action,
      isActive: true,
      conditions: { allOf: [] }
    });
    expect(created.status).toBe(200);

    // Tenant B + its OWN active policy, seeded directly (privileged role).
    const admin = getAdminSql();
    const tenantBRows = (await admin`
      INSERT INTO awcms_mini_tenants (tenant_code, tenant_name)
      VALUES ('globex', 'Globex')
      RETURNING id
    `) as { id: string }[];
    const tenantBId = tenantBRows[0]!.id;
    await admin`
      INSERT INTO awcms_mini_abac_policies
        (tenant_id, policy_code, effect, dsl_version, conditions, is_active, priority)
      VALUES (${tenantBId}, 'b-only-policy', 'deny', 1, ${{ allOf: [] }}, true, 100)
    `;

    // Load active policies for each tenant as the least-privilege app role
    // (provisionAppRole repointed the client), through FORCE'd RLS. The cache
    // is per-tenant and reset in beforeEach, so each load is a real DB read.
    const appSql = getDatabaseClient();
    const aPolicies = await withTenant(appSql, tenantA.tenantId, (tx) =>
      loadActivePolicies(tx, tenantA.tenantId)
    );
    const bPolicies = await withTenant(appSql, tenantBId, (tx) =>
      loadActivePolicies(tx, tenantBId)
    );

    expect(aPolicies.map((p) => p.policyCode)).toEqual(["deny-ac-read-a-only"]);
    // Tenant B sees ONLY its own policy — never tenant A's.
    expect(bPolicies.map((p) => p.policyCode)).toEqual(["b-only-policy"]);
  });

  test("an invalid DSL cannot be stored (and therefore never enabled)", async () => {
    const owner = await bootstrap("acme");
    const res = await invoke<{ error: { code: string } }>(createPolicy, {
      method: "POST",
      path: "/api/v1/access/policies",
      headers: headers(owner),
      body: {
        policyCode: "invalid-attr-policy",
        effect: "deny",
        conditions: { attr: "subject.evil", op: "eq", value: "x" }
      }
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  test("allow-policy ownership constraint: satisfied vs unsatisfied, evaluated end-to-end", async () => {
    const owner = await bootstrap("acme");
    // Resolve the owner's real tenant_user_id (subject.tenantUserId).
    const admin = getAdminSql();
    const ownerRows = (await admin`
      SELECT tu.id FROM awcms_mini_tenant_users tu
      JOIN awcms_mini_identities i ON i.id = tu.identity_id
      WHERE tu.tenant_id = ${owner.tenantId}
        AND i.login_identifier = 'acme-owner@example.com'
    `) as { id: string }[];
    const ownerTenantUserId = ownerRows[0]!.id;

    const created = await createAndReturnId(owner, {
      policyCode: "own-records-only",
      effect: "allow",
      moduleKey: TARGET.moduleKey,
      activityCode: TARGET.activityCode,
      action: TARGET.action,
      isActive: true,
      conditions: {
        attr: "resource.ownerTenantUserId",
        op: "eq",
        valueAttr: "subject.tenantUserId"
      }
    });
    expect(created.status).toBe(200);

    // Owns the resource → allowed by the constraint.
    const owns = await evaluate(owner, { ownerTenantUserId });
    expect(owns.body.data.allowed).toBe(true);
    expect(owns.body.data.matchedPolicy).toBe("own-records-only");

    // Someone else owns it → the allow-constraint is unsatisfied → deny.
    const notOwns = await evaluate(owner, {
      ownerTenantUserId: "99999999-9999-9999-9999-999999999999"
    });
    expect(notOwns.body.data.allowed).toBe(false);
    expect(notOwns.body.data.matchedPolicy).toBe("abac_allow_unsatisfied");
  });

  test("read-only simulation returns the decision + per-policy trace and writes an audit event (no decision-log mutation)", async () => {
    const owner = await bootstrap("acme");
    await createAndReturnId(owner, {
      policyCode: "deny-posted-invoices",
      effect: "deny",
      moduleKey: "sales",
      activityCode: "invoice",
      action: "update",
      isActive: true,
      conditions: { attr: "resource.status", op: "eq", value: "posted" }
    });

    const sim = await invoke<{
      data: {
        decision: { allowed: boolean; matchedPolicy?: string };
        evaluatedPolicies: {
          policyCode: string;
          applicable: boolean;
          conditionSatisfied: boolean | null;
        }[];
      };
    }>(simulatePolicy, {
      method: "POST",
      path: "/api/v1/access/policies/simulate",
      headers: headers(owner),
      body: {
        subject: { roles: ["owner"] },
        request: {
          moduleKey: "sales",
          activityCode: "invoice",
          action: "update",
          resourceAttributes: { status: "posted" }
        }
      }
    });
    expect(sim.status).toBe(200);
    expect(sim.body.data.decision.allowed).toBe(false);
    const trace = sim.body.data.evaluatedPolicies.find(
      (p) => p.policyCode === "deny-posted-invoices"
    );
    expect(trace?.applicable).toBe(true);
    expect(trace?.conditionSatisfied).toBe(true);

    const admin = getAdminSql();
    // Audit event recorded for the simulation.
    const audit = (await admin`
      SELECT 1 FROM awcms_mini_audit_events
      WHERE tenant_id = ${owner.tenantId} AND action = 'analyze'
        AND resource_type = 'abac_simulation'
    `) as unknown[];
    expect(audit.length).toBeGreaterThan(0);

    // Simulation must NOT create a real decision-log row for the hypothetical
    // sales/invoice/update request.
    const decisionLogs = (await admin`
      SELECT 1 FROM awcms_mini_abac_decision_logs
      WHERE tenant_id = ${owner.tenantId} AND module_key = 'sales'
    `) as unknown[];
    expect(decisionLogs.length).toBe(0);
  });

  test("foreign-subject simulation requires user_management.read: an analyze-only principal is refused, the owner is allowed and attributed in the audit", async () => {
    const owner = await bootstrap("gamma");
    const admin = getAdminSql();

    const ownerTenantUserId = (
      (await admin`
        SELECT tu.id FROM awcms_mini_tenant_users tu
        JOIN awcms_mini_identities i ON i.id = tu.identity_id
        WHERE tu.tenant_id = ${owner.tenantId}
          AND i.login_identifier = 'gamma-owner@example.com'
      `) as { id: string }[]
    )[0]!.id;

    const analyst = await provisionAnalyzeOnlyUser(owner.tenantId);
    const analystHeaders = {
      "content-type": "application/json",
      "x-awcms-mini-tenant-id": owner.tenantId,
      authorization: `Bearer ${analyst.token}`
    };
    const simRequest = {
      moduleKey: "identity_access",
      activityCode: "access_control",
      action: "read"
    };

    // A HYPOTHETICAL role set is a pure `analyze` capability → allowed.
    const byRole = await invoke(simulatePolicy, {
      method: "POST",
      path: "/api/v1/access/policies/simulate",
      headers: analystHeaders,
      body: { subject: { roles: ["owner"] }, request: simRequest }
    });
    expect(byRole.status).toBe(200);

    // A DIFFERENT existing tenant user resolves that user's real grants — an
    // enumeration oracle — so it needs user_management.read, which the analyst
    // lacks → 403 (the gate bites; without the fix this would 200 and leak).
    const foreign = await invoke(simulatePolicy, {
      method: "POST",
      path: "/api/v1/access/policies/simulate",
      headers: analystHeaders,
      body: {
        subject: { tenantUserId: ownerTenantUserId },
        request: simRequest
      }
    });
    expect(foreign.status).toBe(403);

    // Simulating one's OWN tenantUserId is never a horizontal read → allowed.
    const ownSubject = await invoke(simulatePolicy, {
      method: "POST",
      path: "/api/v1/access/policies/simulate",
      headers: analystHeaders,
      body: {
        subject: { tenantUserId: analyst.tenantUserId },
        request: simRequest
      }
    });
    expect(ownSubject.status).toBe(200);

    // The owner DOES hold user_management.read → foreign subject allowed, and
    // the probed subject id is recorded in the audit event for attribution.
    const ownerForeign = await invoke(simulatePolicy, {
      method: "POST",
      path: "/api/v1/access/policies/simulate",
      headers: headers(owner),
      body: {
        subject: { tenantUserId: analyst.tenantUserId },
        request: simRequest
      }
    });
    expect(ownerForeign.status).toBe(200);

    const attributed = (await admin`
      SELECT 1 FROM awcms_mini_audit_events
      WHERE tenant_id = ${owner.tenantId}
        AND resource_type = 'abac_simulation'
        AND attributes->>'simulatedSubjectTenantUserId' = ${analyst.tenantUserId}
    `) as unknown[];
    expect(attributed.length).toBeGreaterThan(0);
  });
});
