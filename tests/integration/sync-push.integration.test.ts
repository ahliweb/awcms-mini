/**
 * Integration tests for `POST /api/v1/sync/push` against a real PostgreSQL.
 *
 * Issue #435 (performance audit) rewrote this handler's per-event
 * `SELECT current_version FROM awcms_mini_sync_aggregate_versions WHERE
 * aggregate_id = X` (one query per event — a classic N+1) into a single
 * prefetch keyed by `aggregateType:aggregateId`, updated in-memory as each
 * event is accepted. No prior test exercised this endpoint at all (see
 * `tests/sync-storage.test.ts` for the pre-existing pure-unit coverage of
 * `evaluatePushEventConflict`/HMAC helpers in isolation) — these tests both
 * close that gap and specifically guard the one behavior the rewrite had to
 * preserve exactly: when the *same* aggregate is referenced by more than one
 * event in a single push batch, the second event must see the version the
 * first one just bumped to, not the stale value from before the batch
 * started.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test
} from "bun:test";

import {
  applyMigrations,
  getAdminSql,
  integrationEnabled,
  invoke,
  provisionAppRole,
  resetDatabase
} from "./harness";

import { POST as syncPush } from "../../src/pages/api/v1/sync/push";
import { computeSyncSignature } from "../../src/modules/sync-storage/domain/sync-hmac";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const NODE_CODE = "push-test-node";
const HMAC_SECRET = "integration-test-sync-secret";

const originalEnv = {
  AWCMS_MINI_SYNC_ENABLED: process.env.AWCMS_MINI_SYNC_ENABLED,
  AWCMS_MINI_SYNC_HMAC_SECRET: process.env.AWCMS_MINI_SYNC_HMAC_SECRET,
  AWCMS_MINI_SYNC_MAX_SKEW_SEC: process.env.AWCMS_MINI_SYNC_MAX_SKEW_SEC
};

type PushEventInput = {
  eventType: string;
  aggregateType: string;
  aggregateId?: string;
  baseVersion?: number;
};

function event(input: PushEventInput): PushEventInput & { payload: object } {
  return { ...input, payload: {} };
}

async function pushBatch(
  batchId: string,
  events: PushEventInput[]
): Promise<{ status: number; body: any }> {
  const bodyObject = { batchId, events: events.map(event) };
  const rawBody = JSON.stringify(bodyObject);
  const timestamp = new Date().toISOString();
  const signature = computeSyncSignature(HMAC_SECRET, timestamp, rawBody);

  return invoke(syncPush, {
    method: "POST",
    path: "/api/v1/sync/push",
    headers: {
      "content-type": "application/json",
      "x-awcms-mini-tenant-id": TENANT_ID,
      "x-awcms-mini-node-id": NODE_CODE,
      "x-awcms-mini-timestamp": timestamp,
      "x-awcms-mini-signature": signature
    },
    body: bodyObject
  });
}

const suite = integrationEnabled ? describe : describe.skip;

suite("Sync push API (real Postgres)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
    process.env.AWCMS_MINI_SYNC_ENABLED = "true";
    process.env.AWCMS_MINI_SYNC_HMAC_SECRET = HMAC_SECRET;
    process.env.AWCMS_MINI_SYNC_MAX_SKEW_SEC = "300";
  });

  afterAll(() => {
    process.env.AWCMS_MINI_SYNC_ENABLED = originalEnv.AWCMS_MINI_SYNC_ENABLED;
    process.env.AWCMS_MINI_SYNC_HMAC_SECRET =
      originalEnv.AWCMS_MINI_SYNC_HMAC_SECRET;
    process.env.AWCMS_MINI_SYNC_MAX_SKEW_SEC =
      originalEnv.AWCMS_MINI_SYNC_MAX_SKEW_SEC;
  });

  beforeEach(async () => {
    await resetDatabase();
    // The push endpoint auto-registers unknown nodes, but it needs a real
    // tenant row to satisfy the FK (RLS-scoped inserts still need the parent
    // row to exist).
    await getAdminSql()`
      INSERT INTO awcms_mini_tenants (id, tenant_code, tenant_name)
      VALUES (${TENANT_ID}, 'push-test-tenant', 'Push Test Tenant')
      ON CONFLICT (id) DO NOTHING
    `;
  });

  test("accepts a fresh event with no baseVersion and bumps the aggregate to version 1", async () => {
    const aggregateId = "22222222-2222-2222-2222-222222222222";
    const result = await pushBatch("batch-1", [
      { eventType: "widget.created", aggregateType: "widget", aggregateId }
    ]);

    expect(result.status).toBe(200);
    expect(result.body.data).toMatchObject({
      accepted: 1,
      conflicted: 0,
      duplicate: false
    });
  });

  test("flags version_mismatch when baseVersion is stale", async () => {
    const aggregateId = "33333333-3333-3333-3333-333333333333";

    // First event establishes version 1.
    await pushBatch("batch-a", [
      { eventType: "widget.created", aggregateType: "widget", aggregateId }
    ]);

    // Second push (new batch) claims baseVersion 0 — stale, should conflict.
    const result = await pushBatch("batch-b", [
      {
        eventType: "widget.updated",
        aggregateType: "widget",
        aggregateId,
        baseVersion: 0
      }
    ]);

    expect(result.status).toBe(200);
    expect(result.body.data).toMatchObject({ accepted: 0, conflicted: 1 });
  });

  test("replaying the same batchId is idempotent (duplicate: true, no reprocessing)", async () => {
    const aggregateId = "44444444-4444-4444-4444-444444444444";
    const events: PushEventInput[] = [
      { eventType: "widget.created", aggregateType: "widget", aggregateId }
    ];

    const first = await pushBatch("batch-dup", events);
    expect(first.body.data.duplicate).toBe(false);

    const second = await pushBatch("batch-dup", events);
    expect(second.status).toBe(200);
    expect(second.body.data).toMatchObject({
      accepted: 1,
      conflicted: 0,
      duplicate: true
    });
  });

  // The critical regression case for the N+1 rewrite: the in-memory prefetch
  // map must reflect the version bump from the FIRST event before evaluating
  // the SECOND event in the same batch, exactly like the old
  // read-fresh-from-the-database-every-time loop did.
  test("two events for the same aggregate in one batch: the second sees the first's version bump", async () => {
    const aggregateId = "55555555-5555-5555-5555-555555555555";

    const result = await pushBatch("batch-same-aggregate", [
      // Fresh aggregate: version 0 -> 1.
      { eventType: "widget.created", aggregateType: "widget", aggregateId },
      // Correctly claims the version the first event just produced (1).
      {
        eventType: "widget.updated",
        aggregateType: "widget",
        aggregateId,
        baseVersion: 1
      }
    ]);

    expect(result.status).toBe(200);
    expect(result.body.data).toMatchObject({ accepted: 2, conflicted: 0 });
  });

  test("two events for the same aggregate in one batch: a stale second baseVersion still conflicts", async () => {
    const aggregateId = "66666666-6666-6666-6666-666666666666";

    const result = await pushBatch("batch-same-aggregate-stale", [
      // Fresh aggregate: version 0 -> 1.
      { eventType: "widget.created", aggregateType: "widget", aggregateId },
      // Incorrectly claims version 0 again — must conflict, not silently
      // succeed against a stale/never-refreshed prefetch value.
      {
        eventType: "widget.updated",
        aggregateType: "widget",
        aggregateId,
        baseVersion: 0
      }
    ]);

    expect(result.status).toBe(200);
    expect(result.body.data).toMatchObject({ accepted: 1, conflicted: 1 });
  });

  test("two aggregate types sharing the same raw id are not confused by the prefetch map", async () => {
    // Same raw id, different aggregate_type — the version prefetch map is
    // keyed `type:id`, not id alone, precisely to keep these independent. If
    // it were keyed by id alone, `widget`'s version-1 history would leak
    // into `gadget`'s (fresh, no-baseVersion) lookup and wrongly flag it
    // `missing_base_version`.
    const sharedId = "77777777-7777-7777-7777-777777777777";

    await pushBatch("batch-shared-id-setup", [
      {
        eventType: "widget.created",
        aggregateType: "widget",
        aggregateId: sharedId
      }
    ]);

    const result = await pushBatch("batch-shared-id", [
      {
        eventType: "widget.updated",
        aggregateType: "widget",
        aggregateId: sharedId,
        baseVersion: 1
      },
      // Fresh aggregate under a different type — must NOT see widget's
      // version 1 and must NOT require a baseVersion.
      {
        eventType: "gadget.created",
        aggregateType: "gadget",
        aggregateId: sharedId
      }
    ]);

    expect(result.status).toBe(200);
    expect(result.body.data).toMatchObject({ accepted: 2, conflicted: 0 });
  });
});
