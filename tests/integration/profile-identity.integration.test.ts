/**
 * Integration tests for Issue #748 (epic `platform-evolution` #738 Wave 2):
 * profile-identity party CRUD, identifiers, relationships, duplicate
 * detection, and the merge workflow — RLS/ABAC, idempotency, and
 * (critically) cross-tenant merge/match rejection.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test
} from "bun:test";

import {
  applyMigrations,
  createCookieJar,
  getAdminSql,
  integrationEnabled,
  invoke,
  provisionAppRole,
  resetDatabase
} from "./harness";

import { POST as authLoginPost } from "../../src/pages/api/v1/auth/login";
import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";

import {
  GET as listParties,
  POST as createParty
} from "../../src/pages/api/v1/profiles/index";
import {
  GET as getParty,
  PATCH as updateParty,
  DELETE as archiveParty
} from "../../src/pages/api/v1/profiles/[id]";
import { POST as restoreParty } from "../../src/pages/api/v1/profiles/[id]/restore";
import {
  GET as listIdentifiers,
  POST as createIdentifier
} from "../../src/pages/api/v1/profiles/[id]/identifiers/index";
import {
  GET as listRelationships,
  POST as createRelationship
} from "../../src/pages/api/v1/profiles/[id]/relationships/index";
import { POST as scanDuplicates } from "../../src/pages/api/v1/profiles/[id]/duplicate-candidates/scan";
import { GET as listDuplicateCandidatesRoute } from "../../src/pages/api/v1/profile-duplicate-candidates/index";
import { POST as reviewDuplicateCandidate } from "../../src/pages/api/v1/profile-duplicate-candidates/[id]/review";
import {
  GET as listMergeRequestsRoute,
  POST as createMergeRequestRoute
} from "../../src/pages/api/v1/profile-merge-requests/index";
import { POST as decideMergeRequestRoute } from "../../src/pages/api/v1/profile-merge-requests/[id]/decisions";
import { POST as executeMergeRequestRoute } from "../../src/pages/api/v1/profile-merge-requests/[id]/execute";

import {
  createMergeRequest,
  executeMergeRequest
} from "../../src/modules/profile-identity/application/merge-workflow";
import { CrossTenantMergeError } from "../../src/modules/profile-identity/domain/merge";

const OWNER_LOGIN = "owner@example.com";
const OWNER_PASSWORD = "integration-test-owner-password";

type Bootstrap = {
  tenantId: string;
  tenantCode: string;
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

  const login = await invoke<{ data: { token: string } }>(authLoginPost, {
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
    tenantCode,
    token: login.body.data.token,
    tenantUserId: tenantUserRows[0]!.id
  };
}

function authHeaders(b: Bootstrap): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-awcms-mini-tenant-id": b.tenantId,
    authorization: `Bearer ${b.token}`
  };
}

/** A second tenant user within the SAME bootstrap, so a merge decision can be made by someone OTHER than the requester (self-approval-deny otherwise blocks every decision in these tests, since the owner is the only user). */
async function createSecondTenantUser(
  tenantId: string,
  loginIdentifier: string
): Promise<{ token: string; tenantUserId: string }> {
  const password = "integration-test-second-user-password";
  const admin = getAdminSql();
  const passwordHash = await Bun.password.hash(password);

  const tenantUserId = await admin.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);

    const profile = (await tx`
      INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
      VALUES (${tenantId}, 'person', 'Second User') RETURNING id
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

    const roleRows = (await tx`
      SELECT id FROM awcms_mini_roles WHERE tenant_id = ${tenantId} LIMIT 1
    `) as { id: string }[];

    if (roleRows[0]) {
      await tx`
        INSERT INTO awcms_mini_access_assignments (tenant_id, tenant_user_id, role_id)
        VALUES (${tenantId}, ${tenantUser[0]!.id}, ${roleRows[0].id})
      `;
    }

    return tenantUser[0]!.id;
  });

  const login = await invoke<{ data: { token: string } }>(authLoginPost, {
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

/** A second, fully-independent tenant with full profile_identity access — same "seed via raw SQL + real login" pattern `social-publishing.integration.test.ts`'s `seedSecondTenantWithSocialPublishingAccess` uses. */
async function seedSecondTenantWithProfileIdentityAccess(
  tenantCode: string
): Promise<Bootstrap> {
  const tenantId = crypto.randomUUID();
  const loginIdentifier = `${tenantCode}-${OWNER_LOGIN}`;
  const password = "integration-test-tenant-b-password";
  const admin = getAdminSql();

  await admin`
    INSERT INTO awcms_mini_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES
      (${tenantId}, ${tenantCode}, ${tenantCode}, ${tenantCode}, 'active', 'en', 'light')
  `;

  const passwordHash = await Bun.password.hash(password);
  let tenantUserId = "";

  await admin.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);

    const profile = (await tx`
      INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
      VALUES (${tenantId}, 'person', 'Tenant B User') RETURNING id
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
    const role = (await tx`
      INSERT INTO awcms_mini_roles (tenant_id, role_code, role_name)
      VALUES (${tenantId}, 'full_access', 'Full Access') RETURNING id
    `) as { id: string }[];
    const permissions = (await tx`
      SELECT id FROM awcms_mini_permissions WHERE module_key = 'profile_identity'
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

    tenantUserId = tenantUser[0]!.id;
  });

  const login = await invoke<{ data: { token: string } }>(authLoginPost, {
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

  return { tenantId, tenantCode, token: login.body.data.token, tenantUserId };
}

async function createTestParty(
  b: Bootstrap,
  displayName: string
): Promise<string> {
  const result = await invoke<{ data: { id: string } }>(createParty, {
    method: "POST",
    path: "/api/v1/profiles",
    headers: authHeaders(b),
    body: { profileType: "person", displayName }
  });
  expect(result.status).toBe(200);
  return result.body.data.id;
}

const suite = integrationEnabled ? describe : describe.skip;

suite(
  "profile_identity party lifecycle, duplicates, and merge (Issue #748)",
  () => {
    beforeAll(async () => {
      await applyMigrations();
      await provisionAppRole();
    });

    beforeEach(async () => {
      await resetDatabase();
    });

    afterEach(() => {
      // no-op — reserved for parity with sibling suites' env-var restores.
    });

    // -------------------------------------------------------------------
    // Party CRUD
    // -------------------------------------------------------------------

    test("create/get/list/update/archive/restore full lifecycle", async () => {
      const b = await bootstrap();

      const created = await invoke<{ data: { id: string; status: string } }>(
        createParty,
        {
          method: "POST",
          path: "/api/v1/profiles",
          headers: authHeaders(b),
          body: { profileType: "organization", displayName: "Acme Corp" }
        }
      );
      expect(created.status).toBe(200);
      const profileId = created.body.data.id;

      const detail = await invoke<{ data: { displayName: string } }>(getParty, {
        method: "GET",
        path: `/api/v1/profiles/${profileId}`,
        headers: authHeaders(b),
        params: { id: profileId }
      });
      expect(detail.status).toBe(200);
      expect(detail.body.data.displayName).toBe("Acme Corp");

      const listed = await invoke<{ data: { items: { id: string }[] } }>(
        listParties,
        {
          method: "GET",
          path: "/api/v1/profiles?q=Acme",
          headers: authHeaders(b)
        }
      );
      expect(listed.status).toBe(200);
      expect(listed.body.data.items.some((item) => item.id === profileId)).toBe(
        true
      );

      const updated = await invoke<{ data: { displayName: string } }>(
        updateParty,
        {
          method: "PATCH",
          path: `/api/v1/profiles/${profileId}`,
          headers: authHeaders(b),
          params: { id: profileId },
          body: { displayName: "Acme Corp Renamed" }
        }
      );
      expect(updated.status).toBe(200);
      expect(updated.body.data.displayName).toBe("Acme Corp Renamed");

      const archived = await invoke(archiveParty, {
        method: "DELETE",
        path: `/api/v1/profiles/${profileId}`,
        headers: authHeaders(b),
        params: { id: profileId },
        body: { reason: "test archive" }
      });
      expect(archived.status).toBe(200);

      const restored = await invoke(restoreParty, {
        method: "POST",
        path: `/api/v1/profiles/${profileId}/restore`,
        headers: authHeaders(b),
        params: { id: profileId }
      });
      expect(restored.status).toBe(200);
    });

    test("ABAC default-deny: a role with no profile_management.create permission cannot create a party", async () => {
      const b = await bootstrap();

      // Remove every permission from the owner's role to simulate a
      // no-permission user.
      const admin = getAdminSql();
      await admin`DELETE FROM awcms_mini_role_permissions WHERE tenant_id = ${b.tenantId}`;

      const result = await invoke(createParty, {
        method: "POST",
        path: "/api/v1/profiles",
        headers: authHeaders(b),
        body: { profileType: "person", displayName: "Should Be Denied" }
      });

      expect(result.status).toBe(403);
    });

    // -------------------------------------------------------------------
    // Identifiers — masking + dedup
    // -------------------------------------------------------------------

    test("identifier responses are always masked, never the raw value", async () => {
      const b = await bootstrap();
      const profileId = await createTestParty(b, "Jane Doe");

      const created = await invoke<{ data: { maskedValue: string } }>(
        createIdentifier,
        {
          method: "POST",
          path: `/api/v1/profiles/${profileId}/identifiers`,
          headers: authHeaders(b),
          params: { id: profileId },
          body: { identifierType: "email", value: "jane.doe@example.com" }
        }
      );
      expect(created.status).toBe(200);
      expect(created.body.data.maskedValue).not.toBe("jane.doe@example.com");
      expect(JSON.stringify(created.body)).not.toContain(
        "jane.doe@example.com"
      );

      const listed = await invoke<{ data: { items: unknown[] } }>(
        listIdentifiers,
        {
          method: "GET",
          path: `/api/v1/profiles/${profileId}/identifiers`,
          headers: authHeaders(b),
          params: { id: profileId }
        }
      );
      expect(JSON.stringify(listed.body)).not.toContain("jane.doe@example.com");
    });

    test("adding the same identifier value/type twice for a tenant is rejected 409", async () => {
      const b = await bootstrap();
      const profileA = await createTestParty(b, "Party A");
      const profileB = await createTestParty(b, "Party B");

      const first = await invoke(createIdentifier, {
        method: "POST",
        path: `/api/v1/profiles/${profileA}/identifiers`,
        headers: authHeaders(b),
        params: { id: profileA },
        body: { identifierType: "email", value: "dup@example.com" }
      });
      expect(first.status).toBe(200);

      const second = await invoke(createIdentifier, {
        method: "POST",
        path: `/api/v1/profiles/${profileB}/identifiers`,
        headers: authHeaders(b),
        params: { id: profileB },
        body: { identifierType: "email", value: "dup@example.com" }
      });
      expect(second.status).toBe(409);
    });

    // -------------------------------------------------------------------
    // Relationships — generic types
    // -------------------------------------------------------------------

    test("generic relationship type is accepted; a hardcoded business-role word is rejected", async () => {
      const b = await bootstrap();
      const profileA = await createTestParty(b, "Party A");
      const profileB = await createTestParty(b, "Party B");

      const generic = await invoke(createRelationship, {
        method: "POST",
        path: `/api/v1/profiles/${profileA}/relationships`,
        headers: authHeaders(b),
        params: { id: profileA },
        body: { toProfileId: profileB, relationshipType: "related_party" }
      });
      expect(generic.status).toBe(200);

      const businessRole = await invoke(createRelationship, {
        method: "POST",
        path: `/api/v1/profiles/${profileA}/relationships`,
        headers: authHeaders(b),
        params: { id: profileA },
        body: { toProfileId: profileB, relationshipType: "customer" }
      });
      expect(businessRole.status).toBe(400);

      const listed = await invoke<{ data: { items: unknown[] } }>(
        listRelationships,
        {
          method: "GET",
          path: `/api/v1/profiles/${profileA}/relationships`,
          headers: authHeaders(b),
          params: { id: profileA }
        }
      );
      expect(listed.body.data.items).toHaveLength(1);
    });

    // -------------------------------------------------------------------
    // Duplicate candidates — deterministic match, sticky false-positive
    // -------------------------------------------------------------------

    test("scan finds a deterministic identifier match; a not_duplicate review sticks across re-scan", async () => {
      const b = await bootstrap();
      const profileA = await createTestParty(b, "Alice");
      const profileB = await createTestParty(b, "Alice Duplicate");

      await invoke(createIdentifier, {
        method: "POST",
        path: `/api/v1/profiles/${profileA}/identifiers`,
        headers: authHeaders(b),
        params: { id: profileA },
        body: { identifierType: "email", value: "alice@example.com" }
      });
      // Different profile, different identifier row, SAME normalized value
      // hash. The API (correctly) rejects an ACTIVE literal duplicate
      // value/type pair for a different profile (409, tested above) — that
      // partial-unique-index constraint (migration 003) makes "same value,
      // both ACTIVE" structurally unreachable, so the only realistic
      // deterministic-match fixture is a SOFT-DELETED identifier on the
      // other profile (see `generateDuplicateCandidatesForProfile`'s own
      // header comment for why this is still meaningful duplicate evidence).
      // Seeded directly via SQL (already-deleted row, so never goes through
      // the create endpoint's own live uniqueness check at all).
      const admin = getAdminSql();
      const { hashIdentifier, maskIdentifier } =
        await import("../../src/modules/profile-identity/domain/identifier");
      const normalized = "alice@example.com";
      await admin.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL app.current_tenant_id = '${b.tenantId}'`);
        await tx`
        INSERT INTO awcms_mini_profile_identifiers
          (tenant_id, profile_id, identifier_type, normalized_value, value_hash, masked_value,
           deleted_at, delete_reason)
        VALUES (
          ${b.tenantId}, ${profileB}, 'email', ${normalized}, ${hashIdentifier(normalized)},
          ${maskIdentifier("email", normalized)}, now(), 'test fixture: soft-deleted duplicate'
        )
      `;
      });

      const scan = await invoke<{ data: { candidatesConsidered: number } }>(
        scanDuplicates,
        {
          method: "POST",
          path: `/api/v1/profiles/${profileA}/duplicate-candidates/scan`,
          headers: authHeaders(b),
          params: { id: profileA }
        }
      );
      expect(scan.status).toBe(200);
      expect(scan.body.data.candidatesConsidered).toBeGreaterThanOrEqual(1);

      const listed = await invoke<{
        data: { items: { id: string; matchBasis: string; status: string }[] };
      }>(listDuplicateCandidatesRoute, {
        method: "GET",
        path: "/api/v1/profile-duplicate-candidates",
        headers: authHeaders(b)
      });
      expect(listed.status).toBe(200);
      const candidate = listed.body.data.items.find((item) =>
        item.matchBasis.includes("deterministic")
      );
      expect(candidate).toBeDefined();

      const reviewed = await invoke(reviewDuplicateCandidate, {
        method: "POST",
        path: `/api/v1/profile-duplicate-candidates/${candidate!.id}/review`,
        headers: authHeaders(b),
        params: { id: candidate!.id },
        body: { decision: "not_duplicate" }
      });
      expect(reviewed.status).toBe(200);

      // Re-scan must NOT flip the reviewed candidate back to pending.
      await invoke(scanDuplicates, {
        method: "POST",
        path: `/api/v1/profiles/${profileA}/duplicate-candidates/scan`,
        headers: authHeaders(b),
        params: { id: profileA }
      });

      const listedAgain = await invoke<{
        data: { items: { id: string; status: string }[] };
      }>(listDuplicateCandidatesRoute, {
        method: "GET",
        path: "/api/v1/profile-duplicate-candidates",
        headers: authHeaders(b)
      });
      const stillReviewed = listedAgain.body.data.items.find(
        (item) => item.id === candidate!.id
      );
      expect(stillReviewed?.status).toBe("not_duplicate");
    });

    // -------------------------------------------------------------------
    // Merge workflow — approval, idempotency, reference repointing
    // -------------------------------------------------------------------

    test("full merge workflow: create -> self-approval denied -> approved by a different user -> executed -> entity links repointed -> immutable history recorded", async () => {
      const b = await bootstrap();
      const survivor = await createTestParty(b, "Survivor");
      const loser = await createTestParty(b, "Loser");

      // Seed an entity link on the loser (simulates another module referencing this profile).
      const admin = getAdminSql();
      await admin.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL app.current_tenant_id = '${b.tenantId}'`);
        await tx`
        INSERT INTO awcms_mini_profile_entity_links
          (tenant_id, profile_id, module_key, entity_type, entity_id)
        VALUES (${b.tenantId}, ${loser}, 'blog_content', 'author', ${crypto.randomUUID()})
      `;
      });

      const createIdempotencyKey = crypto.randomUUID();
      const created = await invoke<{
        data: { id: string; status: string; requiresApproval: boolean };
      }>(createMergeRequestRoute, {
        method: "POST",
        path: "/api/v1/profile-merge-requests",
        headers: { ...authHeaders(b), "idempotency-key": createIdempotencyKey },
        body: {
          sourceProfileId: loser,
          targetProfileId: survivor,
          reason: "duplicate detected"
        }
      });
      expect(created.status).toBe(200);
      expect(created.body.data.status).toBe("pending");
      expect(created.body.data.requiresApproval).toBe(true);
      const mergeRequestId = created.body.data.id;

      // Self-approval denied — the owner who created the request cannot also approve it.
      const selfApprove = await invoke(decideMergeRequestRoute, {
        method: "POST",
        path: `/api/v1/profile-merge-requests/${mergeRequestId}/decisions`,
        headers: { ...authHeaders(b), "idempotency-key": crypto.randomUUID() },
        params: { id: mergeRequestId },
        body: { decision: "approved" }
      });
      expect(selfApprove.status).toBe(403);

      const secondUser = await createSecondTenantUser(
        b.tenantId,
        `${b.tenantCode}-second@example.com`
      );
      const secondUserHeaders = {
        "content-type": "application/json",
        "x-awcms-mini-tenant-id": b.tenantId,
        authorization: `Bearer ${secondUser.token}`
      };

      const approved = await invoke<{ data: { status: string } }>(
        decideMergeRequestRoute,
        {
          method: "POST",
          path: `/api/v1/profile-merge-requests/${mergeRequestId}/decisions`,
          headers: {
            ...secondUserHeaders,
            "idempotency-key": crypto.randomUUID()
          },
          params: { id: mergeRequestId },
          body: { decision: "approved" }
        }
      );
      expect(approved.status).toBe(200);
      expect(approved.body.data.status).toBe("approved");

      const executeKey = crypto.randomUUID();
      const executed = await invoke<{
        data: { entityLinksRepointedCount: number; status: string };
      }>(executeMergeRequestRoute, {
        method: "POST",
        path: `/api/v1/profile-merge-requests/${mergeRequestId}/execute`,
        headers: { ...authHeaders(b), "idempotency-key": executeKey },
        params: { id: mergeRequestId }
      });
      expect(executed.status).toBe(200);
      expect(executed.body.data.status).toBe("completed");
      expect(executed.body.data.entityLinksRepointedCount).toBe(1);

      // Entity link repointed to the survivor.
      const links = await admin`
      SELECT profile_id FROM awcms_mini_profile_entity_links
      WHERE tenant_id = ${b.tenantId} AND module_key = 'blog_content'
    `;
      expect(links).toHaveLength(1);
      expect((links[0] as { profile_id: string }).profile_id).toBe(survivor);

      // Loser is soft-deleted with merged_into_profile_id set.
      const loserRow = (await admin`
      SELECT deleted_at, merged_into_profile_id, status FROM awcms_mini_profiles
      WHERE id = ${loser}
    `) as {
        deleted_at: Date | null;
        merged_into_profile_id: string;
        status: string;
      }[];
      expect(loserRow[0]!.deleted_at).not.toBeNull();
      expect(loserRow[0]!.merged_into_profile_id).toBe(survivor);
      expect(loserRow[0]!.status).toBe("merged");

      // Immutable merge history recorded.
      const history = await admin`
      SELECT survivor_profile_id, loser_profile_id, entity_links_repointed_count
      FROM awcms_mini_profile_merge_history WHERE merge_request_id = ${mergeRequestId}
    `;
      expect(history).toHaveLength(1);
      expect(
        (history[0] as { survivor_profile_id: string }).survivor_profile_id
      ).toBe(survivor);

      // Idempotent re-execution with a DIFFERENT Idempotency-Key still returns
      // the already-completed result, not a duplicate merge (concurrency/
      // state-based safety, not just key-based).
      const reExecuted = await invoke<{ data: { status: string } }>(
        executeMergeRequestRoute,
        {
          method: "POST",
          path: `/api/v1/profile-merge-requests/${mergeRequestId}/execute`,
          headers: {
            ...authHeaders(b),
            "idempotency-key": crypto.randomUUID()
          },
          params: { id: mergeRequestId }
        }
      );
      expect(reExecuted.status).toBe(200);
      expect(reExecuted.body.data.status).toBe("completed");

      const historyAfterReExecute = await admin`
      SELECT id FROM awcms_mini_profile_merge_history WHERE merge_request_id = ${mergeRequestId}
    `;
      expect(historyAfterReExecute).toHaveLength(1);

      const listedRequests = await invoke<{ data: { items: unknown[] } }>(
        listMergeRequestsRoute,
        {
          method: "GET",
          path: "/api/v1/profile-merge-requests",
          headers: authHeaders(b)
        }
      );
      expect(listedRequests.status).toBe(200);
    });

    test("PR #777 review follow-up: restoring a merged-away (loser) profile is rejected, not silently resurrected", async () => {
      const b = await bootstrap();
      const survivor = await createTestParty(b, "Survivor");
      const loser = await createTestParty(b, "Loser");

      const created = await invoke<{ data: { id: string } }>(
        createMergeRequestRoute,
        {
          method: "POST",
          path: "/api/v1/profile-merge-requests",
          headers: {
            ...authHeaders(b),
            "idempotency-key": crypto.randomUUID()
          },
          body: {
            sourceProfileId: loser,
            targetProfileId: survivor,
            reason: "duplicate detected"
          }
        }
      );
      const mergeRequestId = created.body.data.id;

      const secondUser = await createSecondTenantUser(
        b.tenantId,
        `${b.tenantCode}-restore-guard@example.com`
      );
      await invoke(decideMergeRequestRoute, {
        method: "POST",
        path: `/api/v1/profile-merge-requests/${mergeRequestId}/decisions`,
        headers: {
          "content-type": "application/json",
          "x-awcms-mini-tenant-id": b.tenantId,
          authorization: `Bearer ${secondUser.token}`,
          "idempotency-key": crypto.randomUUID()
        },
        params: { id: mergeRequestId },
        body: { decision: "approved" }
      });

      const executed = await invoke(executeMergeRequestRoute, {
        method: "POST",
        path: `/api/v1/profile-merge-requests/${mergeRequestId}/execute`,
        headers: { ...authHeaders(b), "idempotency-key": crypto.randomUUID() },
        params: { id: mergeRequestId }
      });
      expect(executed.status).toBe(200);

      // The loser is now soft-deleted with merged_into_profile_id set —
      // restoring it through the ordinary lifecycle endpoint must be
      // rejected, not resurrect a "live" profile with stale merge lineage
      // and zero references.
      const restoreAttempt = await invoke(restoreParty, {
        method: "POST",
        path: `/api/v1/profiles/${loser}/restore`,
        headers: authHeaders(b),
        params: { id: loser }
      });

      expect(restoreAttempt.status).toBe(409);
      expect(
        (restoreAttempt.body as { error: { code: string } }).error.code
      ).toBe("PROFILE_RESTORE_BLOCKED_BY_MERGE");

      const admin = getAdminSql();
      const loserRow = (await admin`
        SELECT deleted_at, merged_into_profile_id FROM awcms_mini_profiles WHERE id = ${loser}
      `) as {
        deleted_at: Date | null;
        merged_into_profile_id: string | null;
      }[];
      expect(loserRow[0]!.deleted_at).not.toBeNull();
      expect(loserRow[0]!.merged_into_profile_id).toBe(survivor);
    });

    test("same Idempotency-Key replays the same response on merge-request create", async () => {
      const b = await bootstrap();
      const survivor = await createTestParty(b, "Survivor");
      const loser = await createTestParty(b, "Loser");
      const key = crypto.randomUUID();
      const body = {
        sourceProfileId: loser,
        targetProfileId: survivor,
        reason: "x"
      };

      const first = await invoke<{ data: { id: string } }>(
        createMergeRequestRoute,
        {
          method: "POST",
          path: "/api/v1/profile-merge-requests",
          headers: { ...authHeaders(b), "idempotency-key": key },
          body
        }
      );
      const second = await invoke<{ data: { id: string } }>(
        createMergeRequestRoute,
        {
          method: "POST",
          path: "/api/v1/profile-merge-requests",
          headers: { ...authHeaders(b), "idempotency-key": key },
          body
        }
      );

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body.data.id).toBe(first.body.data.id);

      const admin = getAdminSql();
      const rows = await admin`
      SELECT id FROM awcms_mini_profile_merge_requests WHERE tenant_id = ${b.tenantId}
    `;
      expect(rows).toHaveLength(1);
    });

    // -------------------------------------------------------------------
    // RLS tenant isolation
    // -------------------------------------------------------------------

    test("RLS: a second tenant with full profile_identity access cannot see the first tenant's parties", async () => {
      const tenantA = await bootstrap("tenant-a", "Tenant A");
      // seedSecondTenantWithProfileIdentityAccess seeds its own "Tenant B
      // User" login profile — tenant B legitimately sees exactly that ONE
      // profile (its own), never tenant A's, so this asserts tenant A's
      // specific party id/name is absent, not that tenant B's list is empty.
      const tenantB =
        await seedSecondTenantWithProfileIdentityAccess("tenant-b");

      const tenantAPartyId = await createTestParty(tenantA, "Tenant A Party");

      const listedByB = await invoke<{
        data: { items: { id: string; displayName: string }[] };
      }>(listParties, {
        method: "GET",
        path: "/api/v1/profiles",
        headers: authHeaders(tenantB)
      });

      expect(listedByB.status).toBe(200);
      expect(
        listedByB.body.data.items.some((item) => item.id === tenantAPartyId)
      ).toBe(false);
      expect(
        listedByB.body.data.items.some(
          (item) => item.displayName === "Tenant A Party"
        )
      ).toBe(false);
    });

    // -------------------------------------------------------------------
    // CRITICAL — cross-tenant merge/match is strictly prohibited
    // -------------------------------------------------------------------

    test("HTTP-level: creating a merge request across two tenants is rejected, not silently empty", async () => {
      const tenantA = await bootstrap("tenant-a2", "Tenant A2");
      const tenantB =
        await seedSecondTenantWithProfileIdentityAccess("tenant-b2");

      const profileInTenantA = await createTestParty(tenantA, "Tenant A Party");
      const profileInTenantBResult = await invoke<{ data: { id: string } }>(
        createParty,
        {
          method: "POST",
          path: "/api/v1/profiles",
          headers: authHeaders(tenantB),
          body: { profileType: "person", displayName: "Tenant B Party" }
        }
      );
      const profileInTenantB = profileInTenantBResult.body.data.id;

      const crossTenantMerge = await invoke(createMergeRequestRoute, {
        method: "POST",
        path: "/api/v1/profile-merge-requests",
        headers: {
          ...authHeaders(tenantA),
          "idempotency-key": crypto.randomUUID()
        },
        body: {
          sourceProfileId: profileInTenantA,
          targetProfileId: profileInTenantB,
          reason: "attempted cross-tenant merge"
        }
      });

      // Tenant B's profile is invisible to tenant A's RLS-scoped session, so
      // this surfaces as an explicit "party not found" rejection (409) — a
      // real, auditable error response, never a silent 200 that would merge
      // across tenants.
      expect(crossTenantMerge.status).toBe(409);
      expect(
        (crossTenantMerge.body as { error: { code: string } }).error.code
      ).toBe("PROFILE_MERGE_PARTY_NOT_FOUND");

      // No merge request row was actually created for tenant A.
      const admin = getAdminSql();
      const rows = await admin`
      SELECT id FROM awcms_mini_profile_merge_requests WHERE tenant_id = ${tenantA.tenantId}
    `;
      expect(rows).toHaveLength(0);
    });

    test("application-layer guard: assertSameTenant/CrossTenantMergeError fires even when RLS is bypassed (defense in depth)", async () => {
      const tenantA = await bootstrap("tenant-a3", "Tenant A3");
      const tenantB =
        await seedSecondTenantWithProfileIdentityAccess("tenant-b3");

      const profileInTenantA = await createTestParty(tenantA, "Tenant A Party");
      const profileInTenantBResult = await invoke<{ data: { id: string } }>(
        createParty,
        {
          method: "POST",
          path: "/api/v1/profiles",
          headers: authHeaders(tenantB),
          body: { profileType: "person", displayName: "Tenant B Party" }
        }
      );
      const profileInTenantB = profileInTenantBResult.body.data.id;

      // Uses the PRIVILEGED (RLS-bypassing) admin connection directly — the
      // one scenario where `fetchPartyForMerge`'s intentionally
      // tenant-filter-free SELECT would actually return a cross-tenant row.
      // This proves `assertSameTenant` (merge.ts) is the real backstop, not
      // just RLS silently emptying the result set.
      const admin = getAdminSql();

      await expect(
        admin.begin(async (tx) => {
          await tx.unsafe(
            `SET LOCAL app.current_tenant_id = '${tenantA.tenantId}'`
          );

          return createMergeRequest(
            tx,
            tenantA.tenantId,
            tenantA.tenantUserId,
            {
              sourceProfileId: profileInTenantA,
              targetProfileId: profileInTenantB,
              reason: "direct application-layer cross-tenant attempt",
              duplicateCandidateId: null
            }
          );
        })
      ).rejects.toBeInstanceOf(CrossTenantMergeError);

      // Same guard at EXECUTION time: manually create an (invalid, cross-
      // tenant) approved merge request row directly via SQL — bypassing
      // createMergeRequest's own guard entirely — and confirm
      // executeMergeRequest still refuses to execute it.
      const mergeRequestId = await admin.begin(async (tx) => {
        await tx.unsafe(
          `SET LOCAL app.current_tenant_id = '${tenantA.tenantId}'`
        );
        const rows = (await tx`
        INSERT INTO awcms_mini_profile_merge_requests
          (tenant_id, source_profile_id, target_profile_id, status, reason, requested_by)
        VALUES (
          ${tenantA.tenantId}, ${profileInTenantA}, ${profileInTenantB}, 'approved',
          'manually seeded cross-tenant row', ${tenantA.tenantUserId}
        )
        RETURNING id
      `) as { id: string }[];
        return rows[0]!.id;
      });

      await expect(
        admin.begin(async (tx) => {
          await tx.unsafe(
            `SET LOCAL app.current_tenant_id = '${tenantA.tenantId}'`
          );

          return executeMergeRequest(
            tx,
            tenantA.tenantId,
            tenantA.tenantUserId,
            mergeRequestId
          );
        })
      ).rejects.toBeInstanceOf(CrossTenantMergeError);

      // Confirm the manually-seeded row was never executed (still 'approved',
      // no history row).
      const finalStatus = (await admin`
      SELECT status FROM awcms_mini_profile_merge_requests WHERE id = ${mergeRequestId}
    `) as { status: string }[];
      expect(finalStatus[0]!.status).toBe("approved");

      const history = await admin`
      SELECT id FROM awcms_mini_profile_merge_history WHERE merge_request_id = ${mergeRequestId}
    `;
      expect(history).toHaveLength(0);
    });
  }
);
