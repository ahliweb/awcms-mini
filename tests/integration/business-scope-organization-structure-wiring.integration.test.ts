/**
 * Integration tests for Issue #786 (follow-up to #746/#749, epic #738
 * platform-evolution) — wiring `organization_structure`'s REAL
 * `BusinessScopeHierarchyPort` adapter (`organizationStructureHierarchyPortAdapter`)
 * into `POST /api/v1/identity/business-scope/assignments`'s composition
 * root (`src/pages/api/v1/identity/business-scope/assignments/index.ts`'s
 * `buildHierarchyPort`), which previously hardcoded ONLY identity-access's
 * own flat "office" adapter — the reviewer's non-blocking follow-up note on
 * PR #779 ("`organizationStructureHierarchyPortAdapter` has zero production
 * callers").
 *
 * HONEST SCOPE NOTE (do not overclaim — see this repo's own recurring
 * "issue requirement + false in-code claim of compliance" failure pattern,
 * `docs/awcms-mini/20_threat_model_security_architecture.md`'s Wave-3
 * findings): `detectSoDConflicts` (`domain/sod-conflict-evaluation.ts`)
 * matches a `"same_scope_only"` rule by EXACT `(scopeType, scopeId)`
 * equality — it does NOT consult `resolution.ancestorScopes`/
 * `descendantScopes` at all today (verified: nothing outside the port/
 * adapter files themselves reads those fields). This issue wires the
 * SCOPE VALIDITY step (`resolveScope(...).resolved`) to the real,
 * hierarchy-walking adapter — it does NOT add hierarchy-aware (ancestor/
 * descendant) SoD conflict MATCHING, which remains a distinct, not-yet-built
 * feature. The tests below prove: (1) `legal_entity`/`organization_unit`
 * scope references now resolve through the REAL adapter (previously
 * impossible — the old hardcoded flat adapter returns `resolved: false`
 * for every scope type except `"office"`), genuinely reading
 * `organization_structure`'s own tenant-scoped hierarchy tables, not a
 * stub; (2) this newly-reachable resolution is what makes a same-scope SoD
 * conflict check on a non-`"office"` scope reachable at all (previously
 * `SCOPE_UNRESOLVED` short-circuited before SoD evaluation ever ran); (3)
 * per-tenant module enablement gates which adapter answers — disabling
 * `organization_structure` for a tenant makes its scope types unresolved
 * again, exactly like any other module the composition root doesn't
 * recognize, and the flat "office" adapter keeps working unaffected.
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

import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import {
  GET as listAssignments,
  POST as createAssignment
} from "../../src/pages/api/v1/identity/business-scope/assignments/index";
import { POST as disableModule } from "../../src/pages/api/v1/tenant/modules/[moduleKey]/disable";
import { hashPassword } from "../../src/lib/auth/password";

const OWNER_LOGIN = "owner@example.com";
const OWNER_PASSWORD = "integration-test-owner-password";
const SECOND_USER_PASSWORD = "integration-test-second-user-password";

type Bootstrap = {
  tenantId: string;
  token: string;
  tenantUserId: string;
  officeId: string;
};

async function bootstrap(
  tenantCode = "acme",
  tenantName = "Acme"
): Promise<Bootstrap> {
  const loginIdentifier = `${tenantCode}-${OWNER_LOGIN}`;
  const setup = await invoke<{ data: { tenantId: string } }>(setupInitialize, {
    method: "POST",
    path: "/api/v1/setup/initialize",
    headers: { "content-type": "application/json" },
    body: {
      tenantName,
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

  const admin = getAdminSql();
  const tenantUserRows = (await admin`
    SELECT tu.id FROM awcms_mini_tenant_users tu
    JOIN awcms_mini_identities i ON i.id = tu.identity_id
    WHERE tu.tenant_id = ${setup.body.data.tenantId} AND i.login_identifier = ${loginIdentifier}
  `) as { id: string }[];

  const officeRows = (await admin`
    SELECT id FROM awcms_mini_offices WHERE tenant_id = ${setup.body.data.tenantId}
  `) as { id: string }[];

  return {
    tenantId: setup.body.data.tenantId,
    token: login.body.data.token,
    tenantUserId: tenantUserRows[0]!.id,
    officeId: officeRows[0]!.id
  };
}

function authHeaders(
  owner: Bootstrap,
  idempotencyKey?: string
): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-awcms-mini-tenant-id": owner.tenantId,
    authorization: `Bearer ${owner.token}`,
    ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {})
  };
}

/** Same convention `business-scope-assignments.integration.test.ts` uses: an intentionally NO-role second subject, so it never accidentally holds either half of a registered SoD rule. */
async function createSecondTenantUser(
  tenantId: string,
  loginIdentifier: string,
  roleId?: string
): Promise<string> {
  const admin = getAdminSql();

  const profileRows = (await admin`
    INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
    VALUES (${tenantId}, 'person', 'Second User')
    RETURNING id
  `) as { id: string }[];

  const passwordHash = await hashPassword(SECOND_USER_PASSWORD);
  const identityRows = (await admin`
    INSERT INTO awcms_mini_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${tenantId}, ${profileRows[0]!.id}, ${loginIdentifier}, ${passwordHash})
    RETURNING id
  `) as { id: string }[];

  const tenantUserRows = (await admin`
    INSERT INTO awcms_mini_tenant_users (tenant_id, identity_id)
    VALUES (${tenantId}, ${identityRows[0]!.id})
    RETURNING id
  `) as { id: string }[];

  if (roleId) {
    await admin`
      INSERT INTO awcms_mini_access_assignments (tenant_id, tenant_user_id, role_id)
      VALUES (${tenantId}, ${tenantUserRows[0]!.id}, ${roleId})
    `;
  }

  return tenantUserRows[0]!.id;
}

