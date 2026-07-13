/**
 * Fixture seeder (Issue #744, epic #738 platform-evolution) — the I/O layer
 * that writes `fixture-generator.ts`'s pure, deterministic row objects into
 * a real PostgreSQL. Deliberately separate from the pure generator module
 * so the deterministic SHAPE of the data (unit-testable, no database) is
 * independent from HOW it gets written (integration-tested, real Postgres).
 *
 * Uses the SAME least-privilege connection (`getDatabaseClient()`'s
 * `DATABASE_URL`, the `awcms_mini_app` role) every real endpoint uses —
 * deliberately NOT a privileged/superuser bypass connection. Every
 * tenant's own rows are written inside `withTenant(sql, tenant.tenantId,
 * ...)` (`tenant-context.ts`), the SAME chokepoint every production
 * mutation goes through, so RLS's `USING (tenant_id = current_setting(...))`
 * genuinely allows each insert because the row's own `tenant_id` matches
 * the session's `app.current_tenant_id` — never because the connection
 * bypassed RLS altogether. This matters for this issue specifically: "RLS
 * cross-tenant negative tests remain active in the large-data environment"
 * only means something if the data was never written by a role that
 * skips RLS in the first place.
 *
 * `awcms_mini_tenants` itself has no RLS policy (it is the global tenant
 * registry, not a tenant-scoped table) — its rows are inserted directly,
 * with no tenant context required.
 *
 * Every bulk insert uses the `unnest(...)` + `sql.array(...)` pattern
 * (doc skill `awcms-mini-performance` §Hindari N+1, precedent:
 * `src/pages/api/v1/sync/objects/index.ts`) — one round trip per chunk
 * instead of one INSERT per row, which is what makes seeding tens of
 * thousands of rows fast enough for the CI-safe profile.
 */
import { withTenant } from "../database/tenant-context";
import type {
  AbacDecisionLogFixtureRow,
  AuditEventFixtureRow,
  BlogPostFixtureRow,
  FixturePlan,
  IdempotencyKeyFixtureRow,
  ObjectSyncQueueFixtureRow,
  SyncOutboxFixtureRow,
  TenantFixturePlan,
  VisitorSessionFixtureRow
} from "./fixture-generator";
import {
  generateAbacDecisionLogs,
  generateAuditEvents,
  generateBlogPosts,
  generateIdempotencyKeys,
  generateObjectSyncQueue,
  generateSyncOutbox,
  generateVisitorSessions
} from "./fixture-generator";

/** Rows per `unnest(...)` batch — keeps individual statements small/fast and bounds peak memory even at the `large` profile's row counts. */
const SEED_CHUNK_SIZE = 2000;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export type FixtureSeedSummary = {
  tenantCount: number;
  rowCounts: {
    auditEvents: number;
    abacDecisionLogs: number;
    visitorSessions: number;
    syncOutbox: number;
    objectSyncQueue: number;
    idempotencyKeys: number;
    blogPosts: number;
  };
  durationMs: number;
};

async function seedTenantRow(
  sql: Bun.SQL,
  tenant: TenantFixturePlan
): Promise<void> {
  await sql`
    INSERT INTO awcms_mini_tenants (id, tenant_code, tenant_name, status)
    VALUES (${tenant.tenantId}, ${tenant.tenantCode}, ${tenant.tenantName}, 'active')
    ON CONFLICT (id) DO NOTHING
  `;
}

async function insertSyncNode(
  tx: Bun.TransactionSQL,
  tenant: TenantFixturePlan
): Promise<void> {
  await tx`
    INSERT INTO awcms_mini_sync_nodes (id, tenant_id, node_code, node_name, status)
    VALUES (${tenant.syncNodeId}, ${tenant.tenantId}, ${tenant.syncNodeCode}, ${tenant.syncNodeCode}, 'active')
    ON CONFLICT (id) DO NOTHING
  `;
}

