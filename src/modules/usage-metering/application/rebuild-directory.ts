/**
 * Aggregate rebuild request + aggregation-cursor status (Issue #875, epic #868,
 * ADR-0022). An operator REQUESTS a deterministic rebuild by flagging the
 * cursor; the aggregation worker consumes the flag on its next run and
 * recomputes every window from the immutable source (a rebuild reproduces the
 * stored aggregates). The request is idempotent + audited; it never mutates the
 * checkpoint or any usage record itself.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";

const MODULE_KEY = "usage_metering";

export async function requestAggregateRebuild(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  correlationId?: string
): Promise<{ requestedAt: string }> {
  const rows = (await tx`
    INSERT INTO awcms_mini_usage_aggregation_cursors (tenant_id, shard_key, rebuild_requested_at)
    VALUES (${tenantId}, 'default', now())
    ON CONFLICT (tenant_id, shard_key)
    DO UPDATE SET rebuild_requested_at = now(), updated_at = now()
    RETURNING rebuild_requested_at
  `) as { rebuild_requested_at: Date }[];

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "rebuild",
    resourceType: "usage_aggregation_cursor",
    severity: "warning",
    message:
      "Usage aggregate rebuild requested (full deterministic recompute from immutable events).",
    attributes: { shardKey: "default" },
    correlationId
  });

  return { requestedAt: rows[0]!.rebuild_requested_at.toISOString() };
}

export type AggregationStatusDto = {
  checkpointSeq: number;
  status: string;
  lastRunAt: string | null;
  processedEventTotal: number;
  rebuildRequestedAt: string | null;
  rebuildCount: number;
  consecutiveFailures: number;
  leaseHolder: string | null;
  leaseExpiresAt: string | null;
};

export async function getAggregationStatus(
  tx: Bun.SQL,
  tenantId: string
): Promise<AggregationStatusDto | null> {
  const rows = (await tx`
    SELECT checkpoint_seq, status, last_run_at, processed_event_total,
      rebuild_requested_at, rebuild_count, consecutive_failures, lease_holder, lease_expires_at
    FROM awcms_mini_usage_aggregation_cursors
    WHERE tenant_id = ${tenantId} AND shard_key = 'default'
  `) as {
    checkpoint_seq: number | string;
    status: string;
    last_run_at: Date | null;
    processed_event_total: number | string;
    rebuild_requested_at: Date | null;
    rebuild_count: number | string;
    consecutive_failures: number | string;
    lease_holder: string | null;
    lease_expires_at: Date | null;
  }[];
  if (!rows[0]) {
    return null;
  }
  const row = rows[0];
  return {
    checkpointSeq: Number(row.checkpoint_seq),
    status: row.status,
    lastRunAt: row.last_run_at?.toISOString() ?? null,
    processedEventTotal: Number(row.processed_event_total),
    rebuildRequestedAt: row.rebuild_requested_at?.toISOString() ?? null,
    rebuildCount: Number(row.rebuild_count),
    consecutiveFailures: Number(row.consecutive_failures),
    leaseHolder: row.lease_holder,
    leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null
  };
}