async function createRoleWithPermissions(
  tenantId: string,
  roleCode: string,
  roleName: string,
  permissionKeys: string[]
): Promise<string> {
  const admin = getAdminSql();

  const roleRows = (await admin`
    INSERT INTO awcms_mini_roles (tenant_id, role_code, role_name)
    VALUES (${tenantId}, ${roleCode}, ${roleName})
    RETURNING id
  `) as { id: string }[];
  const roleId = roleRows[0]!.id;

  for (const key of permissionKeys) {
    const [moduleKey, activityCode, action] = key.split(".");
    await admin`
      INSERT INTO awcms_mini_role_permissions (tenant_id, role_id, permission_id)
      SELECT ${tenantId}, ${roleId}, id FROM awcms_mini_permissions
      WHERE module_key = ${moduleKey} AND activity_code = ${activityCode} AND action = ${action}
    `;
  }

  return roleId;
}

/** Real `organization_structure` schema (`sql/063`) — a legal entity plus one organization unit under it, both active/not-deleted, tenant-scoped. Seeded via admin SQL (same convention `bootstrap()`'s own office seeding uses) rather than through `organization_structure`'s own CRUD routes, to keep this file's scope narrowly about the hierarchy-port WIRING, not re-testing that module's own create endpoints (already covered by `organization-structure.integration.test.ts`). */
async function seedLegalEntityWithUnit(
  tenantId: string
): Promise<{ legalEntityId: string; unitId: string }> {
  const admin = getAdminSql();

  const legalEntityRows = (await admin`
    INSERT INTO awcms_mini_legal_entities (tenant_id, name)
    VALUES (${tenantId}, 'Acme Holdings')
    RETURNING id
  `) as { id: string }[];
  const legalEntityId = legalEntityRows[0]!.id;

  const unitRows = (await admin`
    INSERT INTO awcms_mini_organization_units (tenant_id, legal_entity_id, code, name)
    VALUES (${tenantId}, ${legalEntityId}, 'branch_a', 'Branch A')
    RETURNING id
  `) as { id: string }[];

  return { legalEntityId, unitId: unitRows[0]!.id };
}

const suite = integrationEnabled ? describe : describe.skip;