async function insertAuditEvents(
  tx: Bun.TransactionSQL,
  rows: AuditEventFixtureRow[]
): Promise<void> {
  for (const batch of chunk(rows, SEED_CHUNK_SIZE)) {
    await tx`
      INSERT INTO awcms_mini_audit_events
        (tenant_id, module_key, action, resource_type, resource_id, severity, message, correlation_id, created_at)
      SELECT * FROM unnest(
        ${tx.array(
          batch.map((r) => r.tenantId),
          "uuid"
        )},
        ${tx.array(
          batch.map((r) => r.moduleKey),
          "text"
        )},
        ${tx.array(
          batch.map((r) => r.action),
          "text"
        )},
        ${tx.array(
          batch.map((r) => r.resourceType),
          "text"
        )},
        ${tx.array(
          batch.map((r) => r.resourceId),
          "text"
        )},
        ${tx.array(
          batch.map((r) => r.severity),
          "text"
        )},
        ${tx.array(
          batch.map((r) => r.message),
          "text"
        )},
        ${tx.array(
          batch.map((r) => r.correlationId),
          "text"
        )},
        ${tx.array(
          batch.map((r) => r.createdAt),
          "timestamptz"
        )}
      )
    `;
  }
}

async function insertAbacDecisionLogs(
  tx: Bun.TransactionSQL,
  rows: AbacDecisionLogFixtureRow[]
): Promise<void> {
  for (const batch of chunk(rows, SEED_CHUNK_SIZE)) {
    await tx`
      INSERT INTO awcms_mini_abac_decision_logs
        (tenant_id, module_key, activity_code, action, resource_type, resource_id, decision, reason, matched_policy, created_at)
      SELECT * FROM unnest(
        ${tx.array(
          batch.map((r) => r.tenantId),
          "uuid"
        )},
        ${tx.array(
          batch.map((r) => r.moduleKey),
          "text"
        )},
        ${tx.array(
          batch.map((r) => r.activityCode),
          "text"
        )},
        ${tx.array(
          batch.map((r) => r.action),
          "text"
        )},
        ${tx.array(
          batch.map((r) => r.resourceType),
          "text"
        )},
        ${tx.array(
          batch.map((r) => r.resourceId),
          "uuid"
        )},
        ${tx.array(
          batch.map((r) => r.decision),
          "text"
        )},
        ${tx.array(
          batch.map((r) => r.reason),
          "text"
        )},
        ${tx.array(
          // `?? undefined`, never a bare `null` — Bun.SQL's `sql.array()`
          // silently serializes a `null` array ELEMENT as the literal text
          // "null" for `text`/`uuid` columns (and throws a cast error for
          // `timestamptz`), rather than emitting a real SQL NULL. `undefined`
          // is the element value that actually produces SQL NULL through
          // this driver — verified empirically against this repo's own dev
          // Postgres; see the identical workaround on `nextRetryAt`/
          // `publishedAt` below.
          batch.map((r) => r.matchedPolicy ?? undefined),
          "text"
        )},
        ${tx.array(
          batch.map((r) => r.createdAt),
          "timestamptz"
        )}
      )
    `;
  }
}

async function insertVisitorSessions(
  tx: Bun.TransactionSQL,
  rows: VisitorSessionFixtureRow[]
): Promise<void> {
  for (const batch of chunk(rows, SEED_CHUNK_SIZE)) {
    await tx`
      INSERT INTO awcms_mini_visitor_sessions
        (tenant_id, visitor_key_hash, area, current_path, is_authenticated, is_human, device_type, first_seen_at, last_seen_at)
      SELECT * FROM unnest(
        ${tx.array(
          batch.map((r) => r.tenantId),
          "uuid"
        )},
        ${tx.array(
          batch.map((r) => r.visitorKeyHash),
          "text"
        )},
        ${tx.array(
          batch.map((r) => r.area),
          "text"
        )},
        ${tx.array(
          batch.map((r) => r.currentPath),
          "text"
        )},
        ${tx.array(
          batch.map((r) => r.isAuthenticated),
          "bool"
        )},
        ${tx.array(
          batch.map((r) => r.isHuman),
          "bool"
        )},
        ${tx.array(
          batch.map((r) => r.deviceType),
          "text"
        )},
        ${tx.array(
          batch.map((r) => r.firstSeenAt),
          "timestamptz"
        )},
        ${tx.array(
          batch.map((r) => r.lastSeenAt),
          "timestamptz"
        )}
      )
    `;
  }
}

