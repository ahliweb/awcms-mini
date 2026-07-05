/**
 * Read-side queries shared by the admin sync endpoints
 * (`/api/v1/sync/nodes`, `/api/v1/sync/object-queue`) and the future
 * `/admin/sync` SSR page — same pattern as
 * `identity-access/application/user-directory.ts` being shared between the
 * Access & Users endpoints and `admin/access-users.astro`.
 */

export type SyncNodeSummary = {
  nodeId: string;
  nodeCode: string;
  nodeName: string;
  status: "active" | "inactive";
  lastPushedAt: string | null;
  lastPulledAt: string | null;
  lastPullSequence: number;
  createdAt: string;
};

type SyncNodeRow = {
  id: string;
  node_code: string;
  node_name: string;
  status: "active" | "inactive";
  last_pushed_at: Date | null;
  last_pulled_at: Date | null;
  last_pull_sequence: string | number;
  created_at: Date;
};

export async function fetchSyncNodes(
  tx: Bun.SQL,
  tenantId: string
): Promise<SyncNodeSummary[]> {
  const rows = (await tx`
    SELECT id, node_code, node_name, status, last_pushed_at, last_pulled_at,
           last_pull_sequence, created_at
    FROM awcms_mini_sync_nodes
    WHERE tenant_id = ${tenantId}
    ORDER BY node_name ASC
  `) as SyncNodeRow[];

  return rows.map((row) => ({
    nodeId: row.id,
    nodeCode: row.node_code,
    nodeName: row.node_name,
    status: row.status,
    lastPushedAt: row.last_pushed_at?.toISOString() ?? null,
    lastPulledAt: row.last_pulled_at?.toISOString() ?? null,
    lastPullSequence: Number(row.last_pull_sequence),
    createdAt: row.created_at.toISOString()
  }));
}

export type ObjectQueueEntry = {
  objectQueueId: string;
  nodeId: string;
  nodeCode: string;
  objectKey: string;
  status: "pending" | "sent" | "failed";
  retryCount: number;
  nextRetryAt: string | null;
  lastError: string | null;
  byteSize: number;
  requiresUpload: boolean;
  uploadedAt: string | null;
  createdAt: string;
};

type ObjectQueueRow = {
  id: string;
  node_id: string;
  node_code: string;
  object_key: string;
  status: "pending" | "sent" | "failed";
  retry_count: string | number;
  next_retry_at: Date | null;
  last_error: string | null;
  byte_size: string | number;
  requires_upload: boolean;
  uploaded_at: Date | null;
  created_at: Date;
};

const OBJECT_QUEUE_LIMIT = 200;

/**
 * Tenant-wide (all nodes) admin view of the object sync queue — distinct
 * from the node-scoped, HMAC-authenticated `GET /sync/objects/status` that
 * a single node polls for its own pending work.
 */
export async function fetchObjectQueueEntries(
  tx: Bun.SQL,
  tenantId: string,
  statusFilter?: "pending" | "sent" | "failed"
): Promise<ObjectQueueEntry[]> {
  const rows = (
    statusFilter
      ? await tx`
        SELECT q.id, q.node_id, n.node_code, q.object_key, q.status, q.retry_count,
               q.next_retry_at, q.last_error, q.byte_size, q.requires_upload,
               q.uploaded_at, q.created_at
        FROM awcms_mini_object_sync_queue q
        JOIN awcms_mini_sync_nodes n ON n.id = q.node_id AND n.tenant_id = q.tenant_id
        WHERE q.tenant_id = ${tenantId} AND q.status = ${statusFilter}
        ORDER BY q.created_at DESC
        LIMIT ${OBJECT_QUEUE_LIMIT}
      `
      : await tx`
        SELECT q.id, q.node_id, n.node_code, q.object_key, q.status, q.retry_count,
               q.next_retry_at, q.last_error, q.byte_size, q.requires_upload,
               q.uploaded_at, q.created_at
        FROM awcms_mini_object_sync_queue q
        JOIN awcms_mini_sync_nodes n ON n.id = q.node_id AND n.tenant_id = q.tenant_id
        WHERE q.tenant_id = ${tenantId}
        ORDER BY q.created_at DESC
        LIMIT ${OBJECT_QUEUE_LIMIT}
      `
  ) as ObjectQueueRow[];

  return rows.map((row) => ({
    objectQueueId: row.id,
    nodeId: row.node_id,
    nodeCode: row.node_code,
    objectKey: row.object_key,
    status: row.status,
    retryCount: Number(row.retry_count),
    nextRetryAt: row.next_retry_at?.toISOString() ?? null,
    lastError: row.last_error,
    byteSize: Number(row.byte_size),
    requiresUpload: row.requires_upload,
    uploadedAt: row.uploaded_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString()
  }));
}
