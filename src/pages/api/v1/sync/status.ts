import type { APIRoute } from "astro";
import { fail, ok } from "../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../lib/database/client";
import { withTenant } from "../../../../lib/database/tenant-context";
import {
  resolveOrRegisterSyncNode,
  verifySyncHeaders
} from "../../../../modules/sync-storage/application/sync-auth";

export const GET: APIRoute = async ({ request }) => {
  const tenantId = request.headers.get("x-awcms-mini-tenant-id");
  const nodeCode = request.headers.get("x-awcms-mini-node-id");

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  if (!nodeCode) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "X-AWCMS-Mini-Node-ID header is required."
    );
  }

  const rawBody = await request.text();
  const authResult = verifySyncHeaders(
    request.headers.get("x-awcms-mini-timestamp"),
    request.headers.get("x-awcms-mini-signature"),
    rawBody
  );

  if (!authResult.ok) {
    return fail(authResult.status, authResult.code, authResult.message);
  }

  const sql = getDatabaseClient();

  return withTenant(sql, tenantId, async (tx) => {
    const node = await resolveOrRegisterSyncNode(tx, tenantId, nodeCode);

    if (!node || node.status !== "active") {
      return fail(403, "ACCESS_DENIED", "Sync node is not active.");
    }

    const rows = await tx`
      SELECT node_code, status, last_pushed_at, last_pulled_at, last_pull_sequence
      FROM awcms_mini_sync_nodes
      WHERE id = ${node.id}
    `;
    const row = rows[0] as {
      node_code: string;
      status: string;
      last_pushed_at: Date | null;
      last_pulled_at: Date | null;
      last_pull_sequence: number;
    };

    return ok({
      nodeCode: row.node_code,
      status: row.status,
      lastPushedAt: row.last_pushed_at?.toISOString(),
      lastPulledAt: row.last_pulled_at?.toISOString(),
      checkpoint: row.last_pull_sequence
    });
  });
};
