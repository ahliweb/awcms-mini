/**
 * Integration test for `newsMediaPortAdapter.resolveMediaReferences` (Issue
 * #835 §1) against real PostgreSQL. The port is batch-shaped — callers hand
 * it the whole id set at once — and the fix resolves the batch in ONE
 * `id = ANY(...)` round-trip instead of one `fetchNewsMediaObjectById` per id,
 * while keeping the exact same contract: only `verified`/`attached` ids
 * resolve; unsafe / nonexistent / duplicate ids are simply absent, never
 * thrown.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  getAdminSql,
  integrationEnabled,
  provisionAppRole,
  resetDatabase
} from "./harness";

import { getDatabaseClient } from "../../src/lib/database/client";
import { withTenant } from "../../src/lib/database/tenant-context";
import { newsMediaPortAdapter } from "../../src/modules/news-portal/application/news-media-port-adapter";

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ACTOR_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

async function seedTenant(): Promise<void> {
  const admin = getAdminSql();
  await admin`
    INSERT INTO awcms_mini_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES (${TENANT_A}, 'tenant-a', 'Tenant A', 'Tenant A Legal', 'active', 'en', 'light')
  `;
}

async function insertMedia(
  status: string,
  suffix: string,
  attached: boolean
): Promise<string> {
  const admin = getAdminSql();
  const rows = (await admin`
    INSERT INTO awcms_mini_news_media_objects
      (tenant_id, bucket_name, object_key, public_url, mime_type, status,
       owner_resource_type, owner_resource_id, created_by_tenant_user_id)
    VALUES (
      ${TENANT_A}, 'bucket',
      'news-media/' || ${TENANT_A} || '/2026/03/' || ${suffix} || '.jpg',
      ${"https://media.example.test/" + suffix + ".jpg"}, 'image/jpeg', ${status},
      ${attached ? "blog_post" : null},
      ${attached ? "dddddddd-dddd-dddd-dddd-dddddddddddd" : null},
      ${ACTOR_ID}
    )
    RETURNING id
  `) as { id: string }[];
  return rows[0]!.id;
}

const suite = integrationEnabled ? describe : describe.skip;

suite("news media resolveMediaReferences — batched", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant();
  });

  test("resolves only safe ids, absent for unsafe/nonexistent/dup, in a single query", async () => {
    const verifiedId = await insertMedia(
      "verified",
      "11111111-1111-1111-1111-111111111111",
      false
    );
    const attachedId = await insertMedia(
      "attached",
      "22222222-2222-2222-2222-222222222222",
      true
    );
    const pendingId = await insertMedia(
      "pending_upload",
      "33333333-3333-3333-3333-333333333333",
      false
    );
    const nonexistentId = "99999999-9999-9999-9999-999999999999";

    const sql = getDatabaseClient();

    await withTenant(sql, TENANT_A, async (tx) => {
      let queryCount = 0;
      const countingTx = new Proxy(tx, {
        apply(target, thisArg, args) {
          queryCount += 1;
          return Reflect.apply(
            target as unknown as (...a: unknown[]) => unknown,
            thisArg,
            args
          );
        }
      }) as unknown as typeof tx;

      const resolved = await newsMediaPortAdapter.resolveMediaReferences(
        countingTx,
        TENANT_A,
        [
          verifiedId,
          attachedId,
          pendingId,
          verifiedId, // duplicate — deduped, not a second query
          nonexistentId
        ]
      );

      // Only verified + attached resolve.
      expect(resolved.size).toBe(2);
      expect(resolved.has(verifiedId)).toBe(true);
      expect(resolved.has(attachedId)).toBe(true);
      expect(resolved.has(pendingId)).toBe(false);
      expect(resolved.has(nonexistentId)).toBe(false);
      expect(resolved.get(verifiedId)?.publicUrl).toContain(
        "11111111-1111-1111-1111-111111111111"
      );

      // Issue #835 §1: one round-trip for the whole batch (not one per id).
      expect(queryCount).toBe(1);
      return null;
    });
  });

  test("empty id list resolves to an empty map without querying", async () => {
    const sql = getDatabaseClient();
    await withTenant(sql, TENANT_A, async (tx) => {
      let queryCount = 0;
      const countingTx = new Proxy(tx, {
        apply(target, thisArg, args) {
          queryCount += 1;
          return Reflect.apply(
            target as unknown as (...a: unknown[]) => unknown,
            thisArg,
            args
          );
        }
      }) as unknown as typeof tx;

      const resolved = await newsMediaPortAdapter.resolveMediaReferences(
        countingTx,
        TENANT_A,
        []
      );
      expect(resolved.size).toBe(0);
      expect(queryCount).toBe(0);
      return null;
    });
  });
});
