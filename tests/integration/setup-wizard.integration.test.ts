/**
 * Integration test for `POST /api/v1/setup/initialize` (Issue #680, epic
 * #679). Its orchestration was extracted verbatim out of the route handler
 * into `src/modules/tenant-admin/application/platform-bootstrap.ts`'s
 * `bootstrapPlatformTenant` (a composition-root function, not a module
 * `dependencies` edge — see that file's own header comment) as part of
 * removing the live `tenant_admin`/`profile_identity`/`identity_access`
 * dependency cycle. This test proves the extraction is behavior-preserving:
 * a first call creates the full tenant/office/profile/identity/role/
 * assignment graph, and — the acceptance criterion this issue explicitly
 * calls out — "bootstrap/setup behavior remains idempotent": a second call
 * against the same (already-initialized) database is rejected, and creates
 * no second tenant row.
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
  resetDatabase
} from "./harness";

import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";

const VALID_BODY = {
  tenantName: "Acme",
  tenantCode: "acme",
  officeCode: "hq",
  officeName: "HQ",
  ownerLoginIdentifier: "owner@example.com",
  ownerPassword: "correct horse battery staple",
  ownerDisplayName: "Owner"
};

const suite = integrationEnabled ? describe : describe.skip;

suite(
  "POST /api/v1/setup/initialize (Issue #680 composition-root extraction)",
  () => {
    beforeAll(async () => {
      await applyMigrations();
      await provisionAppRole();
    });

    beforeEach(async () => {
      await resetDatabase();
    });

    test("first call creates the full tenant/office/owner graph in one transaction", async () => {
      const response = await invoke<{
        data: {
          tenantId: string;
          officeId: string;
          ownerProfileId: string;
          ownerIdentityId: string;
          ownerTenantUserId: string;
          ownerRoleId: string;
        };
      }>(setupInitialize, {
        method: "POST",
        path: "/api/v1/setup/initialize",
        headers: { "content-type": "application/json" },
        body: VALID_BODY
      });

      expect(response.status).toBe(200);
      const { data } = response.body;
      expect(data.tenantId).toBeTruthy();
      expect(data.officeId).toBeTruthy();
      expect(data.ownerProfileId).toBeTruthy();
      expect(data.ownerIdentityId).toBeTruthy();
      expect(data.ownerTenantUserId).toBeTruthy();
      expect(data.ownerRoleId).toBeTruthy();

      const admin = getAdminSql();
      const tenants =
        await admin`SELECT id FROM awcms_mini_tenants WHERE id = ${data.tenantId}`;
      expect(tenants).toHaveLength(1);

      const setupState =
        await admin`SELECT tenant_id FROM awcms_mini_setup_state WHERE id = true`;
      expect(setupState[0]?.tenant_id).toBe(data.tenantId);
    });

    test("a second call is rejected (403) and creates no second tenant row — idempotent, not merely re-validated", async () => {
      const first = await invoke<{ data: { tenantId: string } }>(
        setupInitialize,
        {
          method: "POST",
          path: "/api/v1/setup/initialize",
          headers: { "content-type": "application/json" },
          body: VALID_BODY
        }
      );
      expect(first.status).toBe(200);

      const second = await invoke(setupInitialize, {
        method: "POST",
        path: "/api/v1/setup/initialize",
        headers: { "content-type": "application/json" },
        body: { ...VALID_BODY, tenantCode: "different-tenant" }
      });
      expect(second.status).toBe(403);

      const admin = getAdminSql();
      const tenants = await admin`SELECT id FROM awcms_mini_tenants`;
      expect(tenants).toHaveLength(1);
      expect(tenants[0]!.id).toBe(first.body.data.tenantId);
    });
  }
);
