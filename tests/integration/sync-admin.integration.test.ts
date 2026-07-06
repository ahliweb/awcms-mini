/**
 * Integration tests for the admin-facing Sync endpoints (PR: Sync admin ops
 * dashboard). Exercises the real handlers against a real PostgreSQL via the
 * shared harness — nodes list/activate-deactivate, conflict list/resolve
 * (now cookie-or-header + audited), and object queue list/manual-retry.
 *
 * Fixture nodes/conflicts/object-queue rows are seeded directly via the
 * privileged `getAdminSql()` client (same pattern as the cross-tenant RLS
 * fixture in api.integration.test.ts) rather than driving the full HMAC
 * push/pull flow, since these admin endpoints only read/mutate rows that
 * already exist — how they got there is out of scope here (see
 * sync-storage.test.ts for HMAC signature coverage).
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  getAdminSql,
  integrationEnabled,
  invoke,
  provisionAppRole,
  resetDatabase,
  createCookieJar
} from "./harness";

import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import { GET as listNodes } from "../../src/pages/api/v1/sync/nodes/index";
import { PATCH as patchNode } from "../../src/pages/api/v1/sync/nodes/[id]";
import { GET as listConflicts } from "../../src/pages/api/v1/sync/conflicts/index";
import { POST as resolveConflict } from "../../src/pages/api/v1/sync/conflicts/[id]/resolve";
import { GET as listObjectQueue } from "../../src/pages/api/v1/sync/object-queue/index";
import { POST as retryObject } from "../../src/pages/api/v1/sync/object-queue/[id]/retry";
import { GET as auditLog } from "../../src/pages/api/v1/logs/audit";

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

async function seedNode(tenantId: string, nodeCode: string): Promise<string> {
  const admin = getAdminSql();
  const rows = await admin.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);
    return tx`
      INSERT INTO awcms_mini_sync_nodes (tenant_id, node_code, node_name)
      VALUES (${tenantId}, ${nodeCode}, ${nodeCode})
      RETURNING id
    `;
  });
  return (rows as { id: string }[])[0]!.id;
}

const suite = integrationEnabled ? describe : describe.skip;

suite("Sync admin API (real Postgres)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  test("lists sync nodes and deactivates one", async () => {
    const b = await bootstrap();
    const nodeId = await seedNode(b.tenantId, "till-1");

    const listed = await invoke<{
      data: { nodes: { nodeId: string; nodeCode: string; status: string }[] };
    }>(listNodes, {
      method: "GET",
      path: "/api/v1/sync/nodes",
      headers: authHeaders(b)
    });
    expect(listed.status).toBe(200);
    expect(listed.body.data.nodes).toHaveLength(1);
    expect(listed.body.data.nodes[0]!.nodeCode).toBe("till-1");
    expect(listed.body.data.nodes[0]!.status).toBe("active");

    const updated = await invoke(patchNode, {
      method: "PATCH",
      path: `/api/v1/sync/nodes/${nodeId}`,
      params: { id: nodeId },
      headers: authHeaders(b),
      body: { status: "inactive" }
    });
    expect(updated.status).toBe(200);

    const relisted = await invoke<{
      data: { nodes: { nodeId: string; status: string }[] };
    }>(listNodes, {
      method: "GET",
      path: "/api/v1/sync/nodes",
      headers: authHeaders(b)
    });
    expect(
      relisted.body.data.nodes.find((n) => n.nodeId === nodeId)?.status
    ).toBe("inactive");
  });

  test("PATCH with an empty body is rejected", async () => {
    const b = await bootstrap();
    const nodeId = await seedNode(b.tenantId, "till-2");

    const rejected = await invoke<{ error: { code: string } }>(patchNode, {
      method: "PATCH",
      path: `/api/v1/sync/nodes/${nodeId}`,
      params: { id: nodeId },
      headers: authHeaders(b),
      body: {}
    });
    expect(rejected.status).toBe(400);
  });

  test("conflict list + resolve now accepts cookie auth and writes an audit event", async () => {
    const b = await bootstrap();
    const nodeId = await seedNode(b.tenantId, "till-1");

    const admin = getAdminSql();
    const conflictRows = await admin.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL app.current_tenant_id = '${b.tenantId}'`);
      return tx`
        INSERT INTO awcms_mini_sync_conflicts
          (tenant_id, node_id, batch_id, aggregate_type, aggregate_id, conflict_type, payload_json)
        VALUES (
          ${b.tenantId}, ${nodeId}, 'batch-1', 'profile', gen_random_uuid(),
          'version_mismatch', '{"example":true}'::jsonb
        )
        RETURNING id
      `;
    });
    const conflictId = (conflictRows as { id: string }[])[0]!.id;

    // Cookie-authenticated (not bearer header) list — proves the refactor.
    // Logging in again here (bearer token from bootstrap() is a separate
    // session row) issues fresh httpOnly cookies via the cookie jar.
    const cookies = createCookieJar();
    const cookieLogin = await invoke(authLogin, {
      method: "POST",
      path: "/api/v1/auth/login",
      headers: {
        "content-type": "application/json",
        "x-awcms-mini-tenant-id": b.tenantId
      },
      body: { loginIdentifier: OWNER_LOGIN, password: OWNER_PASSWORD },
      cookies
    });
    expect(cookieLogin.status).toBe(200);

    const listed = await invoke<{
      data: { conflicts: { id: string; status: string }[] };
    }>(listConflicts, {
      method: "GET",
      path: "/api/v1/sync/conflicts",
      cookies
    });
    expect(listed.status).toBe(200);
    expect(listed.body.data.conflicts).toHaveLength(1);
    expect(listed.body.data.conflicts[0]!.id).toBe(conflictId);

    const resolved = await invoke(resolveConflict, {
      method: "POST",
      path: `/api/v1/sync/conflicts/${conflictId}/resolve`,
      params: { id: conflictId },
      cookies,
      headers: { "content-type": "application/json" },
      body: { resolution: "accept_incoming", note: "verified manually" }
    });
    expect(resolved.status).toBe(200);

    // Re-resolving an already-resolved conflict is rejected (immutable).
    const reResolved = await invoke<{ error: { code: string } }>(
      resolveConflict,
      {
        method: "POST",
        path: `/api/v1/sync/conflicts/${conflictId}/resolve`,
        params: { id: conflictId },
        cookies,
        headers: { "content-type": "application/json" },
        body: { resolution: "keep_existing" }
      }
    );
    expect(reResolved.status).toBe(409);

    // The previously-missing audit event now exists.
    const audit = await invoke<{
      data: { events: { action: string; resourceType: string }[] };
    }>(auditLog, {
      method: "GET",
      path: "/api/v1/logs/audit",
      headers: authHeaders(b)
    });
    expect(
      audit.body.data.events.some(
        (e) => e.action === "approve" && e.resourceType === "sync_conflict"
      )
    ).toBe(true);
  });

  test("object queue: lists entries and manually retries a failed one", async () => {
    const b = await bootstrap();
    const nodeId = await seedNode(b.tenantId, "till-1");

    const admin = getAdminSql();
    const queueRows = await admin.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL app.current_tenant_id = '${b.tenantId}'`);
      return tx`
        INSERT INTO awcms_mini_object_sync_queue
          (tenant_id, node_id, object_key, local_path, checksum_sha256, byte_size,
           requires_upload, status, retry_count, last_error)
        VALUES (
          ${b.tenantId}, ${nodeId}, 'receipts/1.pdf', '/tmp/1.pdf',
          repeat('a', 64), 1024, true, 'failed', 5, 'connection reset'
        )
        RETURNING id
      `;
    });
    const objectQueueId = (queueRows as { id: string }[])[0]!.id;

    const listed = await invoke<{
      data: {
        objects: { objectQueueId: string; status: string; nodeCode: string }[];
      };
    }>(listObjectQueue, {
      method: "GET",
      path: "/api/v1/sync/object-queue?status=failed",
      headers: authHeaders(b)
    });
    expect(listed.status).toBe(200);
    expect(listed.body.data.objects).toHaveLength(1);
    expect(listed.body.data.objects[0]!.objectQueueId).toBe(objectQueueId);
    expect(listed.body.data.objects[0]!.nodeCode).toBe("till-1");

    const retried = await invoke<{ data: { status: string } }>(retryObject, {
      method: "POST",
      path: `/api/v1/sync/object-queue/${objectQueueId}/retry`,
      params: { id: objectQueueId },
      headers: authHeaders(b)
    });
    expect(retried.status).toBe(200);
    expect(retried.body.data.status).toBe("pending");

    // Retrying again (now pending, not failed) is rejected.
    const secondRetry = await invoke<{ error: { code: string } }>(retryObject, {
      method: "POST",
      path: `/api/v1/sync/object-queue/${objectQueueId}/retry`,
      params: { id: objectQueueId },
      headers: authHeaders(b)
    });
    expect(secondRetry.status).toBe(409);
  });

  // Issue #435 (performance audit): `GET /api/v1/sync/object-queue` gained
  // keyset (`created_at, id`) cursor pagination on top of its existing
  // 200-row page size (`OBJECT_QUEUE_LIMIT`), and the query was restructured
  // to `LIMIT` before joining to `awcms_mini_sync_nodes` (see
  // `fetchObjectQueueEntries` in `sync-directory.ts` for why — a planner
  // cost-estimation quirk otherwise made it prefer a full Seq Scan/sort even
  // with the right index in place). Seeds past 200 rows directly via SQL.
  test("object queue pages past the first 200 via nextCursor, oldest never repeated", async () => {
    const b = await bootstrap();
    const nodeId = await seedNode(b.tenantId, "till-2");

    const admin = getAdminSql();
    await admin.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL app.current_tenant_id = '${b.tenantId}'`);
      await tx`
        INSERT INTO awcms_mini_object_sync_queue
          (tenant_id, node_id, object_key, local_path, checksum_sha256, byte_size,
           requires_upload, status, created_at)
        SELECT ${b.tenantId}, ${nodeId}, 'obj-' || gs, '/tmp/' || gs, repeat('a', 64),
               1024, false, 'pending', now() - (gs || ' seconds')::interval
        FROM generate_series(1, 205) AS gs
      `;
    });

    const page1 = await invoke<{
      data: {
        objects: { objectQueueId: string }[];
        nextCursor: string | null;
      };
    }>(listObjectQueue, {
      method: "GET",
      path: "/api/v1/sync/object-queue",
      headers: authHeaders(b)
    });
    expect(page1.status).toBe(200);
    expect(page1.body.data.objects).toHaveLength(200);
    expect(page1.body.data.nextCursor).not.toBeNull();

    const page2 = await invoke<{
      data: {
        objects: { objectQueueId: string }[];
        nextCursor: string | null;
      };
    }>(listObjectQueue, {
      method: "GET",
      path: `/api/v1/sync/object-queue?cursor=${encodeURIComponent(page1.body.data.nextCursor!)}`,
      headers: authHeaders(b)
    });
    expect(page2.status).toBe(200);
    expect(page2.body.data.objects).toHaveLength(5);
    expect(page2.body.data.nextCursor).toBeNull();

    const page1Ids = new Set(
      page1.body.data.objects.map((o) => o.objectQueueId)
    );
    for (const entry of page2.body.data.objects) {
      expect(page1Ids.has(entry.objectQueueId)).toBe(false);
    }
  });

  test("default-deny: a role-less user cannot list sync nodes, conflicts, or object queue", async () => {
    const b = await bootstrap();

    const sql = getAdminSql();
    const passwordHash = await Bun.password.hash("norole-password-123456");
    const noRoleRows = await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL app.current_tenant_id = '${b.tenantId}'`);
      const profile = (await tx`
        INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
        VALUES (${b.tenantId}, 'person', 'No Role') RETURNING id
      `) as { id: string }[];
      const identity = (await tx`
        INSERT INTO awcms_mini_identities (tenant_id, profile_id, login_identifier, password_hash)
        VALUES (${b.tenantId}, ${profile[0]!.id}, 'norole-sync@example.com', ${passwordHash})
        RETURNING id
      `) as { id: string }[];
      await tx`
        INSERT INTO awcms_mini_tenant_users (tenant_id, identity_id)
        VALUES (${b.tenantId}, ${identity[0]!.id})
      `;
      return identity;
    });
    void noRoleRows;

    const login = await invoke<{ data: { token: string } }>(authLogin, {
      method: "POST",
      path: "/api/v1/auth/login",
      headers: {
        "content-type": "application/json",
        "x-awcms-mini-tenant-id": b.tenantId
      },
      body: {
        loginIdentifier: "norole-sync@example.com",
        password: "norole-password-123456"
      },
      cookies: createCookieJar()
    });
    expect(login.status).toBe(200);
    const headers = {
      "x-awcms-mini-tenant-id": b.tenantId,
      authorization: `Bearer ${login.body.data.token}`
    };

    const nodes = await invoke<{ error: { code: string } }>(listNodes, {
      method: "GET",
      path: "/api/v1/sync/nodes",
      headers
    });
    expect(nodes.status).toBe(403);

    const conflicts = await invoke<{ error: { code: string } }>(listConflicts, {
      method: "GET",
      path: "/api/v1/sync/conflicts",
      headers
    });
    expect(conflicts.status).toBe(403);

    const objects = await invoke<{ error: { code: string } }>(listObjectQueue, {
      method: "GET",
      path: "/api/v1/sync/object-queue",
      headers
    });
    expect(objects.status).toBe(403);
  });
});
