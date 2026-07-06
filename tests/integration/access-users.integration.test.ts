/**
 * Integration tests for the Access & Users management endpoints (PR: admin
 * Access & Users). Exercises the real handlers against a real PostgreSQL via
 * the shared harness — the full auth → ABAC guard → transaction → RLS → audit
 * chain, plus the referential guards and the system-role safety rails.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  integrationEnabled,
  invoke,
  provisionAppRole,
  resetDatabase,
  createCookieJar
} from "./harness";

import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import {
  GET as listUsers,
  POST as createUser
} from "../../src/pages/api/v1/users/index";
import { PATCH as updateUser } from "../../src/pages/api/v1/users/[id]";
import {
  GET as listRoles,
  POST as createRole
} from "../../src/pages/api/v1/roles/index";
import {
  PATCH as updateRole,
  DELETE as deleteRole
} from "../../src/pages/api/v1/roles/[id]";
import { GET as listPermissions } from "../../src/pages/api/v1/permissions/index";
import {
  POST as assignRole,
  DELETE as unassignRole
} from "../../src/pages/api/v1/access/assignments";

const OWNER_LOGIN = "owner@example.com";
const OWNER_PASSWORD = "integration-test-owner-password";

type Bootstrap = { tenantId: string; token: string };

async function bootstrap(): Promise<Bootstrap> {
  const setup = await invoke<{ data: { tenantId: string } }>(setupInitialize, {
    method: "POST",
    path: "/api/v1/setup/initialize",
    headers: { "content-type": "application/json" },
    body: {
      tenantName: "Acme",
      tenantCode: "acme",
      officeCode: "hq",
      officeName: "HQ",
      ownerLoginIdentifier: OWNER_LOGIN,
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
    body: { loginIdentifier: OWNER_LOGIN, password: OWNER_PASSWORD },
    cookies: createCookieJar()
  });
  expect(login.status).toBe(200);

  return { tenantId: setup.body.data.tenantId, token: login.body.data.token };
}

function authHeaders(b: Bootstrap): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-awcms-mini-tenant-id": b.tenantId,
    authorization: `Bearer ${b.token}`
  };
}

const suite = integrationEnabled ? describe : describe.skip;

suite("Access & Users API (real Postgres)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  test("lists the owner user with the owner role", async () => {
    const b = await bootstrap();
    const res = await invoke<{
      data: {
        users: {
          loginIdentifier: string;
          roles: { roleCode: string }[];
          status: string;
        }[];
      };
    }>(listUsers, {
      method: "GET",
      path: "/api/v1/users",
      headers: authHeaders(b)
    });
    expect(res.status).toBe(200);
    expect(res.body.data.users).toHaveLength(1);
    expect(res.body.data.users[0]!.loginIdentifier).toBe(OWNER_LOGIN);
    expect(res.body.data.users[0]!.roles.map((r) => r.roleCode)).toContain(
      "owner"
    );
  });

  test("creates a user, lists it, then deactivating it blocks login", async () => {
    const b = await bootstrap();

    const created = await invoke<{ data: { tenantUserId: string } }>(
      createUser,
      {
        method: "POST",
        path: "/api/v1/users",
        headers: authHeaders(b),
        body: {
          displayName: "Staff One",
          loginIdentifier: "staff@example.com",
          password: "staff-password-123"
        }
      }
    );
    expect(created.status).toBe(200);
    const tenantUserId = created.body.data.tenantUserId;

    // Duplicate login identifier -> 409.
    const dup = await invoke<{ error: { code: string } }>(createUser, {
      method: "POST",
      path: "/api/v1/users",
      headers: authHeaders(b),
      body: {
        displayName: "Staff Dup",
        loginIdentifier: "staff@example.com",
        password: "another-password-123"
      }
    });
    expect(dup.status).toBe(409);

    // New user can log in while active.
    const okLogin = await invoke<{ data: { token: string } }>(authLogin, {
      method: "POST",
      path: "/api/v1/auth/login",
      headers: {
        "content-type": "application/json",
        "x-awcms-mini-tenant-id": b.tenantId
      },
      body: {
        loginIdentifier: "staff@example.com",
        password: "staff-password-123"
      },
      cookies: createCookieJar()
    });
    expect(okLogin.status).toBe(200);

    // Deactivate -> login now denied.
    const deactivated = await invoke(updateUser, {
      method: "PATCH",
      path: `/api/v1/users/${tenantUserId}`,
      params: { id: tenantUserId },
      headers: authHeaders(b),
      body: { status: "inactive" }
    });
    expect(deactivated.status).toBe(200);

    const blocked = await invoke<{ error: { code: string } }>(authLogin, {
      method: "POST",
      path: "/api/v1/auth/login",
      headers: {
        "content-type": "application/json",
        "x-awcms-mini-tenant-id": b.tenantId
      },
      body: {
        loginIdentifier: "staff@example.com",
        password: "staff-password-123"
      },
      cookies: createCookieJar()
    });
    expect(blocked.status).toBe(401);
  });

  test("full role lifecycle: create, edit permissions, assign, unassign, delete", async () => {
    const b = await bootstrap();

    const perms = await invoke<{
      data: { permissions: { permissionId: string; key: string }[] };
    }>(listPermissions, {
      method: "GET",
      path: "/api/v1/permissions",
      headers: authHeaders(b)
    });
    expect(perms.status).toBe(200);
    expect(perms.body.data.permissions.length).toBeGreaterThan(0);
    const readProfiles = perms.body.data.permissions.find(
      (p) => p.key === "profile_identity.profile_management.read"
    )!;

    const role = await invoke<{ data: { roleId: string } }>(createRole, {
      method: "POST",
      path: "/api/v1/roles",
      headers: authHeaders(b),
      body: {
        roleCode: "viewer",
        roleName: "Viewer",
        permissionIds: [readProfiles.permissionId]
      }
    });
    expect(role.status).toBe(200);
    const roleId = role.body.data.roleId;

    const roles = await invoke<{
      data: {
        roles: {
          roleId: string;
          roleCode: string;
          permissionIds: string[];
          isSystem: boolean;
        }[];
      };
    }>(listRoles, {
      method: "GET",
      path: "/api/v1/roles",
      headers: authHeaders(b)
    });
    const viewer = roles.body.data.roles.find((r) => r.roleCode === "viewer")!;
    expect(viewer.permissionIds).toEqual([readProfiles.permissionId]);
    expect(viewer.isSystem).toBe(false);

    // Edit: clear the permission set.
    const edited = await invoke(updateRole, {
      method: "PATCH",
      path: `/api/v1/roles/${roleId}`,
      params: { id: roleId },
      headers: authHeaders(b),
      body: { roleName: "Viewer Renamed", permissionIds: [] }
    });
    expect(edited.status).toBe(200);

    // Create a user and assign the role, then unassign it.
    const user = await invoke<{ data: { tenantUserId: string } }>(createUser, {
      method: "POST",
      path: "/api/v1/users",
      headers: authHeaders(b),
      body: {
        displayName: "Assignee",
        loginIdentifier: "assignee@example.com",
        password: "assignee-password-1"
      }
    });
    const tenantUserId = user.body.data.tenantUserId;

    const assigned = await invoke(assignRole, {
      method: "POST",
      path: "/api/v1/access/assignments",
      headers: authHeaders(b),
      body: { tenantUserId, roleId }
    });
    expect(assigned.status).toBe(200);

    // Cannot delete a role that is still assigned.
    const blockedDelete = await invoke<{ error: { code: string } }>(
      deleteRole,
      {
        method: "DELETE",
        path: `/api/v1/roles/${roleId}`,
        params: { id: roleId },
        headers: authHeaders(b),
        body: { reason: "cleanup" }
      }
    );
    expect(blockedDelete.status).toBe(409);

    const unassigned = await invoke(unassignRole, {
      method: "DELETE",
      path: "/api/v1/access/assignments",
      headers: authHeaders(b),
      body: { tenantUserId, roleId }
    });
    expect(unassigned.status).toBe(200);

    const deleted = await invoke(deleteRole, {
      method: "DELETE",
      path: `/api/v1/roles/${roleId}`,
      params: { id: roleId },
      headers: authHeaders(b),
      body: { reason: "cleanup" }
    });
    expect(deleted.status).toBe(200);
  });

  test("system owner role is protected from permission edits and deletion", async () => {
    const b = await bootstrap();
    const roles = await invoke<{
      data: { roles: { roleId: string; roleCode: string }[] };
    }>(listRoles, {
      method: "GET",
      path: "/api/v1/roles",
      headers: authHeaders(b)
    });
    const owner = roles.body.data.roles.find((r) => r.roleCode === "owner")!;

    const editPerms = await invoke<{ error: { code: string } }>(updateRole, {
      method: "PATCH",
      path: `/api/v1/roles/${owner.roleId}`,
      params: { id: owner.roleId },
      headers: authHeaders(b),
      body: { permissionIds: [] }
    });
    expect(editPerms.status).toBe(409);

    const del = await invoke<{ error: { code: string } }>(deleteRole, {
      method: "DELETE",
      path: `/api/v1/roles/${owner.roleId}`,
      params: { id: owner.roleId },
      headers: authHeaders(b),
      body: { reason: "attempted cleanup" }
    });
    expect(del.status).toBe(409);
  });

  test("default-deny: a role-less user cannot list users", async () => {
    const b = await bootstrap();

    // Create a user with no roles, log in as them.
    await invoke(createUser, {
      method: "POST",
      path: "/api/v1/users",
      headers: authHeaders(b),
      body: {
        displayName: "No Role",
        loginIdentifier: "norole@example.com",
        password: "norole-password-1"
      }
    });
    const login = await invoke<{ data: { token: string } }>(authLogin, {
      method: "POST",
      path: "/api/v1/auth/login",
      headers: {
        "content-type": "application/json",
        "x-awcms-mini-tenant-id": b.tenantId
      },
      body: {
        loginIdentifier: "norole@example.com",
        password: "norole-password-1"
      },
      cookies: createCookieJar()
    });

    const denied = await invoke<{ error: { code: string } }>(listUsers, {
      method: "GET",
      path: "/api/v1/users",
      headers: {
        "x-awcms-mini-tenant-id": b.tenantId,
        authorization: `Bearer ${login.body.data.token}`
      }
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("ACCESS_DENIED");
  });

  // Issue #435 (performance audit): role_permissions/access_assignments
  // inserts were rewritten from one INSERT-per-item loop to a single batched
  // `unnest(...)`-based INSERT (skill `awcms-mini-performance` §Hindari
  // N+1). These exercise multi-item arrays end-to-end against real
  // PostgreSQL to prove the batched statement still creates every row (not
  // just the first) and still respects ON CONFLICT DO NOTHING for repeats.
  test("role create/update with multiple permissionIds batches correctly", async () => {
    const b = await bootstrap();

    const perms = await invoke<{
      data: { permissions: { permissionId: string; key: string }[] };
    }>(listPermissions, {
      method: "GET",
      path: "/api/v1/permissions",
      headers: authHeaders(b)
    });
    const permissionIds = perms.body.data.permissions
      .slice(0, 3)
      .map((p) => p.permissionId);
    expect(permissionIds.length).toBe(3);

    const role = await invoke<{ data: { roleId: string } }>(createRole, {
      method: "POST",
      path: "/api/v1/roles",
      headers: authHeaders(b),
      body: {
        roleCode: "multi_perm",
        roleName: "Multi Perm",
        // Duplicate the first id to also prove ON CONFLICT DO NOTHING
        // tolerates a repeat within the same batch.
        permissionIds: [...permissionIds, permissionIds[0]]
      }
    });
    expect(role.status).toBe(200);
    const roleId = role.body.data.roleId;

    const rolesAfterCreate = await invoke<{
      data: { roles: { roleId: string; permissionIds: string[] }[] };
    }>(listRoles, {
      method: "GET",
      path: "/api/v1/roles",
      headers: authHeaders(b)
    });
    const created = rolesAfterCreate.body.data.roles.find(
      (r) => r.roleId === roleId
    )!;
    expect(new Set(created.permissionIds)).toEqual(new Set(permissionIds));
    expect(created.permissionIds.length).toBe(3);

    const allPermissionIds = perms.body.data.permissions.map(
      (p) => p.permissionId
    );
    const updated = await invoke(updateRole, {
      method: "PATCH",
      path: `/api/v1/roles/${roleId}`,
      params: { id: roleId },
      headers: authHeaders(b),
      body: { permissionIds: allPermissionIds }
    });
    expect(updated.status).toBe(200);

    const rolesAfterUpdate = await invoke<{
      data: { roles: { roleId: string; permissionIds: string[] }[] };
    }>(listRoles, {
      method: "GET",
      path: "/api/v1/roles",
      headers: authHeaders(b)
    });
    const afterUpdate = rolesAfterUpdate.body.data.roles.find(
      (r) => r.roleId === roleId
    )!;
    expect(new Set(afterUpdate.permissionIds)).toEqual(
      new Set(allPermissionIds)
    );
  });

  test("user create with multiple roleIds batches correctly", async () => {
    const b = await bootstrap();

    const roleA = await invoke<{ data: { roleId: string } }>(createRole, {
      method: "POST",
      path: "/api/v1/roles",
      headers: authHeaders(b),
      body: { roleCode: "role_a", roleName: "Role A", permissionIds: [] }
    });
    const roleB = await invoke<{ data: { roleId: string } }>(createRole, {
      method: "POST",
      path: "/api/v1/roles",
      headers: authHeaders(b),
      body: { roleCode: "role_b", roleName: "Role B", permissionIds: [] }
    });
    const roleIds = [roleA.body.data.roleId, roleB.body.data.roleId];

    const user = await invoke<{ data: { tenantUserId: string } }>(createUser, {
      method: "POST",
      path: "/api/v1/users",
      headers: authHeaders(b),
      body: {
        displayName: "Multi Role",
        loginIdentifier: "multirole@example.com",
        password: "multirole-password-1",
        roleIds
      }
    });
    expect(user.status).toBe(200);

    const users = await invoke<{
      data: {
        users: {
          tenantUserId: string;
          roles: { roleId: string }[];
        }[];
      };
    }>(listUsers, {
      method: "GET",
      path: "/api/v1/users",
      headers: authHeaders(b)
    });
    const created = users.body.data.users.find(
      (u) => u.tenantUserId === user.body.data.tenantUserId
    )!;
    expect(new Set(created.roles.map((r) => r.roleId))).toEqual(
      new Set(roleIds)
    );
  });
});