async function insertSyncOutbox(
  tx: Bun.TransactionSQL,
  rows: SyncOutboxFixtureRow[]
): Promise<void> {
  for (const batch of chunk(rows, SEED_CHUNK_SIZE)) {
    await tx`
      INSERT INTO awcms_mini_sync_outbox
        (tenant_id, event_type, aggregate_type, aggregate_id, payload_json, status)
      SELECT t.tenant_id, t.event_type, t.aggregate_type, t.aggregate_id, t.payload_json, t.status
      FROM unnest(
        ${tx.array(
          batch.map((r) => r.tenantId),
          "uuid"
        )},
        ${tx.array(
          batch.map((r) => r.eventType),
          "text"
        )},
        ${tx.array(
          batch.map((r) => r.aggregateType),
          "text"
        )},
        ${tx.array(
          batch.map((r) => r.aggregateId),
          "uuid"
        )},
        ${tx.array(
          batch.map((r) => JSON.stringify(r.payloadJson)),
          "jsonb"
        )},
        ${tx.array(
          batch.map((r) => r.status),
          "text"
        )}
      ) AS t(tenant_id, event_type, aggregate_type, aggregate_id, payload_json, status)
    `;
  }
}

async function insertObjectSyncQueue(
  tx: Bun.TransactionSQL,
  rows: ObjectSyncQueueFixtureRow[]
): Promise<void> {
  for (const batch of chunk(rows, SEED_CHUNK_SIZE)) {
    await tx`
      INSERT INTO awcms_mini_object_sync_queue
        (tenant_id, node_id, object_key, local_path, checksum_sha256, byte_size, requires_upload, status, retry_count, next_retry_at)
      SELECT * FROM unnest(
        ${tx.array(
          batch.map((r) => r.tenantId),
          "uuid"
        )},
        ${tx.array(
          batch.map((r) => r.nodeId),
          "uuid"
        )},
        ${tx.array(
          batch.map((r) => r.objectKey),
          "text"
        )},
        ${tx.array(
          batch.map((r) => r.localPath),
          "text"
        )},
        ${tx.array(
          batch.map((r) => r.checksumSha256),
          "text"
        )},
        ${tx.array(
          batch.map((r) => r.byteSize),
          "bigint"
        )},
        ${tx.array(
          batch.map((r) => r.requiresUpload),
          "bool"
        )},
        ${tx.array(
          batch.map((r) => r.status),
          "text"
        )},
        ${tx.array(
          batch.map((r) => r.retryCount),
          "int4"
        )},
        ${tx.array(
          // See the `matchedPolicy` comment above — `?? undefined`, never a
          // bare `null`.
          batch.map((r) => r.nextRetryAt ?? undefined),
          "timestamptz"
        )}
      )
      ON CONFLICT (tenant_id, node_id, object_key) DO NOTHING
    `;
  }
}

async function insertIdempotencyKeys(
  tx: Bun.TransactionSQL,
  rows: IdempotencyKeyFixtureRow[]
): Promise<void> {
  for (const batch of chunk(rows, SEED_CHUNK_SIZE)) {
    await tx`
      INSERT INTO awcms_mini_idempotency_keys
        (tenant_id, request_scope, idempotency_key, request_hash, response_status, response_body, created_at)
      SELECT t.tenant_id, t.request_scope, t.idempotency_key, t.request_hash, t.response_status, t.response_body, t.created_at
      FROM unnest(
        ${tx.array(
          batch.map((r) => r.tenantId),
          "uuid"
        )},
        ${tx.array(
          batch.map((r) => r.requestScope),
          "text"
        )},
        ${tx.array(
          batch.map((r) => r.idempotencyKey),
          "text"
        )},
        ${tx.array(
          batch.map((r) => r.requestHash),
          "text"
        )},
        ${tx.array(
          batch.map((r) => r.responseStatus),
          "int4"
        )},
        ${tx.array(
          batch.map((r) => JSON.stringify(r.responseBody)),
          "jsonb"
        )},
        ${tx.array(
          batch.map((r) => r.createdAt),
          "timestamptz"
        )}
      ) AS t(tenant_id, request_scope, idempotency_key, request_hash, response_status, response_body, created_at)
      ON CONFLICT (tenant_id, request_scope, idempotency_key) DO NOTHING
    `;
  }
}

