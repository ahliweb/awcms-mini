/**
 * Integration tests for `organization_structure` (Issue #749, epic #738
 * platform-evolution Wave 2, ADR-0016) against real PostgreSQL, through
 * the REAL Astro route handlers: legal entity/unit-type/unit/location
 * CRUD + soft-delete/restore, the location-unit relationship, effective-
 * dated assignments, the hierarchy reparent endpoint (adversarial cycle/
 * self-parent rejection through the REAL write path, concurrent-reparent
 * race, Idempotency-Key replay), cross-tenant isolation, and the
 * `BusinessScopeHierarchyPort` adapter this module provides.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  createCookieJar,
  getAdminSql,
  getTestSql,
  integrationEnabled,
  invoke,
  provisionAppRole,
  resetDatabase
} from "./harness";

import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import {
  GET as listLegalEntities,
  POST as createLegalEntity
} from "../../src/pages/api/v1/organization-structure/legal-entities/index";
import { DELETE as deactivateLegalEntity } from "../../src/pages/api/v1/organization-structure/legal-entities/[id]";
import { POST as restoreLegalEntity } from "../../src/pages/api/v1/organization-structure/legal-entities/[id]/restore";
import {
  GET as listUnitTypes,
  POST as createUnitType
} from "../../src/pages/api/v1/organization-structure/unit-types/index";
import { DELETE as deleteUnitType } from "../../src/pages/api/v1/organization-structure/unit-types/[id]";
import { POST as restoreUnitType } from "../../src/pages/api/v1/organization-structure/unit-types/[id]/restore";
import { POST as createUnit } from "../../src/pages/api/v1/organization-structure/units/index";
import {
  GET as getUnitById,
  DELETE as deactivateUnit
} from "../../src/pages/api/v1/organization-structure/units/[id]";
import { POST as restoreUnit } from "../../src/pages/api/v1/organization-structure/units/[id]/restore";
import { POST as reparent } from "../../src/pages/api/v1/organization-structure/hierarchy/reparent";
import { GET as getHierarchyUnit } from "../../src/pages/api/v1/organization-structure/hierarchy/units/[id]";
import { GET as getTree } from "../../src/pages/api/v1/organization-structure/hierarchy/tree";
import {
  GET as listLocations,
  POST as createLocation
} from "../../src/pages/api/v1/organization-structure/locations/index";
import { DELETE as deleteLocation } from "../../src/pages/api/v1/organization-structure/locations/[id]";
import { POST as restoreLocation } from "../../src/pages/api/v1/organization-structure/locations/[id]/restore";
import { POST as createLocationUnitRelationship } from "../../src/pages/api/v1/organization-structure/location-unit-relationships/index";
import { POST as endLocationUnitRelationship } from "../../src/pages/api/v1/organization-structure/location-unit-relationships/[id]/end";
import {
  GET as listAssignments,
  POST as createAssignment
} from "../../src/pages/api/v1/organization-structure/assignments/index";
import { POST as endAssignment } from "../../src/pages/api/v1/organization-structure/assignments/[id]/end";

import { withTenant } from "../../src/lib/database/tenant-context";
import { hashPassword } from "../../src/lib/auth/password";
import { organizationStructureHierarchyPortAdapter } from "../../src/modules/organization-structure/application/organization-structure-hierarchy-port-adapter";
import { defaultBusinessScopeHierarchyPortAdapter } from "../../src/modules/identity-access/application/business-scope-hierarchy-port-adapter";

const OWNER_LOGIN = "owner@example.com";
const OWNER_PASSWORD = "integration-test-org-structure-owner-password";

type Bootstrap = {
  tenantId: string;
  token: string;
  tenantUserId: string;
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

  return {
    tenantId: setup.body.data.tenantId,
    token: login.body.data.token,
    tenantUserId: tenantUserRows[0]!.id
  };
}

/**
 * Seeds a SECOND (or later) tenant directly via the privileged admin
 * client, bypassing `POST /api/v1/setup/initialize` entirely — the setup
 * wizard is a GLOBAL one-time singleton lock (`awcms_mini_setup_state`,
 * `platform-bootstrap.ts`), so calling it a second time within the same
 * test always 403s "already initialized", even against a fresh per-test
 * database. Mirrors `platform-bootstrap.ts`'s own owner-provisioning
 * shape (profile/identity/tenant_user/role granted ALL permissions) so
 * this second tenant's owner has the same real, fully-permissioned
 * session `bootstrap()`'s first tenant gets — same convention
 * `tests/integration/api.integration.test.ts`'s own cross-tenant tests
 * document ("setup is a singleton, so tenant B is seeded via the
 * privileged client").
 */