suite(
  "business-scope assignments — organization_structure hierarchy-port wiring (Issue #786)",
  () => {
    beforeAll(async () => {
      await applyMigrations();
      await provisionAppRole();
    });

    beforeEach(async () => {
      await resetDatabase();
    });

    test("create: a real organization_unit scope resolves through the REAL organization_structure adapter (previously always SCOPE_UNRESOLVED under the old hardcoded flat adapter)", async () => {
      const owner = await bootstrap();
      const { unitId } = await seedLegalEntityWithUnit(owner.tenantId);
      const subjectId = await createSecondTenantUser(
        owner.tenantId,
        "acme-org-subject-1@example.com"
      );

      const result = await invoke<{
        data: { assignment: { id: string; scopeType: string } };
      }>(createAssignment, {
        method: "POST",
        path: "/api/v1/identity/business-scope/assignments",
        headers: authHeaders(owner, "org-wiring-1"),
        body: {
          tenantUserId: subjectId,
          scopeType: "organization_unit",
          scopeId: unitId,
          reason: "Grant scoped to a real organization unit."
        }
      });

      expect(result.status).toBe(200);
      expect(result.body.data.assignment.scopeType).toBe("organization_unit");

      const listed = await invoke<{ data: { assignments: unknown[] } }>(
        listAssignments,
        {
          method: "GET",
          path: "/api/v1/identity/business-scope/assignments",
          headers: authHeaders(owner)
        }
      );
      expect(listed.body.data.assignments).toHaveLength(1);
    });

    test("create: a real legal_entity scope also resolves through the REAL adapter", async () => {
      const owner = await bootstrap();
      const { legalEntityId } = await seedLegalEntityWithUnit(owner.tenantId);
      const subjectId = await createSecondTenantUser(
        owner.tenantId,
        "acme-org-subject-2@example.com"
      );

      const result = await invoke<{
        data: { assignment: { scopeType: string } };
      }>(createAssignment, {
        method: "POST",
        path: "/api/v1/identity/business-scope/assignments",
        headers: authHeaders(owner, "org-wiring-2"),
        body: {
          tenantUserId: subjectId,
          scopeType: "legal_entity",
          scopeId: legalEntityId
        }
      });

      expect(result.status).toBe(200);
      expect(result.body.data.assignment.scopeType).toBe("legal_entity");
    });

    test("create: an organization_unit belonging to a DIFFERENT tenant is still SCOPE_UNRESOLVED — the real adapter is genuinely tenant-scoped, not a naive cross-tenant existence check", async () => {
      const ownerA = await bootstrap("acme", "Acme");
      const admin = getAdminSql();

      const tenantBRows = (await admin`
        INSERT INTO awcms_mini_tenants (tenant_code, tenant_name)
        VALUES ('globex-org', 'Globex Org')
        RETURNING id
      `) as { id: string }[];
      const { unitId: unitBId } = await seedLegalEntityWithUnit(
        tenantBRows[0]!.id
      );

      const subjectId = await createSecondTenantUser(
        ownerA.tenantId,
        "acme-org-subject-3@example.com"
      );

      const result = await invoke(createAssignment, {
        method: "POST",
        path: "/api/v1/identity/business-scope/assignments",
        headers: authHeaders(ownerA, "org-wiring-3"),
        body: {
          tenantUserId: subjectId,
          scopeType: "organization_unit",
          scopeId: unitBId
        }
      });

      expect(result.status).toBe(400);
      expect((result.body as { error: { code: string } }).error.code).toBe(
        "SCOPE_UNRESOLVED"
      );
    });

    test("SoD conflict on a non-office scope becomes reachable ONLY once the real organization_structure adapter validates it (same_scope_only rule at an organization_unit scope)", async () => {
      const owner = await bootstrap();
      const { unitId } = await seedLegalEntityWithUnit(owner.tenantId);
      const subjectId = await createSecondTenantUser(
        owner.tenantId,
        "acme-org-subject-4@example.com"
      );

      // `identity_access.business_scope_assignment_scope_maker_checker`
      // (same_scope_only): holding both `business_scope_assignments.create`
      // and `.revoke` AT THE SAME SCOPE is a conflict. Before this issue,
      // granting either half at `scopeType: "organization_unit"` would have
      // failed at SCOPE_UNRESOLVED before SoD evaluation ever ran.
      const creatorRole = await createRoleWithPermissions(
        owner.tenantId,
        "org_scope_creator",
        "Org Scope Creator",
        ["identity_access.business_scope_assignments.create"]
      );
      const revokerRole = await createRoleWithPermissions(
        owner.tenantId,
        "org_scope_revoker",
        "Org Scope Revoker",
        ["identity_access.business_scope_assignments.revoke"]
      );

      const first = await invoke<{ data: { assignment: { id: string } } }>(
        createAssignment,
        {
          method: "POST",
          path: "/api/v1/identity/business-scope/assignments",
          headers: authHeaders(owner, "org-wiring-sod-1"),
          body: {
            tenantUserId: subjectId,
            roleId: creatorRole,
            scopeType: "organization_unit",
            scopeId: unitId
          }
        }
      );
      expect(first.status).toBe(200);

      const conflicting = await invoke(createAssignment, {
        method: "POST",
        path: "/api/v1/identity/business-scope/assignments",
        headers: authHeaders(owner, "org-wiring-sod-2"),
        body: {
          tenantUserId: subjectId,
          roleId: revokerRole,
          scopeType: "organization_unit",
          scopeId: unitId
        }
      });

      expect(conflicting.status).toBe(409);
      expect((conflicting.body as { error: { code: string } }).error.code).toBe(
        "SOD_CONFLICT"
      );

      const admin = getAdminSql();
      const evaluations = (await admin`
        SELECT conflict_detected FROM awcms_mini_sod_conflict_evaluations
        WHERE tenant_id = ${owner.tenantId} AND trigger_context = 'assignment_create'
      `) as { conflict_detected: boolean }[];
      expect(evaluations.length).toBeGreaterThan(0);
      expect(evaluations[0]!.conflict_detected).toBe(true);
    });

    test("fallback: when organization_structure is DISABLED for the tenant, an organization_unit scope is SCOPE_UNRESOLVED again — the composition root correctly stops consulting the disabled module's adapter", async () => {
      const owner = await bootstrap();
      const { unitId } = await seedLegalEntityWithUnit(owner.tenantId);
      const subjectId = await createSecondTenantUser(
        owner.tenantId,
        "acme-org-subject-5@example.com"
      );

      const disabled = await invoke(disableModule, {
        method: "POST",
        path: "/api/v1/tenant/modules/organization_structure/disable",
        headers: authHeaders(owner, "org-wiring-disable-1"),
        params: { moduleKey: "organization_structure" },
        body: { reason: "Testing hierarchy-port fallback." }
      });
      expect(disabled.status).toBe(200);

      const result = await invoke(createAssignment, {
        method: "POST",
        path: "/api/v1/identity/business-scope/assignments",
        headers: authHeaders(owner, "org-wiring-4"),
        body: {
          tenantUserId: subjectId,
          scopeType: "organization_unit",
          scopeId: unitId
        }
      });

      expect(result.status).toBe(400);
      expect((result.body as { error: { code: string } }).error.code).toBe(
        "SCOPE_UNRESOLVED"
      );
    });

    test('fallback: identity-access\'s own flat "office" adapter still works unaffected when organization_structure is disabled for the tenant', async () => {
      const owner = await bootstrap();
      const subjectId = await createSecondTenantUser(
        owner.tenantId,
        "acme-org-subject-6@example.com"
      );

      const disabled = await invoke(disableModule, {
        method: "POST",
        path: "/api/v1/tenant/modules/organization_structure/disable",
        headers: authHeaders(owner, "org-wiring-disable-2"),
        params: { moduleKey: "organization_structure" },
        body: { reason: "Testing hierarchy-port fallback." }
      });
      expect(disabled.status).toBe(200);

      const result = await invoke<{
        data: { assignment: { scopeType: string } };
      }>(createAssignment, {
        method: "POST",
        path: "/api/v1/identity/business-scope/assignments",
        headers: authHeaders(owner, "org-wiring-5"),
        body: {
          tenantUserId: subjectId,
          scopeType: "office",
          scopeId: owner.officeId
        }
      });

      expect(result.status).toBe(200);
      expect(result.body.data.assignment.scopeType).toBe("office");
    });
  }
);