async function insertBlogPosts(
  tx: Bun.TransactionSQL,
  rows: BlogPostFixtureRow[]
): Promise<void> {
  for (const batch of chunk(rows, SEED_CHUNK_SIZE)) {
    await tx`
      INSERT INTO awcms_mini_blog_posts
        (tenant_id, author_tenant_user_id, title, slug, excerpt, content_json, content_text, status, visibility, locale, published_at, created_at)
      SELECT t.tenant_id, t.author_tenant_user_id, t.title, t.slug, t.excerpt, t.content_json, t.content_text, t.status, t.visibility, t.locale, t.published_at, t.created_at
      FROM unnest(
        ${tx.array(
          batch.map((r) => r.tenantId),
          "uuid"
        )},
        ${tx.array(
          batch.map((r) => r.authorTenantUserId),
          "uuid"
        )},
        ${tx.array(
          batch.map((r) => r.title),
          "text"
        )},
        ${tx.array(
          batch.map((r) => r.slug),
          "text"
        )},
        ${tx.array(
          batch.map((r) => r.excerpt),
          "text"
        )},
        ${tx.array(
          batch.map((r) => JSON.stringify(r.contentJson)),
          "jsonb"
        )},
        ${tx.array(
          batch.map((r) => r.contentText),
          "text"
        )},
        ${tx.array(
          batch.map((r) => r.status),
          "text"
        )},
        ${tx.array(
          batch.map((r) => r.visibility),
          "text"
        )},
        ${tx.array(
          batch.map((r) => r.locale),
          "text"
        )},
        ${tx.array(
          // See the `matchedPolicy` comment above — `?? undefined`, never a
          // bare `null`.
          batch.map((r) => r.publishedAt ?? undefined),
          "timestamptz"
        )},
        ${tx.array(
          batch.map((r) => r.createdAt),
          "timestamptz"
        )}
      ) AS t(tenant_id, author_tenant_user_id, title, slug, excerpt, content_json, content_text, status, visibility, locale, published_at, created_at)
      ON CONFLICT DO NOTHING
    `;
  }
}

/**
 * Seeds every fixture table for every tenant in `plan`, using the SAME
 * least-privilege `sql` client (`getDatabaseClient()`) every real endpoint
 * uses — see module header for why this is deliberate, not an oversight.
 * Idempotent for tenant/node rows (`ON CONFLICT DO NOTHING`); NOT
 * idempotent for the bulk data tables themselves (re-running against an
 * already-seeded database duplicates rows) — callers that need a clean
 * slate should truncate first (mirrors `tests/integration/harness.ts`'s
 * `resetDatabase()`).
 */
export async function seedPerformanceFixtures(
  sql: Bun.SQL,
  plan: FixturePlan
): Promise<FixtureSeedSummary> {
  const startedAt = performance.now();
  const anchor = new Date();

  const rowCounts: FixtureSeedSummary["rowCounts"] = {
    auditEvents: 0,
    abacDecisionLogs: 0,
    visitorSessions: 0,
    syncOutbox: 0,
    objectSyncQueue: 0,
    idempotencyKeys: 0,
    blogPosts: 0
  };

  for (const tenant of plan.tenants) {
    await seedTenantRow(sql, tenant);

    const auditEvents = generateAuditEvents(tenant, plan.seed, anchor);
    const abacDecisionLogs = generateAbacDecisionLogs(
      tenant,
      plan.seed,
      anchor
    );
    const visitorSessions = generateVisitorSessions(tenant, plan.seed, anchor);
    const syncOutbox = generateSyncOutbox(tenant, plan.seed, anchor);
    const objectSyncQueue = generateObjectSyncQueue(tenant, plan.seed, anchor);
    const idempotencyKeys = generateIdempotencyKeys(tenant, plan.seed, anchor);
    const blogPosts = generateBlogPosts(tenant, plan.seed, anchor);

    await withTenant(
      sql,
      tenant.tenantId,
      async (tx) => {
        await insertSyncNode(tx, tenant);
        await insertAuditEvents(tx, auditEvents);
        await insertAbacDecisionLogs(tx, abacDecisionLogs);
        await insertVisitorSessions(tx, visitorSessions);
        await insertSyncOutbox(tx, syncOutbox);
        await insertObjectSyncQueue(tx, objectSyncQueue);
        await insertIdempotencyKeys(tx, idempotencyKeys);
        await insertBlogPosts(tx, blogPosts);
      },
      // "maintenance" — bulk fixture seeding is an administrative batch
      // operation, never "interactive" request-serving traffic.
      { workClass: "maintenance", queueTimeoutMs: 30_000 }
    );

    rowCounts.auditEvents += auditEvents.length;
    rowCounts.abacDecisionLogs += abacDecisionLogs.length;
    rowCounts.visitorSessions += visitorSessions.length;
    rowCounts.syncOutbox += syncOutbox.length;
    rowCounts.objectSyncQueue += objectSyncQueue.length;
    rowCounts.idempotencyKeys += idempotencyKeys.length;
    rowCounts.blogPosts += blogPosts.length;
  }

  return {
    tenantCount: plan.tenants.length,
    rowCounts,
    durationMs: performance.now() - startedAt
  };
}
