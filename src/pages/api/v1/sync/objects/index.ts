import type { APIRoute } from "astro";
import { fail, ok } from "../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../lib/database/client";
import { withTenant } from "../../../../../lib/database/tenant-context";
import {
  resolveOrRegisterSyncNode,
  verifySyncHeaders
} from "../../../../../modules/sync-storage/application/sync-auth";
import { validateObjectSyncEnqueueRequestBody } from "../../../../../modules/sync-storage/domain/object-queue";

export const POST: APIRoute = async ({ request }) => {
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

  const parsedBody = rawBody.length > 0 ? JSON.parse(rawBody) : null;
  const validation = validateObjectSyncEnqueueRequestBody(parsedBody);

  if (!validation.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Object sync enqueue body is invalid.",
      {},
      validation.errors
    );
  }

  const { objects } = validation.value;
  const requiresUpload = process.env.R2_ENABLED === "true";
  const sql = getDatabaseClient();

  return withTenant(
    sql,
    tenantId,
    async (tx) => {
      const node = await resolveOrRegisterSyncNode(tx, tenantId, nodeCode);

      if (!node || node.status !== "active") {
        return fail(403, "ACCESS_DENIED", "Sync node is not active.");
      }

      for (const object of objects) {
        await tx`
        INSERT INTO awcms_mini_object_sync_queue
          (tenant_id, node_id, object_key, local_path, checksum_sha256, byte_size, requires_upload, status)
        VALUES (
          ${tenantId}, ${node.id}, ${object.objectKey}, ${object.localPath},
          ${object.checksumSha256}, ${object.byteSize}, ${requiresUpload}, 'pending'
        )
        ON CONFLICT (tenant_id, node_id, object_key) DO UPDATE SET
          local_path = ${object.localPath},
          checksum_sha256 = ${object.checksumSha256},
          byte_size = ${object.byteSize},
          requires_upload = ${requiresUpload},
          status = 'pending',
          retry_count = 0,
          next_retry_at = null,
          last_error = null,
          uploaded_at = null
      `;
      }

      return ok({ queued: objects.length });
    },
    { workClass: "background_sync" }
  );
};