async function bootstrapSecondTenant(
  tenantCode: string,
  tenantName: string
): Promise<Bootstrap> {
  const admin = getAdminSql();
  const loginIdentifier = `${tenantCode}-${OWNER_LOGIN}`;

  const tenantRows = (await admin`
    INSERT INTO awcms_mini_tenants (tenant_code, tenant_name, status)
    VALUES (${tenantCode}, ${tenantName}, 'active')
    RETURNING id
  `) as { id: string }[];
  const tenantId = tenantRows[0]!.id;

  const profileRows = (await admin`
    INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
    VALUES (${tenantId}, 'person', 'Owner')
    RETURNING id
  `) as { id: string }[];

  const passwordHash = await hashPassword(OWNER_PASSWORD);
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
  const tenantUserId = tenantUserRows[0]!.id;

  const roleRows = (await admin`
    INSERT INTO awcms_mini_roles (tenant_id, role_code, role_name, is_system)
    VALUES (${tenantId}, 'owner', 'Owner', true)
    RETURNING id
  `) as { id: string }[];

  await admin`
    INSERT INTO awcms_mini_role_permissions (tenant_id, role_id, permission_id)
    SELECT ${tenantId}, ${roleRows[0]!.id}, id FROM awcms_mini_permissions
  `;

  await admin`
    INSERT INTO awcms_mini_access_assignments (tenant_id, tenant_user_id, role_id, assigned_by)
    VALUES (${tenantId}, ${tenantUserId}, ${roleRows[0]!.id}, ${tenantUserId})
  `;

  const login = await invoke<{ data: { token: string } }>(authLogin, {
    method: "POST",
    path: "/api/v1/auth/login",
    headers: {
      "content-type": "application/json",
      "x-awcms-mini-tenant-id": tenantId
    },
    body: { loginIdentifier, password: OWNER_PASSWORD },
    cookies: createCookieJar()
  });
  expect(login.status).toBe(200);

  return { tenantId, token: login.body.data.token, tenantUserId };
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

async function createUnitFixture(
  owner: Bootstrap,
  code: string,
  legalEntityId: string | null = null
): Promise<string> {
  const result = await invoke<{ data: { unit: { id: string } } }>(createUnit, {
    method: "POST",
    path: "/api/v1/organization-structure/units",
    headers: authHeaders(owner),
    body: { code, name: code, legalEntityId }
  });
  expect(result.status).toBe(200);
  return result.body.data.unit.id;
}

const suite = integrationEnabled ? describe : describe.skip;

suite("organization_structure integration", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  test("legal entity: create, deactivate (soft-delete), restore round-trip", async () => {
    const owner = await bootstrap();

    const create = await invoke<{ data: { legalEntity: { id: string } } }>(
      createLegalEntity,
      {
        method: "POST",
        path: "/api/v1/organization-structure/legal-entities",
        headers: authHeaders(owner),
        body: {
          name: "PT Contoh Sejahtera",
          registrationIdentifier: "1234567890",
          registrationIdentifierLabel: "Business Registration Number"
        }
      }
    );
    expect(create.status).toBe(200);
    const legalEntityId = create.body.data.legalEntity.id;

    const deactivate = await invoke(deactivateLegalEntity, {
      method: "DELETE",
      path: `/api/v1/organization-structure/legal-entities/${legalEntityId}`,
      headers: authHeaders(owner, "legal-entity-deactivate-key"),
      params: { id: legalEntityId },
      body: { deleteReason: "Merged into another entity" }
    });
    expect(deactivate.status).toBe(200);

    const listAfterDeactivate = await invoke<{
      data: { legalEntities: { id: string; status: string }[] };
    }>(listLegalEntities, {
      method: "GET",
      path: "/api/v1/organization-structure/legal-entities",
      headers: authHeaders(owner)
    });
    expect(
      listAfterDeactivate.body.data.legalEntities.find(
        (entity) => entity.id === legalEntityId
      )
    ).toBeUndefined();

    const restore = await invoke(restoreLegalEntity, {
      method: "POST",
      path: `/api/v1/organization-structure/legal-entities/${legalEntityId}/restore`,
      headers: authHeaders(owner, "legal-entity-restore-key"),
      params: { id: legalEntityId }
    });
    expect(restore.status).toBe(200);

    const listAfterRestore = await invoke<{
      data: { legalEntities: { id: string }[] };
    }>(listLegalEntities, {
      method: "GET",
      path: "/api/v1/organization-structure/legal-entities",
      headers: authHeaders(owner)
    });
    expect(
      listAfterRestore.body.data.legalEntities.some(
        (entity) => entity.id === legalEntityId
      )
    ).toBe(true);
  });

  test("legal entity is demonstrably distinct from tenant (own table, own id, own soft-delete)", async () => {
    const owner = await bootstrap();
    const create = await invoke<{ data: { legalEntity: { id: string } } }>(
      createLegalEntity,
      {
        method: "POST",
        path: "/api/v1/organization-structure/legal-entities",
        headers: authHeaders(owner),
        body: { name: "PT Contoh" }
      }
    );
    expect(create.status).toBe(200);
    expect(create.body.data.legalEntity.id).not.toBe(owner.tenantId);

    const admin = getAdminSql();
    const rows = (await admin`
      SELECT tenant_id FROM awcms_mini_legal_entities WHERE id = ${create.body.data.legalEntity.id}
    `) as { tenant_id: string }[];
    expect(rows[0]!.tenant_id).toBe(owner.tenantId);
    expect(rows[0]!.tenant_id).not.toBe(create.body.data.legalEntity.id);
  });

  test("unit type + unit + location + location-unit relationship + assignment: full create flow", async () => {
    const owner = await bootstrap();

    const unitType = await invoke<{ data: { unitType: { id: string } } }>(
      createUnitType,
      {
        method: "POST",
        path: "/api/v1/organization-structure/unit-types",
        headers: authHeaders(owner),
        body: { code: "branch", name: "Branch" }
      }
    );
    expect(unitType.status).toBe(200);

    const unit = await invoke<{ data: { unit: { id: string } } }>(createUnit, {
      method: "POST",
      path: "/api/v1/organization-structure/units",
      headers: authHeaders(owner),
      body: {
        code: "jakarta-branch",
        name: "Jakarta Branch",
        unitTypeId: unitType.body.data.unitType.id
      }
    });
    expect(unit.status).toBe(200);
    const unitId = unit.body.data.unit.id;

    const location = await invoke<{ data: { location: { id: string } } }>(
      createLocation,
      {
        method: "POST",
        path: "/api/v1/organization-structure/locations",
        headers: authHeaders(owner),
        body: {
          name: "Jakarta Office",
          city: "Jakarta",
          latitude: -6.2,
          longitude: 106.8
        }
      }
    );
    expect(location.status).toBe(200);

    const relationship = await invoke<{
      data: { relationship: { id: string } };
    }>(createLocationUnitRelationship, {
      method: "POST",
      path: "/api/v1/organization-structure/location-unit-relationships",
      headers: authHeaders(owner),
      body: {
        operationalLocationId: location.body.data.location.id,
        organizationUnitId: unitId
      }
    });
    expect(relationship.status).toBe(200);

    const ended = await invoke(endLocationUnitRelationship, {
      method: "POST",
      path: `/api/v1/organization-structure/location-unit-relationships/${relationship.body.data.relationship.id}/end`,
      headers: authHeaders(owner, "location-unit-relationship-end-key"),
      params: { id: relationship.body.data.relationship.id }
    });
    expect(ended.status).toBe(200);

    const assignment = await invoke<{
      data: { assignment: { id: string } };
    }>(createAssignment, {
      method: "POST",
      path: "/api/v1/organization-structure/assignments",
      headers: authHeaders(owner, "assignment-create-key"),
      body: {
        organizationUnitId: unitId,
        tenantUserId: owner.tenantUserId,
        positionLabel: "Branch Manager"
      }
    });
    expect(assignment.status).toBe(200);

    const endResult = await invoke(endAssignment, {
      method: "POST",
      path: `/api/v1/organization-structure/assignments/${assignment.body.data.assignment.id}/end`,
      headers: authHeaders(owner, "assignment-end-key"),
      params: { id: assignment.body.data.assignment.id },
      body: { endReason: "Role changed" }
    });
    expect(endResult.status).toBe(200);

    const list = await invoke<{
      data: { assignments: { id: string; status: string }[] };
    }>(listAssignments, {
      method: "GET",
      path: "/api/v1/organization-structure/assignments",
      headers: authHeaders(owner)
    });
    const ours = list.body.data.assignments.find(
      (a) => a.id === assignment.body.data.assignment.id
    );
    expect(ours?.status).toBe("ended");
  });

  test("unit type: create, delete (soft-delete), restore round-trip, requires Idempotency-Key", async () => {
    const owner = await bootstrap();

    const create = await invoke<{ data: { unitType: { id: string } } }>(
      createUnitType,
      {
        method: "POST",
        path: "/api/v1/organization-structure/unit-types",
        headers: authHeaders(owner),
        body: { code: "cost_center", name: "Cost Center" }
      }
    );
    expect(create.status).toBe(200);
    const unitTypeId = create.body.data.unitType.id;

    const missingKey = await invoke(deleteUnitType, {
      method: "DELETE",
      path: `/api/v1/organization-structure/unit-types/${unitTypeId}`,
      headers: authHeaders(owner),
      params: { id: unitTypeId }
    });
    expect(missingKey.status).toBe(400);

    const deleted = await invoke(deleteUnitType, {
      method: "DELETE",
      path: `/api/v1/organization-structure/unit-types/${unitTypeId}`,
      headers: authHeaders(owner, "unit-type-delete-key"),
      params: { id: unitTypeId }
    });
    expect(deleted.status).toBe(200);

    // Replay with the same key: same response, no side effect.
    const replayDelete = await invoke(deleteUnitType, {
      method: "DELETE",
      path: `/api/v1/organization-structure/unit-types/${unitTypeId}`,
      headers: authHeaders(owner, "unit-type-delete-key"),
      params: { id: unitTypeId }
    });
    expect(replayDelete.status).toBe(200);

    const listAfterDelete = await invoke<{
      data: { unitTypes: { id: string }[] };
    }>(listUnitTypes, {
      method: "GET",
      path: "/api/v1/organization-structure/unit-types",
      headers: authHeaders(owner)
    });
    expect(
      listAfterDelete.body.data.unitTypes.find((ut) => ut.id === unitTypeId)
    ).toBeUndefined();

    const restoreMissingKey = await invoke(restoreUnitType, {
      method: "POST",
      path: `/api/v1/organization-structure/unit-types/${unitTypeId}/restore`,
      headers: authHeaders(owner),
      params: { id: unitTypeId }
    });
    expect(restoreMissingKey.status).toBe(400);

    const restore = await invoke(restoreUnitType, {
      method: "POST",
      path: `/api/v1/organization-structure/unit-types/${unitTypeId}/restore`,
      headers: authHeaders(owner, "unit-type-restore-key"),
      params: { id: unitTypeId }
    });
    expect(restore.status).toBe(200);

    const listAfterRestore = await invoke<{
      data: { unitTypes: { id: string }[] };
    }>(listUnitTypes, {
      method: "GET",
      path: "/api/v1/organization-structure/unit-types",
      headers: authHeaders(owner)
    });
    expect(
      listAfterRestore.body.data.unitTypes.some((ut) => ut.id === unitTypeId)
    ).toBe(true);
  });

  test("organization unit: create, deactivate (soft-delete), restore round-trip, requires Idempotency-Key", async () => {
    const owner = await bootstrap();
    const unitId = await createUnitFixture(owner, "warehouse-1");

    const missingKey = await invoke(deactivateUnit, {
      method: "DELETE",
      path: `/api/v1/organization-structure/units/${unitId}`,
      headers: authHeaders(owner),
      params: { id: unitId }
    });
    expect(missingKey.status).toBe(400);

    const deactivate = await invoke(deactivateUnit, {
      method: "DELETE",
      path: `/api/v1/organization-structure/units/${unitId}`,
      headers: authHeaders(owner, "unit-deactivate-key"),
      params: { id: unitId }
    });
    expect(deactivate.status).toBe(200);

    const replayDeactivate = await invoke(deactivateUnit, {
      method: "DELETE",
      path: `/api/v1/organization-structure/units/${unitId}`,
      headers: authHeaders(owner, "unit-deactivate-key"),
      params: { id: unitId }
    });
    expect(replayDeactivate.status).toBe(200);

    const afterDeactivate = await invoke<{
      data: { unit: { id: string; deletedAt: string | null } };
    }>(getUnitById, {
      method: "GET",
      path: `/api/v1/organization-structure/units/${unitId}`,
      headers: authHeaders(owner),
      params: { id: unitId }
    });
    expect(afterDeactivate.body.data.unit.deletedAt).not.toBeNull();

    const restoreMissingKey = await invoke(restoreUnit, {
      method: "POST",
      path: `/api/v1/organization-structure/units/${unitId}/restore`,
      headers: authHeaders(owner),
      params: { id: unitId }
    });
    expect(restoreMissingKey.status).toBe(400);

    const restore = await invoke(restoreUnit, {
      method: "POST",
      path: `/api/v1/organization-structure/units/${unitId}/restore`,
      headers: authHeaders(owner, "unit-restore-key"),
      params: { id: unitId }
    });
    expect(restore.status).toBe(200);

    const afterRestore = await invoke<{
      data: { unit: { id: string; deletedAt: string | null } };
    }>(getUnitById, {
      method: "GET",
      path: `/api/v1/organization-structure/units/${unitId}`,
      headers: authHeaders(owner),
      params: { id: unitId }
    });
    expect(afterRestore.body.data.unit.deletedAt).toBeNull();
  });

  test("ADVERSARIAL (Issue #795): reusing the same Idempotency-Key across restore of two DIFFERENT deactivated units (identical empty body/no body) must NOT replay unit A's restore onto unit B -- the mismatched hash must yield 409 CONFLICT, and unit B must still actually restore once given its OWN key", async () => {
    const owner = await bootstrap();
    const unitAId = await createUnitFixture(owner, "restore-adversarial-a");
    const unitBId = await createUnitFixture(owner, "restore-adversarial-b");

    await invoke(deactivateUnit, {
      method: "DELETE",
      path: `/api/v1/organization-structure/units/${unitAId}`,
      headers: authHeaders(owner, "restore-adversarial-deactivate-a"),
      params: { id: unitAId }
    });
    await invoke(deactivateUnit, {
      method: "DELETE",
      path: `/api/v1/organization-structure/units/${unitBId}`,
      headers: authHeaders(owner, "restore-adversarial-deactivate-b"),
      params: { id: unitBId }
    });

    const reusedKey = "restore-adversarial-reused-key";

    // Restore A with the reused key -- succeeds normally.
    const restoreA = await invoke<{ data: { unit: { id: string } } }>(
      restoreUnit,
      {
        method: "POST",
        path: `/api/v1/organization-structure/units/${unitAId}/restore`,
        headers: authHeaders(owner, reusedKey),
        params: { id: unitAId }
      }
    );
    expect(restoreA.status).toBe(200);
    expect(restoreA.body.data.unit.id).toBe(unitAId);

    // Attempt to restore B (still deactivated) with the SAME key and the
    // SAME empty body shape. Pre-fix, `computeRequestHash({})` never
    // included the unit id, so this would silently REPLAY A's cached
    // response (200, describing A as restored) without ever touching B --
    // B would appear "restored" to the caller while remaining deactivated.
    // Post-fix, the hash folds in the unit id, so the mismatch must be
    // detected and rejected as a conflict, never a false replay.
    const restoreBReusedKey = await invoke(restoreUnit, {
      method: "POST",
      path: `/api/v1/organization-structure/units/${unitBId}/restore`,
      headers: authHeaders(owner, reusedKey),
      params: { id: unitBId }
    });
    expect(restoreBReusedKey.status).toBe(409);
    expect(
      (restoreBReusedKey.body as { error: { code: string } }).error.code
    ).toBe("IDEMPOTENCY_CONFLICT");

    // B must still be deactivated -- NOT falsely reported as restored.
    // Assert real DB state, not just the false-replay attempt's status code.
    const admin = getAdminSql();
    const bStillDeactivated = (await admin`
      SELECT deleted_at FROM awcms_mini_organization_units WHERE id = ${unitBId}
    `) as { deleted_at: Date | null }[];
    expect(bStillDeactivated).toHaveLength(1);
    expect(bStillDeactivated[0]!.deleted_at).not.toBeNull();

    // With its OWN distinct key, B's restore genuinely applies.
    const restoreBOwnKey = await invoke<{ data: { unit: { id: string } } }>(
      restoreUnit,
      {
        method: "POST",
        path: `/api/v1/organization-structure/units/${unitBId}/restore`,
        headers: authHeaders(owner, "restore-adversarial-own-key-b"),
        params: { id: unitBId }
      }
    );
    expect(restoreBOwnKey.status).toBe(200);
    expect(restoreBOwnKey.body.data.unit.id).toBe(unitBId);

    const bNowRestored = (await admin`
      SELECT deleted_at FROM awcms_mini_organization_units WHERE id = ${unitBId}
    `) as { deleted_at: Date | null }[];
    expect(bNowRestored[0]!.deleted_at).toBeNull();
  });

  test("ADVERSARIAL (Issue #795): reusing the same Idempotency-Key across deactivate (DELETE) of two DIFFERENT active units with an identical-shaped body must NOT replay unit A's deactivation onto unit B -- the mismatched hash must yield 409 CONFLICT, and unit B must still actually deactivate once given its OWN key", async () => {
    const owner = await bootstrap();
    const unitAId = await createUnitFixture(owner, "deactivate-adversarial-a");
    const unitBId = await createUnitFixture(owner, "deactivate-adversarial-b");

    const reusedKey = "deactivate-adversarial-reused-key";
    const sharedBody = { deleteReason: "no longer needed" };

    // Deactivate A with the reused key -- succeeds normally.
    const deactivateA = await invoke<{ data: { unit: { id: string } } }>(
      deactivateUnit,
      {
        method: "DELETE",
        path: `/api/v1/organization-structure/units/${unitAId}`,
        headers: authHeaders(owner, reusedKey),
        params: { id: unitAId },
        body: sharedBody
      }
    );
    expect(deactivateA.status).toBe(200);
    expect(deactivateA.body.data.unit.id).toBe(unitAId);

    // Attempt to deactivate B (still active) with the SAME key and an
    // IDENTICALLY-shaped body. Pre-fix, `computeRequestHash(body)` never
    // included the unit id, so this would silently REPLAY A's cached
    // response (200, describing A as deactivated) without ever touching
    // B -- B would appear "deactivated" to the caller while remaining
    // active.
    const deactivateBReusedKey = await invoke(deactivateUnit, {
      method: "DELETE",
      path: `/api/v1/organization-structure/units/${unitBId}`,
      headers: authHeaders(owner, reusedKey),
      params: { id: unitBId },
      body: sharedBody
    });
    expect(deactivateBReusedKey.status).toBe(409);
    expect(
      (deactivateBReusedKey.body as { error: { code: string } }).error.code
    ).toBe("IDEMPOTENCY_CONFLICT");

    // B must still be active -- NOT falsely reported as deactivated.
    const admin = getAdminSql();
    const bStillActive = (await admin`
      SELECT deleted_at FROM awcms_mini_organization_units WHERE id = ${unitBId}
    `) as { deleted_at: Date | null }[];
    expect(bStillActive).toHaveLength(1);
    expect(bStillActive[0]!.deleted_at).toBeNull();

    // With its OWN distinct key, B's deactivation genuinely applies.
    const deactivateBOwnKey = await invoke<{ data: { unit: { id: string } } }>(
      deactivateUnit,
      {
        method: "DELETE",
        path: `/api/v1/organization-structure/units/${unitBId}`,
        headers: authHeaders(owner, "deactivate-adversarial-own-key-b"),
        params: { id: unitBId },
        body: sharedBody
      }
    );
    expect(deactivateBOwnKey.status).toBe(200);

    const bNowDeactivated = (await admin`
      SELECT deleted_at FROM awcms_mini_organization_units WHERE id = ${unitBId}
    `) as { deleted_at: Date | null }[];
    expect(bNowDeactivated[0]!.deleted_at).not.toBeNull();
  });

  test("operational location: create, delete (soft-delete), restore round-trip, requires Idempotency-Key", async () => {
    const owner = await bootstrap();

    const create = await invoke<{ data: { location: { id: string } } }>(
      createLocation,
      {
        method: "POST",
        path: "/api/v1/organization-structure/locations",
        headers: authHeaders(owner),
        body: { name: "Surabaya Office", city: "Surabaya" }
      }
    );
    expect(create.status).toBe(200);
    const locationId = create.body.data.location.id;

    const missingKey = await invoke(deleteLocation, {
      method: "DELETE",
      path: `/api/v1/organization-structure/locations/${locationId}`,
      headers: authHeaders(owner),
      params: { id: locationId }
    });
    expect(missingKey.status).toBe(400);

    const deleted = await invoke(deleteLocation, {
      method: "DELETE",
      path: `/api/v1/organization-structure/locations/${locationId}`,
      headers: authHeaders(owner, "location-delete-key"),
      params: { id: locationId }
    });
    expect(deleted.status).toBe(200);

    const replayDelete = await invoke(deleteLocation, {
      method: "DELETE",
      path: `/api/v1/organization-structure/locations/${locationId}`,
      headers: authHeaders(owner, "location-delete-key"),
      params: { id: locationId }
    });
    expect(replayDelete.status).toBe(200);

    const listAfterDelete = await invoke<{
      data: { locations: { id: string }[] };
    }>(listLocations, {
      method: "GET",
      path: "/api/v1/organization-structure/locations",
      headers: authHeaders(owner)
    });
    expect(
      listAfterDelete.body.data.locations.find((l) => l.id === locationId)
    ).toBeUndefined();

    const restoreMissingKey = await invoke(restoreLocation, {
      method: "POST",
      path: `/api/v1/organization-structure/locations/${locationId}/restore`,
      headers: authHeaders(owner),
      params: { id: locationId }
    });
    expect(restoreMissingKey.status).toBe(400);

    const restore = await invoke(restoreLocation, {
      method: "POST",
      path: `/api/v1/organization-structure/locations/${locationId}/restore`,
      headers: authHeaders(owner, "location-restore-key"),
      params: { id: locationId }
    });
    expect(restore.status).toBe(200);

    const listAfterRestore = await invoke<{
      data: { locations: { id: string }[] };
    }>(listLocations, {
      method: "GET",
      path: "/api/v1/organization-structure/locations",
      headers: authHeaders(owner)
    });
    expect(
      listAfterRestore.body.data.locations.some((l) => l.id === locationId)
    ).toBe(true);
  });

  test("assignment create: requires Idempotency-Key, rejects a duplicate active assignment for the same unit+subject, replays on retry", async () => {
    const owner = await bootstrap();
    const unitId = await createUnitFixture(owner, "duplicate-assignment-unit");

    const missingKey = await invoke(createAssignment, {
      method: "POST",
      path: "/api/v1/organization-structure/assignments",
      headers: authHeaders(owner),
      body: { organizationUnitId: unitId, tenantUserId: owner.tenantUserId }
    });
    expect(missingKey.status).toBe(400);

    const first = await invoke<{ data: { assignment: { id: string } } }>(
      createAssignment,
      {
        method: "POST",
        path: "/api/v1/organization-structure/assignments",
        headers: authHeaders(owner, "assignment-dup-key"),
        body: { organizationUnitId: unitId, tenantUserId: owner.tenantUserId }
      }
    );
    expect(first.status).toBe(200);

    // Same key + same payload: replays the same response, no new row.
    const replay = await invoke<{ data: { assignment: { id: string } } }>(
      createAssignment,
      {
        method: "POST",
        path: "/api/v1/organization-structure/assignments",
        headers: authHeaders(owner, "assignment-dup-key"),
        body: { organizationUnitId: unitId, tenantUserId: owner.tenantUserId }
      }
    );
    expect(replay.status).toBe(200);
    expect(replay.body.data.assignment.id).toBe(first.body.data.assignment.id);

    // Different key, same (unit, subject) pair while the first assignment
    // is still active: rejected by the app-level pre-check / partial
    // unique index backstop (sql/065), not silently duplicated.
    const duplicate = await invoke<{ error: { code: string } }>(
      createAssignment,
      {
        method: "POST",
        path: "/api/v1/organization-structure/assignments",
        headers: authHeaders(owner, "assignment-dup-key-2"),
        body: { organizationUnitId: unitId, tenantUserId: owner.tenantUserId }
      }
    );
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe("ALREADY_ASSIGNED");

    const admin = getAdminSql();
    const rows = (await admin`
      SELECT count(*)::int AS count FROM awcms_mini_organization_unit_assignments
      WHERE tenant_id = ${owner.tenantId} AND organization_unit_id = ${unitId}
        AND tenant_user_id = ${owner.tenantUserId} AND status = 'active'
    `) as { count: number }[];
    expect(rows[0]!.count).toBe(1);
  });

  test("ADVERSARIAL (Issue #795): reusing the same Idempotency-Key across end of two DIFFERENT active assignments with an identical-shaped body must NOT replay assignment A's end onto assignment B -- the mismatched hash must yield 409 CONFLICT, and assignment B must still actually end once given its OWN key", async () => {
    const owner = await bootstrap();
    const admin = getAdminSql();
    const unitAId = await createUnitFixture(
      owner,
      "assignment-end-adversarial-a"
    );
    const unitBId = await createUnitFixture(
      owner,
      "assignment-end-adversarial-b"
    );

    const assignmentA = await invoke<{ data: { assignment: { id: string } } }>(
      createAssignment,
      {
        method: "POST",
        path: "/api/v1/organization-structure/assignments",
        headers: authHeaders(owner, "assignment-end-adversarial-create-a"),
        body: { organizationUnitId: unitAId, tenantUserId: owner.tenantUserId }
      }
    );
    expect(assignmentA.status).toBe(200);
    const assignmentAId = assignmentA.body.data.assignment.id;

    const assignmentB = await invoke<{ data: { assignment: { id: string } } }>(
      createAssignment,
      {
        method: "POST",
        path: "/api/v1/organization-structure/assignments",
        headers: authHeaders(owner, "assignment-end-adversarial-create-b"),
        body: { organizationUnitId: unitBId, tenantUserId: owner.tenantUserId }
      }
    );
    expect(assignmentB.status).toBe(200);
    const assignmentBId = assignmentB.body.data.assignment.id;

    const reusedKey = "assignment-end-adversarial-reused-key";
    const sharedBody = { endReason: "role change" };

    // End assignment A with the reused key -- succeeds normally.
    const endA = await invoke<{ data: { assignment: { id: string } } }>(
      endAssignment,
      {
        method: "POST",
        path: `/api/v1/organization-structure/assignments/${assignmentAId}/end`,
        headers: authHeaders(owner, reusedKey),
        params: { id: assignmentAId },
        body: sharedBody
      }
    );
    expect(endA.status).toBe(200);
    expect(endA.body.data.assignment.id).toBe(assignmentAId);

    // Attempt to end assignment B (still active) with the SAME key and an
    // IDENTICALLY-shaped body. Pre-fix, `computeRequestHash(body)` never
    // included the assignment id, so this would silently REPLAY A's
    // cached response (200, describing A as ended) without ever touching
    // B -- B would appear "ended" to the caller while remaining active.
    const endBReusedKey = await invoke(endAssignment, {
      method: "POST",
      path: `/api/v1/organization-structure/assignments/${assignmentBId}/end`,
      headers: authHeaders(owner, reusedKey),
      params: { id: assignmentBId },
      body: sharedBody
    });
    expect(endBReusedKey.status).toBe(409);
    expect((endBReusedKey.body as { error: { code: string } }).error.code).toBe(
      "IDEMPOTENCY_CONFLICT"
    );

    // B must still be active -- NOT falsely reported as ended. Assert real
    // DB state, not just the false-replay attempt's status code.
    const bStillActive = (await admin`
      SELECT status, ended_at FROM awcms_mini_organization_unit_assignments
      WHERE id = ${assignmentBId}
    `) as { status: string; ended_at: Date | null }[];
    expect(bStillActive).toHaveLength(1);
    expect(bStillActive[0]!.status).toBe("active");
    expect(bStillActive[0]!.ended_at).toBeNull();

    // With its OWN distinct key, B's end genuinely applies.
    const endBOwnKey = await invoke<{ data: { assignment: { id: string } } }>(
      endAssignment,
      {
        method: "POST",
        path: `/api/v1/organization-structure/assignments/${assignmentBId}/end`,
        headers: authHeaders(owner, "assignment-end-adversarial-own-key-b"),
        params: { id: assignmentBId },
        body: sharedBody
      }
    );
    expect(endBOwnKey.status).toBe(200);

    const bNowEnded = (await admin`
      SELECT status, ended_at FROM awcms_mini_organization_unit_assignments
      WHERE id = ${assignmentBId}
    `) as { status: string; ended_at: Date | null }[];
    expect(bNowEnded[0]!.status).toBe("ended");
    expect(bNowEnded[0]!.ended_at).not.toBeNull();
  });

  test("hierarchy reparent: creates the first edge, tree/ancestor reflect it", async () => {
    const owner = await bootstrap();
    const parentId = await createUnitFixture(owner, "region");
    const childId = await createUnitFixture(owner, "branch");

    const reparentResult = await invoke<{ data: { edge: { id: string } } }>(
      reparent,
      {
        method: "POST",
        path: "/api/v1/organization-structure/hierarchy/reparent",
        headers: authHeaders(owner, "reparent-key-1"),
        body: {
          organizationUnitId: childId,
          parentOrganizationUnitId: parentId
        }
      }
    );
    expect(reparentResult.status).toBe(200);

    const ancestry = await invoke<{
      data: { ancestorUnitIds: string[]; descendantUnitIds: string[] };
    }>(getHierarchyUnit, {
      method: "GET",
      path: `/api/v1/organization-structure/hierarchy/units/${childId}`,
      headers: authHeaders(owner),
      params: { id: childId }
    });
    expect(ancestry.body.data.ancestorUnitIds).toEqual([parentId]);

    const parentAncestry = await invoke<{
      data: { descendantUnitIds: string[] };
    }>(getHierarchyUnit, {
      method: "GET",
      path: `/api/v1/organization-structure/hierarchy/units/${parentId}`,
      headers: authHeaders(owner),
      params: { id: parentId }
    });
    expect(parentAncestry.body.data.descendantUnitIds).toEqual([childId]);

    const tree = await invoke<{
      data: { tree: { organizationUnitId: string; children: unknown[] }[] };
    }>(getTree, {
      method: "GET",
      path: "/api/v1/organization-structure/hierarchy/tree",
      headers: authHeaders(owner)
    });
    const root = tree.body.data.tree.find(
      (node) => node.organizationUnitId === parentId
    );
    expect(root).toBeDefined();
    expect(root!.children).toHaveLength(1);
  });

  test("hierarchy reparent: rejects self-parent through the REAL write path", async () => {
    const owner = await bootstrap();
    const unitId = await createUnitFixture(owner, "solo-unit");

    const result = await invoke<{ error: { code: string } }>(reparent, {
      method: "POST",
      path: "/api/v1/organization-structure/hierarchy/reparent",
      headers: authHeaders(owner, "self-parent-key"),
      body: { organizationUnitId: unitId, parentOrganizationUnitId: unitId }
    });
    expect(result.status).toBe(422);
    expect(result.body.error.code).toBe("HIERARCHY_INVALID");

    const admin = getAdminSql();
    const rows = (await admin`
      SELECT count(*)::int AS count FROM awcms_mini_organization_unit_hierarchies
      WHERE organization_unit_id = ${unitId}
    `) as { count: number }[];
    expect(rows[0]!.count).toBe(0);
  });

  test("hierarchy reparent: rejects a cycle created via the create-edge path, then via the reparent path", async () => {
    const owner = await bootstrap();
    const unitA = await createUnitFixture(owner, "unit-a");
    const unitB = await createUnitFixture(owner, "unit-b");
    const unitC = await createUnitFixture(owner, "unit-c");

    // A -> B -> C (B's parent is A, C's parent is B).
    const edgeAB = await invoke(reparent, {
      method: "POST",
      path: "/api/v1/organization-structure/hierarchy/reparent",
      headers: authHeaders(owner, "cycle-key-1"),
      body: { organizationUnitId: unitB, parentOrganizationUnitId: unitA }
    });
    expect(edgeAB.status).toBe(200);

    const edgeBC = await invoke(reparent, {
      method: "POST",
      path: "/api/v1/organization-structure/hierarchy/reparent",
      headers: authHeaders(owner, "cycle-key-2"),
      body: { organizationUnitId: unitC, parentOrganizationUnitId: unitB }
    });
    expect(edgeBC.status).toBe(200);

    // Attempting to make C the parent of A closes the loop: A -> B -> C -> A.
    const cycleAttempt = await invoke<{ error: { code: string } }>(reparent, {
      method: "POST",
      path: "/api/v1/organization-structure/hierarchy/reparent",
      headers: authHeaders(owner, "cycle-key-3"),
      body: { organizationUnitId: unitA, parentOrganizationUnitId: unitC }
    });
    expect(cycleAttempt.status).toBe(422);
    expect(cycleAttempt.body.error.code).toBe("HIERARCHY_INVALID");

    // The rejected attempt must not have mutated anything — A still has no parent edge.
    const ancestry = await invoke<{ data: { ancestorUnitIds: string[] } }>(
      getHierarchyUnit,
      {
        method: "GET",
        path: `/api/v1/organization-structure/hierarchy/units/${unitA}`,
        headers: authHeaders(owner),
        params: { id: unitA }
      }
    );
    expect(ancestry.body.data.ancestorUnitIds).toEqual([]);
  });

  test("hierarchy reparent: reparenting an existing edge closes the old period and opens a new one (never mutates in place)", async () => {
    const owner = await bootstrap();
    const oldParent = await createUnitFixture(owner, "old-parent");
    const newParent = await createUnitFixture(owner, "new-parent");
    const child = await createUnitFixture(owner, "child-unit");

    await invoke(reparent, {
      method: "POST",
      path: "/api/v1/organization-structure/hierarchy/reparent",
      headers: authHeaders(owner, "history-key-1"),
      body: { organizationUnitId: child, parentOrganizationUnitId: oldParent }
    });

    await invoke(reparent, {
      method: "POST",
      path: "/api/v1/organization-structure/hierarchy/reparent",
      headers: authHeaders(owner, "history-key-2"),
      body: { organizationUnitId: child, parentOrganizationUnitId: newParent }
    });

    const historyResponse = await invoke<{
      data: {
        history: {
          parentOrganizationUnitId: string | null;
          effectiveTo: string | null;
        }[];
      };
    }>(getHierarchyUnit, {
      method: "GET",
      path: `/api/v1/organization-structure/hierarchy/units/${child}?history=1`,
      headers: authHeaders(owner),
      params: { id: child }
    });

    const history = historyResponse.body.data.history;
    expect(history).toHaveLength(2);
    // Newest first (ORDER BY effective_from DESC) — the current open edge
    // (new parent, effective_to null) then the closed historical one.
    expect(history[0]!.parentOrganizationUnitId).toBe(newParent);
    expect(history[0]!.effectiveTo).toBeNull();
    expect(history[1]!.parentOrganizationUnitId).toBe(oldParent);
    expect(history[1]!.effectiveTo).not.toBeNull();
  });

  test("hierarchy reparent: requires Idempotency-Key and replays the same response for a retried request", async () => {
    const owner = await bootstrap();
    const parentId = await createUnitFixture(owner, "parent-idem");
    const childId = await createUnitFixture(owner, "child-idem");

    const missingKey = await invoke(reparent, {
      method: "POST",
      path: "/api/v1/organization-structure/hierarchy/reparent",
      headers: {
        "content-type": "application/json",
        "x-awcms-mini-tenant-id": owner.tenantId,
        authorization: `Bearer ${owner.token}`
      },
      body: { organizationUnitId: childId, parentOrganizationUnitId: parentId }
    });
    expect(missingKey.status).toBe(400);

    const first = await invoke<{ data: { edge: { id: string } } }>(reparent, {
      method: "POST",
      path: "/api/v1/organization-structure/hierarchy/reparent",
      headers: authHeaders(owner, "replay-key"),
      body: { organizationUnitId: childId, parentOrganizationUnitId: parentId }
    });
    expect(first.status).toBe(200);

    const replay = await invoke<{ data: { edge: { id: string } } }>(reparent, {
      method: "POST",
      path: "/api/v1/organization-structure/hierarchy/reparent",
      headers: authHeaders(owner, "replay-key"),
      body: { organizationUnitId: childId, parentOrganizationUnitId: parentId }
    });
    expect(replay.status).toBe(200);
    expect(replay.body.data.edge.id).toBe(first.body.data.edge.id);

    const admin = getAdminSql();
    const rows = (await admin`
      SELECT count(*)::int AS count FROM awcms_mini_organization_unit_hierarchies
      WHERE organization_unit_id = ${childId}
    `) as { count: number }[];
    expect(rows[0]!.count).toBe(1);
  });

  test("hierarchy reparent: concurrent reparent race does not create an inconsistent/cyclic state", async () => {
    const owner = await bootstrap();
    const unitA = await createUnitFixture(owner, "race-a");
    const unitB = await createUnitFixture(owner, "race-b");

    // Fire two reparent attempts that, if both succeeded, would form a
    // direct cycle (A's parent = B, and B's parent = A) at almost the
    // same instant — the tenant-wide advisory lock inside `reparentUnit`
    // must serialize these so the second one (whichever wins the lock
    // second) observes the first one's committed state and is rejected.
    const [resultA, resultB] = await Promise.all([
      invoke<{ error?: { code: string } }>(reparent, {
        method: "POST",
        path: "/api/v1/organization-structure/hierarchy/reparent",
        headers: authHeaders(owner, "race-key-a"),
        body: { organizationUnitId: unitA, parentOrganizationUnitId: unitB }
      }),
      invoke<{ error?: { code: string } }>(reparent, {
        method: "POST",
        path: "/api/v1/organization-structure/hierarchy/reparent",
        headers: authHeaders(owner, "race-key-b"),
        body: { organizationUnitId: unitB, parentOrganizationUnitId: unitA }
      })
    ]);

    const statuses = [resultA.status, resultB.status].sort();
    // Exactly one must succeed (200) and the other must be rejected (422
    // HIERARCHY_INVALID, cycle) -- never both succeeding (which would be
    // an actual cycle in the data) and never both failing.
    expect(statuses).toEqual([200, 422]);

    const admin = getAdminSql();
    const edgeRows = (await admin`
      SELECT organization_unit_id, parent_organization_unit_id
      FROM awcms_mini_organization_unit_hierarchies
      WHERE tenant_id = ${owner.tenantId} AND effective_to IS NULL
        AND organization_unit_id IN (${unitA}, ${unitB})
    `) as {
      organization_unit_id: string;
      parent_organization_unit_id: string | null;
    }[];

    // Never both rows present with each other as parent (that would be
    // the cycle) -- at most one open edge between the pair.
    const bothPointingAtEachOther = edgeRows.some(
      (row) =>
        row.organization_unit_id === unitA &&
        row.parent_organization_unit_id === unitB &&
        edgeRows.some(
          (other) =>
            other.organization_unit_id === unitB &&
            other.parent_organization_unit_id === unitA
        )
    );
    expect(bothPointingAtEachOther).toBe(false);
  });

  test("cross-tenant isolation: unit cannot reference another tenant's legal entity, and RLS blocks direct row access", async () => {
    const ownerA = await bootstrap("tenant-a", "Tenant A");
    const ownerB = await bootstrapSecondTenant("tenant-b", "Tenant B");

    const legalEntityA = await invoke<{
      data: { legalEntity: { id: string } };
    }>(createLegalEntity, {
      method: "POST",
      path: "/api/v1/organization-structure/legal-entities",
      headers: authHeaders(ownerA),
      body: { name: "Tenant A Legal Entity" }
    });
    expect(legalEntityA.status).toBe(200);

    // Tenant B tries to create a unit referencing Tenant A's legal entity.
    const crossTenantUnit = await invoke<{ error: { code: string } }>(
      createUnit,
      {
        method: "POST",
        path: "/api/v1/organization-structure/units",
        headers: authHeaders(ownerB),
        body: {
          code: "cross-tenant-unit",
          name: "Cross Tenant Unit",
          legalEntityId: legalEntityA.body.data.legalEntity.id
        }
      }
    );
    expect(crossTenantUnit.status).toBe(422);
    expect(crossTenantUnit.body.error.code).toBe("LEGAL_ENTITY_INVALID");

    // Tenant B cannot read Tenant A's legal entity directly either (RLS).
    const listB = await invoke<{ data: { legalEntities: { id: string }[] } }>(
      listLegalEntities,
      {
        method: "GET",
        path: "/api/v1/organization-structure/legal-entities",
        headers: authHeaders(ownerB)
      }
    );
    expect(
      listB.body.data.legalEntities.some(
        (entity) => entity.id === legalEntityA.body.data.legalEntity.id
      )
    ).toBe(false);

    // Direct RLS check via withTenant as tenant B.
    const testSql = getTestSql();
    await withTenant(testSql, ownerB.tenantId, async (tx) => {
      const rows = (await tx`
        SELECT id FROM awcms_mini_legal_entities WHERE id = ${legalEntityA.body.data.legalEntity.id}
      `) as { id: string }[];
      expect(rows).toHaveLength(0);
    });
  });

  test("cross-tenant isolation: reparent cannot use another tenant's unit as parent", async () => {
    const ownerA = await bootstrap("tenant-a2", "Tenant A2");
    const ownerB = await bootstrapSecondTenant("tenant-b2", "Tenant B2");

    const unitA = await createUnitFixture(ownerA, "tenant-a-unit");
    const unitB = await createUnitFixture(ownerB, "tenant-b-unit");

    const crossTenantReparent = await invoke<{ error: { code: string } }>(
      reparent,
      {
        method: "POST",
        path: "/api/v1/organization-structure/hierarchy/reparent",
        headers: authHeaders(ownerB, "cross-tenant-reparent-key"),
        body: { organizationUnitId: unitB, parentOrganizationUnitId: unitA }
      }
    );
    expect(crossTenantReparent.status).toBe(422);
    expect(crossTenantReparent.body.error.code).toBe("PARENT_INVALID");
  });

  test("cross-tenant isolation: assignment cannot reference another tenant's tenant user", async () => {
    const ownerA = await bootstrap("tenant-a3", "Tenant A3");
    const ownerB = await bootstrapSecondTenant("tenant-b3", "Tenant B3");
    const unitB = await createUnitFixture(ownerB, "tenant-b3-unit");

    const crossTenantAssignment = await invoke<{ error: { code: string } }>(
      createAssignment,
      {
        method: "POST",
        path: "/api/v1/organization-structure/assignments",
        headers: authHeaders(ownerB, "cross-tenant-assignment-key"),
        body: { organizationUnitId: unitB, tenantUserId: ownerA.tenantUserId }
      }
    );
    expect(crossTenantAssignment.status).toBe(422);
    expect(crossTenantAssignment.body.error.code).toBe("TENANT_USER_INVALID");
  });

  test("organizationStructureHierarchyPortAdapter resolves real ancestor/descendant chains, including a legal-entity-terminated chain", async () => {
    const owner = await bootstrap();
    const testSql = getTestSql();

    const legalEntity = await invoke<{
      data: { legalEntity: { id: string } };
    }>(createLegalEntity, {
      method: "POST",
      path: "/api/v1/organization-structure/legal-entities",
      headers: authHeaders(owner),
      body: { name: "Adapter Test Legal Entity" }
    });

    const rootUnitId = await createUnitFixture(
      owner,
      "adapter-root",
      legalEntity.body.data.legalEntity.id
    );
    const childUnitId = await createUnitFixture(owner, "adapter-child");

    await invoke(reparent, {
      method: "POST",
      path: "/api/v1/organization-structure/hierarchy/reparent",
      headers: authHeaders(owner, "adapter-reparent-key"),
      body: {
        organizationUnitId: childUnitId,
        parentOrganizationUnitId: rootUnitId
      }
    });

    await withTenant(testSql, owner.tenantId, async (tx) => {
      const unitResolution =
        await organizationStructureHierarchyPortAdapter.resolveScope(
          tx,
          owner.tenantId,
          "organization_unit",
          childUnitId
        );
      expect(unitResolution.resolved).toBe(true);
      // Immediate parent (the root unit) first, then the legal entity
      // terminating the chain (heterogeneous ancestry).
      expect(unitResolution.ancestorScopes).toEqual([
        { scopeType: "organization_unit", scopeId: rootUnitId },
        {
          scopeType: "legal_entity",
          scopeId: legalEntity.body.data.legalEntity.id
        }
      ]);

      const legalEntityResolution =
        await organizationStructureHierarchyPortAdapter.resolveScope(
          tx,
          owner.tenantId,
          "legal_entity",
          legalEntity.body.data.legalEntity.id
        );
      expect(legalEntityResolution.resolved).toBe(true);
      expect(legalEntityResolution.ancestorScopes).toEqual([]);
      const descendantIds = legalEntityResolution.descendantScopes.map(
        (ref) => ref.scopeId
      );
      expect(new Set(descendantIds)).toEqual(
        new Set([rootUnitId, childUnitId])
      );

      // Unknown scope type resolves to a safe `resolved: false`, never a crash.
      const unknown =
        await organizationStructureHierarchyPortAdapter.resolveScope(
          tx,
          owner.tenantId,
          "cost_center_group",
          "00000000-0000-0000-0000-000000000000"
        );
      expect(unknown).toEqual({
        resolved: false,
        ancestorScopes: [],
        descendantScopes: []
      });
    });
  });

  test("identity-access's default adapter still resolves 'office' with the new field names and stays unresolved for organization_structure scope types", async () => {
    const owner = await bootstrap();
    const testSql = getTestSql();

    const admin = getAdminSql();
    const officeRows = (await admin`
      SELECT id FROM awcms_mini_offices WHERE tenant_id = ${owner.tenantId}
    `) as { id: string }[];
    const officeId = officeRows[0]!.id;

    await withTenant(testSql, owner.tenantId, async (tx) => {
      const officeResolution =
        await defaultBusinessScopeHierarchyPortAdapter.resolveScope(
          tx,
          owner.tenantId,
          "office",
          officeId
        );
      expect(officeResolution).toEqual({
        resolved: true,
        ancestorScopes: [],
        descendantScopes: []
      });

      const unknownScopeType =
        await defaultBusinessScopeHierarchyPortAdapter.resolveScope(
          tx,
          owner.tenantId,
          "organization_unit",
          "00000000-0000-0000-0000-000000000000"
        );
      expect(unknownScopeType).toEqual({
        resolved: false,
        ancestorScopes: [],
        descendantScopes: []
      });
    });
  });
});
