import type { APIRoute } from "astro";
import { fail, ok } from "../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../lib/database/client";
import { withTenant } from "../../../../lib/database/tenant-context";
import {
  resolveOrRegisterSyncNode,
  verifySyncHeaders
} from "../../../../modules/sync-storage/application/sync-auth";
import { evaluatePushEventConflict } from "../../../../modules/sync-storage/domain/sync-conflict";
import { validateSyncPushRequestBody } from "../../../../modules/sync-storage/domain/sync-validation";

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
  const validation = validateSyncPushRequestBody(parsedBody);

  if (!validation.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Sync push body is invalid.",
      {},
      validation.errors
    );
  }

  const { batchId, events } = validation.value;
  const sql = getDatabaseClient();

  return withTenant(sql, tenantId, async (tx) => {
    const node = await resolveOrRegisterSyncNode(tx, tenantId, nodeCode);

    if (!node || node.status !== "active") {
      return fail(403, "ACCESS_DENIED", "Sync node is not active.");
    }

    const existingBatch = await tx`
      SELECT event_count, conflicted_count FROM awcms_mini_sync_push_batches
      WHERE tenant_id = ${tenantId} AND node_id = ${node.id} AND batch_id = ${batchId}
    `;

    if (existingBatch[0]) {
      const total = existingBatch[0].event_count as number;
      const conflicted = existingBatch[0].conflicted_count as number;

      return ok({
        batchId,
        accepted: total - conflicted,
        conflicted,
        duplicate: true
      });
    }

    let acceptedCount = 0;
    let conflictedCount = 0;

    for (const event of events) {
      if (event.aggregateId === undefined) {
        await tx`
          INSERT INTO awcms_mini_sync_inbox
            (tenant_id, node_id, batch_id, event_type, aggregate_type, aggregate_id, payload_json)
          VALUES (
            ${tenantId}, ${node.id}, ${batchId}, ${event.eventType}, ${event.aggregateType},
            null, ${JSON.stringify(event.payload)}
          )
        `;
        acceptedCount += 1;
        continue;
      }

      const versionRows = await tx`
        SELECT current_version FROM awcms_mini_sync_aggregate_versions
        WHERE tenant_id = ${tenantId} AND aggregate_type = ${event.aggregateType}
          AND aggregate_id = ${event.aggregateId}
      `;
      const currentVersion = versionRows[0]
        ? Number(versionRows[0].current_version)
        : 0;
      const evaluation = evaluatePushEventConflict(
        currentVersion,
        event.baseVersion
      );

      if (evaluation.conflict) {
        await tx`
          INSERT INTO awcms_mini_sync_conflicts
            (tenant_id, node_id, batch_id, aggregate_type, aggregate_id, conflict_type, payload_json)
          VALUES (
            ${tenantId}, ${node.id}, ${batchId}, ${event.aggregateType}, ${event.aggregateId},
            ${evaluation.conflictType}, ${JSON.stringify(event.payload)}
          )
        `;
        conflictedCount += 1;
        continue;
      }

      await tx`
        INSERT INTO awcms_mini_sync_inbox
          (tenant_id, node_id, batch_id, event_type, aggregate_type, aggregate_id, payload_json)
        VALUES (
          ${tenantId}, ${node.id}, ${batchId}, ${event.eventType}, ${event.aggregateType},
          ${event.aggregateId}, ${JSON.stringify(event.payload)}
        )
      `;

      await tx`
        INSERT INTO awcms_mini_sync_aggregate_versions (tenant_id, aggregate_type, aggregate_id, current_version)
        VALUES (${tenantId}, ${event.aggregateType}, ${event.aggregateId}, ${currentVersion + 1})
        ON CONFLICT (tenant_id, aggregate_type, aggregate_id)
        DO UPDATE SET current_version = ${currentVersion + 1}, updated_at = now()
      `;
      acceptedCount += 1;
    }

    await tx`
      INSERT INTO awcms_mini_sync_push_batches (tenant_id, node_id, batch_id, event_count, conflicted_count)
      VALUES (${tenantId}, ${node.id}, ${batchId}, ${events.length}, ${conflictedCount})
    `;

    await tx`
      UPDATE awcms_mini_sync_nodes SET last_pushed_at = now() WHERE id = ${node.id}
    `;

    return ok({
      batchId,
      accepted: acceptedCount,
      conflicted: conflictedCount,
      duplicate: false
    });
  });
};
