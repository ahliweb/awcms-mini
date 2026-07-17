/**
 * Integration tests for `data_exchange` (Issue #752, epic #738
 * platform-evolution Wave 3, ADR-0018) against real PostgreSQL, through
 * the REAL Astro route handlers plus the REAL worker pipeline
 * (`runDataExchangeWorkerPassForTenant`):
 *
 * - Full pipeline: stage (multipart HTTP) -> validate pass -> preview ->
 *   commit trigger -> commit pass, covering create/update/conflict
 *   proposed actions against the self-contained `reference_items` fixture.
 * - Partial-failure-then-resume idempotency: a fault-injecting test
 *   adapter proves a retried commit pass never double-applies an
 *   already-committed row.
 * - Export + manifest/checksum + reconciliation, including a DELIBERATE
 *   mismatch via a fault-injecting export adapter.
 * - Formula-injection (CSV injection) round-trips safely end-to-end
 *   (import -> stored -> export).
 * - An oversized file (row count AND HTTP byte size) is rejected without
 *   hanging.
 * - Cross-tenant isolation (RLS) and a default-deny ABAC negative test.
 * - Idempotency-Key replay on the stage-upload and commit endpoints.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import type { APIContext } from "astro";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test
} from "bun:test";

import {
  applyMigrations,
  createCookieJar,
  getAdminSql,
  getWorkerTestSql,
  integrationEnabled,
  invoke,
  invokeRaw,
  provisionAppRole,
  provisionWorkerRole,
  resetDatabase,
  type CookieJar
} from "./harness";

import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import {
  GET as listImports,
  POST as stageImport
} from "../../src/pages/api/v1/data-exchange/imports/index";
import { GET as getImportBatchRoute } from "../../src/pages/api/v1/data-exchange/imports/[id]/index";
import { GET as getPreview } from "../../src/pages/api/v1/data-exchange/imports/[id]/preview";
import { PREVIEW_OFFSET_MAX } from "../../src/modules/data-exchange/application/staged-row-directory";
import { POST as commitImport } from "../../src/pages/api/v1/data-exchange/imports/[id]/commit";
import { POST as cancelImport } from "../../src/pages/api/v1/data-exchange/imports/[id]/cancel";
import { POST as retryImport } from "../../src/pages/api/v1/data-exchange/imports/[id]/retry";
import { POST as createExportRoute } from "../../src/pages/api/v1/data-exchange/exports/index";
import { GET as getExportJobRoute } from "../../src/pages/api/v1/data-exchange/exports/[id]/index";
import { GET as downloadExportRoute } from "../../src/pages/api/v1/data-exchange/exports/[id]/download";
import { dataExchangeModule } from "../../src/modules/data-exchange/module";
import { GET as getReconciliation } from "../../src/pages/api/v1/data-exchange/reconciliation/[subjectType]/[subjectId]";

import { hashPassword } from "../../src/lib/auth/password";
import { hashSessionToken } from "../../src/lib/auth/session-token";
import { fetchGrantedPermissionKeys } from "../../src/modules/identity-access/application/auth-context";
import { getDatabaseClient } from "../../src/lib/database/client";
import { withTenant } from "../../src/lib/database/tenant-context";
import { runDataExchangeWorkerPassForTenant } from "../../src/modules/data-exchange/application/data-exchange-worker";
import {
  authorizeExchangeDescriptorPermission,
  isDescriptorPermissionGranted
} from "../../src/modules/data-exchange/application/descriptor-authorization";
import { findReferenceItemByCode } from "../../src/modules/data-exchange/application/reference-items-directory";
import { referenceItemsImportAdapter } from "../../src/modules/data-exchange/application/reference-items-exchange-adapter";
import {
  registerExchangeAdapterForTests,
  resetExchangeAdaptersForTests
} from "../../src/modules/data-exchange/infrastructure/exchange-adapter-registry";
import type {
  DataExchangeAdapterPort,
  DataExchangeCommitOutcome
} from "../../src/modules/_shared/ports/data-exchange-adapter-port";
import type { ExchangeDescriptor } from "../../src/modules/_shared/module-contract";

const OWNER_LOGIN = "owner@example.com";
const OWNER_PASSWORD = "integration-test-data-exchange-owner-password";
const REFERENCE_ITEMS_KEY = "data_exchange.reference_items";

type Bootstrap = {
  tenantId: string;
  token: string;
  tenantUserId: string;
};

async function bootstrap(
  tenantCode = "acme",
  tenantName = "Acme"
): Promise<Bootstrap> {
  const loginIdentifier = `${tenantCode}-${OWNER_LOGIN}`;
  const setup = await invoke<{ data: { tenantId: string } }>(setupInitialize, {
    method: "POST",
    path: "/api/v1/setup/initialize",
    headers: { "content-type": "application/json" },
    body: {
      tenantName,
      tenantCode,
      officeCode: "hq",
      officeName: "HQ",
      ownerLoginIdentifier: loginIdentifier,
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
    body: { loginIdentifier, password: OWNER_PASSWORD },
    cookies: createCookieJar()
  });
  expect(login.status).toBe(200);

  const admin = getAdminSql();
  const tenantUserRows = (await admin`
    SELECT tu.id FROM awcms_mini_tenant_users tu
    JOIN awcms_mini_identities i ON i.id = tu.identity_id
    WHERE tu.tenant_id = ${setup.body.data.tenantId} AND i.login_identifier = ${loginIdentifier}
  `) as { id: string }[];

  return {
    tenantId: setup.body.data.tenantId,
    token: login.body.data.token,
    tenantUserId: tenantUserRows[0]!.id
  };
}

/** Mirrors `organization-structure.integration.test.ts`'s own `bootstrapSecondTenant` — the setup wizard is a global one-time singleton, so a second tenant is seeded directly via the privileged client with a fully-permissioned owner role. */
async function bootstrapSecondTenant(
  tenantCode: string,
  tenantName: string
): Promise<Bootstrap> {
  const admin = getAdminSql();
  const loginIdentifier = `${tenantCode}-${OWNER_LOGIN}`;

  const tenantRows = (await admin`
    INSERT INTO awcms_mini_tenants (tenant_code, tenant_name, status)
    VALUES (${tenantCode}, ${tenantName}, 'active')
    RETURNING id
  `) as { id: string }[];
  const tenantId = tenantRows[0]!.id;

  const profileRows = (await admin`
    INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
    VALUES (${tenantId}, 'person', 'Owner')
    RETURNING id
  `) as { id: string }[];

  const passwordHash = await hashPassword(OWNER_PASSWORD);
  const identityRows = (await admin`
    INSERT INTO awcms_mini_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${tenantId}, ${profileRows[0]!.id}, ${loginIdentifier}, ${passwordHash})
    RETURNING id
  `) as { id: string }[];

  const tenantUserRows = (await admin`
    INSERT INTO awcms_mini_tenant_users (tenant_id, identity_id)
    VALUES (${tenantId}, ${identityRows[0]!.id})
    RETURNING id
  `) as { id: string }[];
  const tenantUserId = tenantUserRows[0]!.id;

  const roleRows = (await admin`
    INSERT INTO awcms_mini_roles (tenant_id, role_code, role_name, is_system)
    VALUES (${tenantId}, 'owner', 'Owner', true)
    RETURNING id
  `) as { id: string }[];

  await admin`
    INSERT INTO awcms_mini_role_permissions (tenant_id, role_id, permission_id)
    SELECT ${tenantId}, ${roleRows[0]!.id}, id FROM awcms_mini_permissions
  `;

  await admin`
    INSERT INTO awcms_mini_access_assignments (tenant_id, tenant_user_id, role_id, assigned_by)
    VALUES (${tenantId}, ${tenantUserId}, ${roleRows[0]!.id}, ${tenantUserId})
  `;

  const login = await invoke<{ data: { token: string } }>(authLogin, {
    method: "POST",
    path: "/api/v1/auth/login",
    headers: {
      "content-type": "application/json",
      "x-awcms-mini-tenant-id": tenantId
    },
    body: { loginIdentifier, password: OWNER_PASSWORD },
    cookies: createCookieJar()
  });
  expect(login.status).toBe(200);

  return { tenantId, token: login.body.data.token, tenantUserId };
}

/** A tenant user with a role that grants ZERO permissions -- for the default-deny ABAC negative test. */
async function bootstrapNoAccessUser(owner: Bootstrap): Promise<Bootstrap> {
  const admin = getAdminSql();
  const loginIdentifier = `no-access-${owner.tenantId}@example.com`;

  const profileRows = (await admin`
    INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
    VALUES (${owner.tenantId}, 'person', 'No Access')
    RETURNING id
  `) as { id: string }[];

  const passwordHash = await hashPassword(OWNER_PASSWORD);
  const identityRows = (await admin`
    INSERT INTO awcms_mini_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${owner.tenantId}, ${profileRows[0]!.id}, ${loginIdentifier}, ${passwordHash})
    RETURNING id
  `) as { id: string }[];

  const tenantUserRows = (await admin`
    INSERT INTO awcms_mini_tenant_users (tenant_id, identity_id)
    VALUES (${owner.tenantId}, ${identityRows[0]!.id})
    RETURNING id
  `) as { id: string }[];
  const tenantUserId = tenantUserRows[0]!.id;

  const roleRows = (await admin`
    INSERT INTO awcms_mini_roles (tenant_id, role_code, role_name, is_system)
    VALUES (${owner.tenantId}, 'no_access', 'No Access', false)
    RETURNING id
  `) as { id: string }[];

  await admin`
    INSERT INTO awcms_mini_access_assignments (tenant_id, tenant_user_id, role_id, assigned_by)
    VALUES (${owner.tenantId}, ${tenantUserId}, ${roleRows[0]!.id}, ${owner.tenantUserId})
  `;

  const login = await invoke<{ data: { token: string } }>(authLogin, {
    method: "POST",
    path: "/api/v1/auth/login",
    headers: {
      "content-type": "application/json",
      "x-awcms-mini-tenant-id": owner.tenantId
    },
    body: { loginIdentifier, password: OWNER_PASSWORD },
    cookies: createCookieJar()
  });
  expect(login.status).toBe(200);

  return {
    tenantId: owner.tenantId,
    token: login.body.data.token,
    tenantUserId
  };
}

/** A tenant user granted ONLY the specific permissions listed in `grants` — for the `requiredPermission` enforcement test (security-auditor finding on PR #782): a subject that passes the generic `data_exchange.*` gate but lacks a descriptor-declared EXTRA permission. */
async function bootstrapLimitedUser(
  owner: Bootstrap,
  grants: { moduleKey: string; activityCode: string; action: string }[]
): Promise<Bootstrap> {
  const admin = getAdminSql();
  const loginIdentifier = `limited-${owner.tenantId}@example.com`;

  const profileRows = (await admin`
    INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
    VALUES (${owner.tenantId}, 'person', 'Limited')
    RETURNING id
  `) as { id: string }[];

  const passwordHash = await hashPassword(OWNER_PASSWORD);
  const identityRows = (await admin`
    INSERT INTO awcms_mini_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${owner.tenantId}, ${profileRows[0]!.id}, ${loginIdentifier}, ${passwordHash})
    RETURNING id
  `) as { id: string }[];

  const tenantUserRows = (await admin`
    INSERT INTO awcms_mini_tenant_users (tenant_id, identity_id)
    VALUES (${owner.tenantId}, ${identityRows[0]!.id})
    RETURNING id
  `) as { id: string }[];
  const tenantUserId = tenantUserRows[0]!.id;

  const roleRows = (await admin`
    INSERT INTO awcms_mini_roles (tenant_id, role_code, role_name, is_system)
    VALUES (${owner.tenantId}, 'limited', 'Limited', false)
    RETURNING id
  `) as { id: string }[];

  for (const grant of grants) {
    await admin`
      INSERT INTO awcms_mini_role_permissions (tenant_id, role_id, permission_id)
      SELECT ${owner.tenantId}, ${roleRows[0]!.id}, id FROM awcms_mini_permissions
      WHERE module_key = ${grant.moduleKey} AND activity_code = ${grant.activityCode} AND action = ${grant.action}
    `;
  }

  await admin`
    INSERT INTO awcms_mini_access_assignments (tenant_id, tenant_user_id, role_id, assigned_by)
    VALUES (${owner.tenantId}, ${tenantUserId}, ${roleRows[0]!.id}, ${owner.tenantUserId})
  `;

  const login = await invoke<{ data: { token: string } }>(authLogin, {
    method: "POST",
    path: "/api/v1/auth/login",
    headers: {
      "content-type": "application/json",
      "x-awcms-mini-tenant-id": owner.tenantId
    },
    body: { loginIdentifier, password: OWNER_PASSWORD },
    cookies: createCookieJar()
  });
  expect(login.status).toBe(200);

  return {
    tenantId: owner.tenantId,
    token: login.body.data.token,
    tenantUserId
  };
}

function authHeaders(
  owner: Bootstrap,
  idempotencyKey?: string
): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-awcms-mini-tenant-id": owner.tenantId,
    authorization: `Bearer ${owner.token}`,
    ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {})
  };
}

/** `invoke()` (harness.ts) only ever JSON-encodes its body -- the stage-upload endpoint needs a real `multipart/form-data` body, so this mirrors `invoke()`'s own context-building shape for a `FormData` body instead. */
async function invokeMultipart<T = unknown>(
  handler: typeof stageImport,
  options: {
    path: string;
    headers?: Record<string, string>;
    formData: FormData;
    cookies?: CookieJar;
  }
): Promise<{ status: number; body: T; response: Response }> {
  const url = new URL(`http://integration.test${options.path}`);
  const request = new Request(url.toString(), {
    method: "POST",
    headers: options.headers,
    body: options.formData
  });

  const context = {
    request,
    url,
    params: {},
    locals: {},
    cookies: options.cookies ?? createCookieJar()
  } as unknown as APIContext;

  const response = await handler(context);
  const text = await response.text();
  const body = text.length > 0 ? (JSON.parse(text) as T) : (undefined as T);

  return { status: response.status, body, response };
}

async function stageCsv(
  owner: Bootstrap,
  csvContent: string,
  idempotencyKey: string,
  importKey = REFERENCE_ITEMS_KEY
): Promise<{ status: number; body: any }> {
  const formData = new FormData();
  formData.set("importKey", importKey);
  formData.set("format", "csv");
  formData.set(
    "file",
    new File([csvContent], "reference-items.csv", { type: "text/csv" })
  );

  return invokeMultipart(stageImport, {
    path: "/api/v1/data-exchange/imports",
    headers: {
      "x-awcms-mini-tenant-id": owner.tenantId,
      authorization: `Bearer ${owner.token}`,
      "idempotency-key": idempotencyKey
    },
    formData
  });
}

/** Runs the real worker pass repeatedly until it reports zero total work for a tenant, or `maxPasses` is hit -- mirrors `runBoundedBatches`'s own "count -> keep looping, 0 -> drained" contract without importing that internal helper. */
async function drainWorker(
  sql: Bun.SQL,
  tenantId: string,
  maxPasses = 10
): Promise<void> {
  for (let i = 0; i < maxPasses; i += 1) {
    const result = await runDataExchangeWorkerPassForTenant(sql, tenantId);
    if (result.count === 0) return;
  }
}

const suite = integrationEnabled ? describe : describe.skip;

suite("data_exchange integration", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
    await provisionWorkerRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(() => {
    resetExchangeAdaptersForTests();
  });

  describe("full pipeline: stage -> validate -> preview -> commit (create/update/conflict)", () => {
    test("create/update/conflict proposed actions are computed and committed correctly", async () => {
      const owner = await bootstrap();
      const sql = getWorkerTestSql();

      // Pre-seed two existing reference items directly (simulating prior data).
      await sql.begin(async (tx) => {
        await tx.unsafe(
          `SET LOCAL app.current_tenant_id = '${owner.tenantId}'`
        );
        await tx`
          INSERT INTO awcms_mini_data_exchange_reference_items (tenant_id, code, label, value, status)
          VALUES (${owner.tenantId}, 'widget-b', 'Old Label', 5, 'active')
        `;
        await tx`
          INSERT INTO awcms_mini_data_exchange_reference_items (tenant_id, code, label, value, status)
          VALUES (${owner.tenantId}, 'widget-c', 'Widget C', 20, 'active')
        `;
      });

      const csv =
        "code,label,value,expectedValue\n" +
        "widget-a,Widget A,10,\n" +
        "widget-b,Widget B Updated,7,\n" +
        "widget-c,Should Not Apply,99,999\n";

      const stage = await stageCsv(owner, csv, "stage-key-1");
      expect(stage.status).toBe(200);
      const batchId = stage.body.data.batch.id;

      await drainWorker(sql, owner.tenantId);

      const afterValidate = await invoke<{ data: { batch: any } }>(
        getImportBatchRoute,
        {
          method: "GET",
          path: `/api/v1/data-exchange/imports/${batchId}`,
          params: { id: batchId },
          headers: authHeaders(owner)
        }
      );
      expect(afterValidate.status).toBe(200);
      expect(afterValidate.body.data.batch.status).toBe("previewed");
      expect(afterValidate.body.data.batch.createdCount).toBe(1);
      expect(afterValidate.body.data.batch.updatedCount).toBe(1);
      expect(afterValidate.body.data.batch.conflictCount).toBe(1);

      const preview = await invoke<{ data: { rows: any[] } }>(getPreview, {
        method: "GET",
        path: `/api/v1/data-exchange/imports/${batchId}/preview`,
        params: { id: batchId },
        headers: authHeaders(owner)
      });
      expect(preview.status).toBe(200);
      const byCode = new Map(
        preview.body.data.rows.map((r: any) => [r.naturalKey, r.proposedAction])
      );
      expect(byCode.get("widget-a")).toBe("create");
      expect(byCode.get("widget-b")).toBe("update");
      expect(byCode.get("widget-c")).toBe("conflict");

      const commit = await invoke<{ data: { batch: any } }>(commitImport, {
        method: "POST",
        path: `/api/v1/data-exchange/imports/${batchId}/commit`,
        params: { id: batchId },
        headers: authHeaders(owner, "commit-key-1")
      });
      expect(commit.status).toBe(200);
      expect(commit.body.data.batch.status).toBe("committing");

      await drainWorker(sql, owner.tenantId);

      const afterCommit = await invoke<{ data: { batch: any } }>(
        getImportBatchRoute,
        {
          method: "GET",
          path: `/api/v1/data-exchange/imports/${batchId}`,
          params: { id: batchId },
          headers: authHeaders(owner)
        }
      );
      expect(afterCommit.body.data.batch.status).toBe("committed");

      // widget-a: created.
      const widgetA = await sql.begin(async (tx) => {
        await tx.unsafe(
          `SET LOCAL app.current_tenant_id = '${owner.tenantId}'`
        );
        return findReferenceItemByCode(tx, owner.tenantId, "widget-a");
      });
      expect(widgetA?.label).toBe("Widget A");
      expect(widgetA?.value).toBe(10);

      // widget-b: updated.
      const widgetB = await sql.begin(async (tx) => {
        await tx.unsafe(
          `SET LOCAL app.current_tenant_id = '${owner.tenantId}'`
        );
        return findReferenceItemByCode(tx, owner.tenantId, "widget-b");
      });
      expect(widgetB?.label).toBe("Widget B Updated");
      expect(widgetB?.value).toBe(7);

      // widget-c: UNCHANGED (conflict rows are never committed).
      const widgetC = await sql.begin(async (tx) => {
        await tx.unsafe(
          `SET LOCAL app.current_tenant_id = '${owner.tenantId}'`
        );
        return findReferenceItemByCode(tx, owner.tenantId, "widget-c");
      });
      expect(widgetC?.label).toBe("Widget C");
      expect(widgetC?.value).toBe(20);

      // Reconciliation was recorded and matches (2 intended, 2 committed).
      const reconciliation = await invoke<{ data: { reports: any[] } }>(
        getReconciliation,
        {
          method: "GET",
          path: `/api/v1/data-exchange/reconciliation/import/${batchId}`,
          params: { subjectType: "import", subjectId: batchId },
          headers: authHeaders(owner)
        }
      );
      expect(reconciliation.status).toBe(200);
      expect(reconciliation.body.data.reports.length).toBe(1);
      expect(reconciliation.body.data.reports[0].mismatch).toBe(false);
      expect(reconciliation.body.data.reports[0].sourceCount).toBe(2);
      expect(reconciliation.body.data.reports[0].processedCount).toBe(2);
    });

    test("Idempotency-Key replay on stage-upload returns the same batch, does not create a second one", async () => {
      const owner = await bootstrap();
      const csv = "code,label\nwidget-a,Widget A\n";

      const first = await stageCsv(owner, csv, "same-stage-key");
      expect(first.status).toBe(200);

      const second = await stageCsv(owner, csv, "same-stage-key");
      expect(second.status).toBe(200);
      expect(second.body.data.batch.id).toBe(first.body.data.batch.id);

      const list = await invoke<{ data: { batches: any[] } }>(listImports, {
        method: "GET",
        path: "/api/v1/data-exchange/imports",
        headers: authHeaders(owner)
      });
      expect(list.body.data.batches.length).toBe(1);
    });

    test("stage-upload without Idempotency-Key is rejected", async () => {
      const owner = await bootstrap();
      const formData = new FormData();
      formData.set("importKey", REFERENCE_ITEMS_KEY);
      formData.set("format", "csv");
      formData.set("file", new File(["code,label\na,A\n"], "f.csv"));

      const result = await invokeMultipart(stageImport, {
        path: "/api/v1/data-exchange/imports",
        headers: {
          "x-awcms-mini-tenant-id": owner.tenantId,
          authorization: `Bearer ${owner.token}`
        },
        formData
      });

      expect(result.status).toBe(400);
      expect((result.body as any).error.code).toBe("IDEMPOTENCY_REQUIRED");
    });
  });

  describe("partial-failure-then-resume idempotency", () => {
    test("a retryable commit failure is retried on the next pass WITHOUT double-applying the row", async () => {
      const owner = await bootstrap();
      const sql = getWorkerTestSql();

      let commitAttempts = 0;
      let realApplyCount = 0;

      const flakyAdapter: DataExchangeAdapterPort = {
        importKey: REFERENCE_ITEMS_KEY,
        schemaVersion: "1.0",
        validateRow: referenceItemsImportAdapter.validateRow,
        async commitRow(
          tx,
          tenantId,
          row,
          proposedAction,
          naturalKey
        ): Promise<DataExchangeCommitOutcome> {
          commitAttempts += 1;
          if (naturalKey === "flaky-widget" && commitAttempts === 1) {
            // Simulate a transient failure on the FIRST attempt only.
            return {
              committed: false,
              retryable: true,
              reason: "simulated transient failure"
            };
          }
          realApplyCount += 1;
          return referenceItemsImportAdapter.commitRow(
            tx,
            tenantId,
            row,
            proposedAction,
            naturalKey
          );
        }
      };
      registerExchangeAdapterForTests({
        registryKey: "reference_items",
        importAdapter: flakyAdapter
      });

      const csv = "code,label\nflaky-widget,Flaky Widget\n";
      const stage = await stageCsv(owner, csv, "flaky-stage-key");
      expect(stage.status).toBe(200);
      const batchId = stage.body.data.batch.id;

      // Validate pass only.
      await runDataExchangeWorkerPassForTenant(sql, owner.tenantId);

      const commit = await invoke<{ data: { batch: any } }>(commitImport, {
        method: "POST",
        path: `/api/v1/data-exchange/imports/${batchId}/commit`,
        params: { id: batchId },
        headers: authHeaders(owner, "flaky-commit-key")
      });
      expect(commit.status).toBe(200);

      // Pass 1: the ONLY row fails retryably -- batch must stay "committing", not advance.
      const pass1 = await runDataExchangeWorkerPassForTenant(
        sql,
        owner.tenantId
      );
      expect(pass1.committed).toBe(0);

      const afterPass1 = await invoke<{ data: { batch: any } }>(
        getImportBatchRoute,
        {
          method: "GET",
          path: `/api/v1/data-exchange/imports/${batchId}`,
          params: { id: batchId },
          headers: authHeaders(owner)
        }
      );
      expect(afterPass1.body.data.batch.status).toBe("committing");

      // Pass 2 (simulating the NEXT scheduled worker tick / a resume after a
      // worker restart): the same row is retried and now succeeds.
      const pass2 = await runDataExchangeWorkerPassForTenant(
        sql,
        owner.tenantId
      );
      expect(pass2.committed).toBe(1);

      const afterPass2 = await invoke<{ data: { batch: any } }>(
        getImportBatchRoute,
        {
          method: "GET",
          path: `/api/v1/data-exchange/imports/${batchId}`,
          params: { id: batchId },
          headers: authHeaders(owner)
        }
      );
      expect(afterPass2.body.data.batch.status).toBe("committed");

      // The critical assertion: the REAL adapter's write path only ever
      // executed ONCE, despite commitRow being invoked twice for the same
      // row (once failing, once succeeding) -- no double-apply.
      expect(realApplyCount).toBe(1);
      expect(commitAttempts).toBe(2);

      const item = await sql.begin(async (tx) => {
        await tx.unsafe(
          `SET LOCAL app.current_tenant_id = '${owner.tenantId}'`
        );
        return findReferenceItemByCode(tx, owner.tenantId, "flaky-widget");
      });
      expect(item?.label).toBe("Flaky Widget");

      // A THIRD pass (simulating yet another tick / an explicit retry
      // request) must be a pure no-op -- the row is already committed, so
      // it is never re-selected (commit_status = 'pending' only).
      const pass3 = await runDataExchangeWorkerPassForTenant(
        sql,
        owner.tenantId
      );
      expect(pass3.committed).toBe(0);
      expect(realApplyCount).toBe(1);
    });

    test("a non-retryable commit failure marks the batch partially_committed, and retry resumes remaining rows", async () => {
      const owner = await bootstrap();
      const sql = getWorkerTestSql();

      const csv =
        "code,label\n" +
        "widget-ok,Widget OK\n" +
        "widget-missing,Should Fail\n";
      const stage = await stageCsv(owner, csv, "partial-stage-key");
      const batchId = stage.body.data.batch.id;

      await runDataExchangeWorkerPassForTenant(sql, owner.tenantId);

      // Force "widget-missing" to fail non-retryably: mark its staged row
      // proposedAction "update" (pointing at a target that will never
      // exist) by rewriting the row directly -- simulates a source record
      // deleted between preview and commit.
      await getAdminSql()`
        UPDATE awcms_mini_data_exchange_staged_rows
        SET proposed_action = 'update'
        WHERE tenant_id = ${owner.tenantId} AND import_batch_id = ${batchId} AND natural_key = 'widget-missing'
      `;

      const commit = await invoke(commitImport, {
        method: "POST",
        path: `/api/v1/data-exchange/imports/${batchId}/commit`,
        params: { id: batchId },
        headers: authHeaders(owner, "partial-commit-key")
      });
      expect(commit.status).toBe(200);

      await drainWorker(sql, owner.tenantId);

      const afterCommit = await invoke<{ data: { batch: any } }>(
        getImportBatchRoute,
        {
          method: "GET",
          path: `/api/v1/data-exchange/imports/${batchId}`,
          params: { id: batchId },
          headers: authHeaders(owner)
        }
      );
      expect(afterCommit.body.data.batch.status).toBe("partially_committed");
      expect(afterCommit.body.data.batch.failedCount).toBe(1);

      const okItem = await sql.begin(async (tx) => {
        await tx.unsafe(
          `SET LOCAL app.current_tenant_id = '${owner.tenantId}'`
        );
        return findReferenceItemByCode(tx, owner.tenantId, "widget-ok");
      });
      expect(okItem).not.toBeNull();

      // Retry: the already-failed row stays failed (not re-selected --
      // commit_status is no longer 'pending'), batch resolves back to
      // partially_committed (never re-processes the terminal row).
      const retry = await invoke<{ data: { batch: any } }>(retryImport, {
        method: "POST",
        path: `/api/v1/data-exchange/imports/${batchId}/retry`,
        params: { id: batchId },
        headers: authHeaders(owner, "retry-key-1")
      });
      expect(retry.status).toBe(200);
      expect(retry.body.data.batch.status).toBe("committing");

      await drainWorker(sql, owner.tenantId);

      const afterRetry = await invoke<{ data: { batch: any } }>(
        getImportBatchRoute,
        {
          method: "GET",
          path: `/api/v1/data-exchange/imports/${batchId}`,
          params: { id: batchId },
          headers: authHeaders(owner)
        }
      );
      expect(afterRetry.body.data.batch.status).toBe("partially_committed");
      expect(afterRetry.body.data.batch.failedCount).toBe(1);
    });
  });

  describe("export + manifest/checksum + reconciliation", () => {
    test("export produces a manifest, checksum, and a downloadable file", async () => {
      const owner = await bootstrap();
      const sql = getWorkerTestSql();

      await sql.begin(async (tx) => {
        await tx.unsafe(
          `SET LOCAL app.current_tenant_id = '${owner.tenantId}'`
        );
        await tx`
          INSERT INTO awcms_mini_data_exchange_reference_items (tenant_id, code, label, value, status)
          VALUES (${owner.tenantId}, 'widget-x', 'Widget X', 42, 'active')
        `;
      });

      const create = await invoke<{ data: { job: any } }>(createExportRoute, {
        method: "POST",
        path: "/api/v1/data-exchange/exports",
        headers: authHeaders(owner, "export-key-1"),
        body: { exportKey: REFERENCE_ITEMS_KEY, format: "csv" }
      });
      expect(create.status).toBe(200);
      const jobId = create.body.data.job.id;

      await drainWorker(sql, owner.tenantId);

      const job = await invoke<{ data: { job: any } }>(getExportJobRoute, {
        method: "GET",
        path: `/api/v1/data-exchange/exports/${jobId}`,
        params: { id: jobId },
        headers: authHeaders(owner)
      });
      expect(job.body.data.job.status).toBe("completed");
      expect(job.body.data.job.rowCount).toBe(1);
      expect(job.body.data.job.checksumSha256).toBeTruthy();
      expect(job.body.data.job.manifest.rowCount).toBe(1);

      const download = await invokeRaw(downloadExportRoute, {
        method: "GET",
        path: `/api/v1/data-exchange/exports/${jobId}/download`,
        params: { id: jobId },
        headers: authHeaders(owner)
      });
      expect(download.status).toBe(200);
      expect(download.response.headers.get("content-type")).toContain(
        "text/csv"
      );
      expect(download.text).toContain("widget-x");
      expect(download.text).toContain("Widget X");

      const reconciliation = await invoke<{ data: { reports: any[] } }>(
        getReconciliation,
        {
          method: "GET",
          path: `/api/v1/data-exchange/reconciliation/export/${jobId}`,
          params: { subjectType: "export", subjectId: jobId },
          headers: authHeaders(owner)
        }
      );
      expect(reconciliation.body.data.reports[0].mismatch).toBe(false);
    });

    test("a deliberate source/processed count mismatch is detected by reconciliation", async () => {
      const owner = await bootstrap();
      const sql = getWorkerTestSql();

      await sql.begin(async (tx) => {
        await tx.unsafe(
          `SET LOCAL app.current_tenant_id = '${owner.tenantId}'`
        );
        await tx`
          INSERT INTO awcms_mini_data_exchange_reference_items (tenant_id, code, label, value, status)
          VALUES (${owner.tenantId}, 'widget-y', 'Widget Y', 1, 'active')
        `;
      });

      // Fault-injecting export adapter: claims a DIFFERENT (larger) source
      // count than what fetchRowsPage actually yields -- a deliberate,
      // deterministic mismatch.
      registerExchangeAdapterForTests({
        registryKey: "reference_items",
        exportAdapter: {
          exportKey: REFERENCE_ITEMS_KEY,
          schemaVersion: "1.0",
          async countRows() {
            return 5; // Lies: claims 5 when only 1 row actually exists.
          },
          async fetchRowsPage(tx, tenantId, filterScope, afterCursor, limit) {
            return {
              rows: [
                {
                  code: "widget-y",
                  label: "Widget Y",
                  value: 1,
                  status: "active"
                }
              ],
              nextCursor: null
            };
          }
        }
      });

      const create = await invoke<{ data: { job: any } }>(createExportRoute, {
        method: "POST",
        path: "/api/v1/data-exchange/exports",
        headers: authHeaders(owner, "export-mismatch-key"),
        body: { exportKey: REFERENCE_ITEMS_KEY, format: "csv" }
      });
      const jobId = create.body.data.job.id;

      await drainWorker(sql, owner.tenantId);

      const reconciliation = await invoke<{ data: { reports: any[] } }>(
        getReconciliation,
        {
          method: "GET",
          path: `/api/v1/data-exchange/reconciliation/export/${jobId}`,
          params: { subjectType: "export", subjectId: jobId },
          headers: authHeaders(owner)
        }
      );
      expect(reconciliation.body.data.reports.length).toBe(1);
      expect(reconciliation.body.data.reports[0].mismatch).toBe(true);
      expect(reconciliation.body.data.reports[0].sourceCount).toBe(5);
      expect(reconciliation.body.data.reports[0].processedCount).toBe(1);
    });
  });

  describe("formula injection (CSV injection) round-trips safely end-to-end", () => {
    test("=1+1 and @SUM(...) never reach export un-neutralized", async () => {
      const owner = await bootstrap();
      const sql = getWorkerTestSql();

      const csv = 'code,label\nevil-a,"=1+1"\nevil-b,"@SUM(A1:A10)"\n';
      const stage = await stageCsv(owner, csv, "formula-stage-key");
      const batchId = stage.body.data.batch.id;

      await drainWorker(sql, owner.tenantId);

      const preview = await invoke<{ data: { rows: any[] } }>(getPreview, {
        method: "GET",
        path: `/api/v1/data-exchange/imports/${batchId}/preview`,
        params: { id: batchId },
        headers: authHeaders(owner)
      });
      const labels = preview.body.data.rows.map((r: any) => r.fields.label);
      // Neutralized BEFORE storage -- never a raw leading `=`/`@`.
      expect(labels).toContain("'=1+1");
      expect(labels).toContain("'@SUM(A1:A10)");
      for (const label of labels) {
        expect(/^[=+\-@\t\r]/.test(label)).toBe(false);
      }

      const commit = await invoke(commitImport, {
        method: "POST",
        path: `/api/v1/data-exchange/imports/${batchId}/commit`,
        params: { id: batchId },
        headers: authHeaders(owner, "formula-commit-key")
      });
      expect(commit.status).toBe(200);
      await drainWorker(sql, owner.tenantId);

      const create = await invoke<{ data: { job: any } }>(createExportRoute, {
        method: "POST",
        path: "/api/v1/data-exchange/exports",
        headers: authHeaders(owner, "formula-export-key"),
        body: { exportKey: REFERENCE_ITEMS_KEY, format: "csv" }
      });
      const jobId = create.body.data.job.id;
      await drainWorker(sql, owner.tenantId);

      const download = await invokeRaw(downloadExportRoute, {
        method: "GET",
        path: `/api/v1/data-exchange/exports/${jobId}/download`,
        params: { id: jobId },
        headers: authHeaders(owner)
      });
      const text = download.text;

      // The raw dangerous shape must NEVER appear un-neutralized anywhere
      // in the exported artifact.
      expect(text).not.toContain(",=1+1");
      expect(text).not.toContain(",@SUM(A1:A10)");
      expect(text).toContain("'=1+1");
      expect(text).toContain("'@SUM(A1:A10)");
    });
  });

  describe("unbounded parsing is rejected", () => {
    test("a row count exceeding the descriptor's maxRowCount fails the batch instead of hanging", async () => {
      const owner = await bootstrap();
      const sql = getWorkerTestSql();

      // reference_items descriptor limits.maxRowCount = 5000 -- 5001 tiny
      // rows exceeds it while staying well under the 5 MiB HTTP cap.
      const rows = Array.from({ length: 5001 }, (_, i) => `w${i},L${i}`).join(
        "\n"
      );
      const csv = `code,label\n${rows}\n`;

      const stage = await stageCsv(owner, csv, "oversized-rows-key");
      expect(stage.status).toBe(200);
      const batchId = stage.body.data.batch.id;

      await drainWorker(sql, owner.tenantId);

      const batch = await invoke<{ data: { batch: any } }>(
        getImportBatchRoute,
        {
          method: "GET",
          path: `/api/v1/data-exchange/imports/${batchId}`,
          params: { id: batchId },
          headers: authHeaders(owner)
        }
      );
      expect(batch.body.data.batch.status).toBe("failed");
      expect(batch.body.data.batch.errorSummary).toContain("maxRowCount");
    });

    test("a file exceeding the HTTP body-size tier is rejected with 413 before any parsing", async () => {
      const owner = await bootstrap();

      const oversizedContent = "a".repeat(6 * 1024 * 1024); // > 5 MiB "large" tier.
      const formData = new FormData();
      formData.set("importKey", REFERENCE_ITEMS_KEY);
      formData.set("format", "csv");
      formData.set(
        "file",
        new File([oversizedContent], "huge.csv", { type: "text/csv" })
      );

      const result = await invokeMultipart(stageImport, {
        path: "/api/v1/data-exchange/imports",
        headers: {
          "x-awcms-mini-tenant-id": owner.tenantId,
          authorization: `Bearer ${owner.token}`,
          "idempotency-key": "oversized-http-key"
        },
        formData
      });

      expect(result.status).toBe(413);
      expect((result.body as any).error.code).toBe("PAYLOAD_TOO_LARGE");
    });
  });

  describe("cross-tenant isolation and ABAC default-deny", () => {
    test("tenant B cannot read, preview, or cancel tenant A's import batch (RLS)", async () => {
      const ownerA = await bootstrap("tenant-a", "Tenant A");
      const ownerB = await bootstrapSecondTenant("tenant-b", "Tenant B");

      const stage = await stageCsv(
        ownerA,
        "code,label\nwidget-a,Widget A\n",
        "cross-tenant-key"
      );
      const batchId = stage.body.data.batch.id;

      const getAsB = await invoke(getImportBatchRoute, {
        method: "GET",
        path: `/api/v1/data-exchange/imports/${batchId}`,
        params: { id: batchId },
        headers: authHeaders(ownerB)
      });
      expect(getAsB.status).toBe(404);

      const previewAsB = await invoke(getPreview, {
        method: "GET",
        path: `/api/v1/data-exchange/imports/${batchId}/preview`,
        params: { id: batchId },
        headers: authHeaders(ownerB)
      });
      expect(previewAsB.status).toBe(404);

      const cancelAsB = await invoke(cancelImport, {
        method: "POST",
        path: `/api/v1/data-exchange/imports/${batchId}/cancel`,
        params: { id: batchId },
        headers: authHeaders(ownerB, "cross-tenant-cancel-key"),
        body: { reason: "should not work" }
      });
      expect(cancelAsB.status).toBe(404);

      // Tenant B's own list is empty -- tenant A's batch never leaks in.
      const listAsB = await invoke<{ data: { batches: any[] } }>(listImports, {
        method: "GET",
        path: "/api/v1/data-exchange/imports",
        headers: authHeaders(ownerB)
      });
      expect(listAsB.body.data.batches).toEqual([]);
    });

    test("a subject with no permissions is denied (default deny)", async () => {
      const owner = await bootstrap();
      const noAccess = await bootstrapNoAccessUser(owner);

      const result = await invoke(listImports, {
        method: "GET",
        path: "/api/v1/data-exchange/imports",
        headers: authHeaders(noAccess)
      });

      expect(result.status).toBe(403);
      expect((result.body as any).error.code).toBe("ACCESS_DENIED");
    });
  });

  describe("media-type verification (reviewer finding on PR #782)", () => {
    test("a disallowed Content-Type is rejected with 415 before any parsing", async () => {
      const owner = await bootstrap();
      const formData = new FormData();
      formData.set("importKey", REFERENCE_ITEMS_KEY);
      formData.set("format", "csv");
      // Bun's `Request`/`FormData` multipart round-trip derives `File.type`
      // from the FILENAME EXTENSION, not from an explicit `type` option or
      // even an explicit per-part `Content-Type` header (verified directly
      // against this runtime) -- so the filename extension, not the `type`
      // constructor option, is what actually reaches the route as
      // `file.type` here. Using a `.png` filename is what genuinely
      // exercises the disallowed-media-type path end-to-end.
      formData.set(
        "file",
        new File(["code,label\na,A\n"], "malicious.png", {
          type: "image/png"
        })
      );

      const result = await invokeMultipart(stageImport, {
        path: "/api/v1/data-exchange/imports",
        headers: {
          "x-awcms-mini-tenant-id": owner.tenantId,
          authorization: `Bearer ${owner.token}`,
          "idempotency-key": "media-type-key"
        },
        formData
      });

      expect(result.status).toBe(415);
      expect((result.body as any).error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
    });

    test("an allowed Content-Type (text/csv) is accepted", async () => {
      const owner = await bootstrap();
      const stage = await stageCsv(
        owner,
        "code,label\na,A\n",
        "media-type-ok-key"
      );
      expect(stage.status).toBe(200);
    });
  });

  describe("worker transaction-per-item isolation (reviewer finding on PR #782)", () => {
    test("an exception in ONE batch's processing does not roll back an unrelated batch's already-committed work in the same pass", async () => {
      const owner = await bootstrap();
      const sql = getWorkerTestSql();

      const throwingAdapter: DataExchangeAdapterPort = {
        importKey: REFERENCE_ITEMS_KEY,
        schemaVersion: "1.0",
        async validateRow(tx, tenantId, row) {
          if (row.code === "explode") {
            throw new Error(
              "simulated bug -- this must not roll back an unrelated batch's work"
            );
          }
          return referenceItemsImportAdapter.validateRow(tx, tenantId, row);
        },
        commitRow: referenceItemsImportAdapter.commitRow
      };
      registerExchangeAdapterForTests({
        registryKey: "reference_items",
        importAdapter: throwingAdapter
      });

      // Batch A is staged FIRST (earlier created_at), so the worker
      // processes it before batch B in the same pass (both queried
      // `ORDER BY created_at ASC`).
      const stageA = await stageCsv(
        owner,
        "code,label\nwidget-a,Widget A\n",
        "isolation-a-key"
      );
      expect(stageA.status).toBe(200);
      const batchAId = stageA.body.data.batch.id;

      const stageB = await stageCsv(
        owner,
        "code,label\nexplode,Boom\n",
        "isolation-b-key"
      );
      expect(stageB.status).toBe(200);
      const batchBId = stageB.body.data.batch.id;

      // The pass throws (batch B's validate pass propagates the simulated
      // bug) -- caught manually (never `expect(...).rejects`, which can
      // hang on a raw Bun.SQL-backed promise, project convention).
      let caughtError: unknown = null;
      try {
        await runDataExchangeWorkerPassForTenant(sql, owner.tenantId);
      } catch (error) {
        caughtError = error;
      }
      expect(caughtError).toBeInstanceOf(Error);

      const afterA = await invoke<{ data: { batch: any } }>(
        getImportBatchRoute,
        {
          method: "GET",
          path: `/api/v1/data-exchange/imports/${batchAId}`,
          params: { id: batchAId },
          headers: authHeaders(owner)
        }
      );
      // Batch A's OWN transaction committed independently -- unaffected by
      // batch B's later exception in the SAME pass (the fix under test).
      expect(afterA.body.data.batch.status).toBe("previewed");

      const afterB = await invoke<{ data: { batch: any } }>(
        getImportBatchRoute,
        {
          method: "GET",
          path: `/api/v1/data-exchange/imports/${batchBId}`,
          params: { id: batchBId },
          headers: authHeaders(owner)
        }
      );
      // Batch B's OWN transaction rolled back in full (including its own
      // staged -> validating status flip) -- never reached "previewed".
      expect(afterB.body.data.batch.status).toBe("staged");

      // A later pass (simulating the next scheduled tick), with the bug
      // "fixed" (reset to the real adapter), lets batch B proceed normally
      // -- proves the earlier failure did not corrupt/strand it either.
      resetExchangeAdaptersForTests();
      await drainWorker(sql, owner.tenantId);
      const batchBRetried = await invoke<{ data: { batch: any } }>(
        getImportBatchRoute,
        {
          method: "GET",
          path: `/api/v1/data-exchange/imports/${batchBId}`,
          params: { id: batchBId },
          headers: authHeaders(owner)
        }
      );
      expect(batchBRetried.body.data.batch.status).toBe("previewed");
    });
  });

  describe("ExchangeDescriptor.requiredPermission enforcement (security-auditor finding on PR #782)", () => {
    test("denies a subject who lacks the descriptor's requiredPermission, allows once granted", async () => {
      const owner = await bootstrap();
      const limited = await bootstrapLimitedUser(owner, [
        { moduleKey: "data_exchange", activityCode: "imports", action: "read" }
      ]);

      const syntheticDescriptor: ExchangeDescriptor = {
        key: "data_exchange.synthetic_test_descriptor",
        ownerModuleKey: "data_exchange",
        direction: "both",
        formats: ["csv"],
        schemaVersion: "1.0",
        limits: { maxFileBytes: 1024, maxRowCount: 10, maxFieldsPerRow: 5 },
        adapterRegistryKey: "reference_items",
        requiredPermission: "identity_access.user_management.read",
        sensitiveFields: { fieldNames: [] },
        description:
          "synthetic descriptor for requiredPermission enforcement test"
      };

      const appSql = getDatabaseClient();
      const limitedTokenHash = hashSessionToken(limited.token);

      const denyResult = await withTenant(appSql, owner.tenantId, (tx) =>
        authorizeExchangeDescriptorPermission(
          tx,
          owner.tenantId,
          limitedTokenHash,
          new Date(),
          syntheticDescriptor
        )
      );
      expect(denyResult.allowed).toBe(false);
      if (!denyResult.allowed) {
        expect(denyResult.denied.status).toBe(403);
      }

      // Grant the descriptor's required permission and retry -- now allowed.
      const admin = getAdminSql();
      await admin`
        INSERT INTO awcms_mini_role_permissions (tenant_id, role_id, permission_id)
        SELECT ${owner.tenantId}, r.id, p.id
        FROM awcms_mini_roles r, awcms_mini_permissions p
        WHERE r.tenant_id = ${owner.tenantId} AND r.role_code = 'limited'
          AND p.module_key = 'identity_access' AND p.activity_code = 'user_management' AND p.action = 'read'
      `;

      const allowResult = await withTenant(appSql, owner.tenantId, (tx) =>
        authorizeExchangeDescriptorPermission(
          tx,
          owner.tenantId,
          limitedTokenHash,
          new Date(),
          syntheticDescriptor
        )
      );
      expect(allowResult.allowed).toBe(true);
    });

    /**
     * PR #839 security review, HIGH 1. `src/pages/admin/data-exchange/
     * imports/[id].astro` does not go through any of the six routes — it
     * queries and projects staged rows itself — and made this decision
     * NOWHERE, so a descriptor's `requiredPermission` was enforced by every
     * API surface and by nothing in the UI.
     *
     * The page cannot reuse `authorizeExchangeDescriptorPermission` (it has
     * a permission set from `resolveSsrContext`, not a bearer token), so the
     * risk is that the two gates drift apart again. This pins them TOGETHER
     * against one real subject and one real database: the SSR decision must
     * equal the route decision, before and after the grant.
     */
    test("the SSR page gate agrees with the route gate for the same real subject", async () => {
      const owner = await bootstrap();
      const limited = await bootstrapLimitedUser(owner, [
        { moduleKey: "data_exchange", activityCode: "imports", action: "read" }
      ]);

      const syntheticDescriptor: ExchangeDescriptor = {
        key: "data_exchange.synthetic_test_descriptor",
        ownerModuleKey: "data_exchange",
        direction: "both",
        formats: ["csv"],
        schemaVersion: "1.0",
        limits: { maxFileBytes: 1024, maxRowCount: 10, maxFieldsPerRow: 5 },
        adapterRegistryKey: "reference_items",
        requiredPermission: "identity_access.user_management.read",
        // An EMPTY sensitiveFields policy: the exploit shape. The page's
        // raw-value gate treats this as "nothing sensitive" and renders
        // values unmasked, so `requiredPermission` is the ONLY thing
        // standing between this subject and the owning module's data.
        sensitiveFields: { fieldNames: [] },
        description:
          "synthetic descriptor for the SSR-vs-route gate parity test"
      };

      const appSql = getDatabaseClient();
      const limitedTokenHash = hashSessionToken(limited.token);

      // The exact permission set `src/lib/auth/ssr-session.ts` puts on
      // `Astro.locals.ssrContext` — same function, same tenant scope.
      const ssrPermissions = await withTenant(appSql, owner.tenantId, (tx) =>
        fetchGrantedPermissionKeys(tx, owner.tenantId, limited.tenantUserId)
      );

      // The subject really does hold the broad gate the page checks first —
      // otherwise this test would pass for the wrong reason.
      expect(ssrPermissions.has("data_exchange.imports.read")).toBe(true);

      expect(
        isDescriptorPermissionGranted(
          ssrPermissions,
          syntheticDescriptor.requiredPermission
        )
      ).toBe(false);

      const routeDeny = await withTenant(appSql, owner.tenantId, (tx) =>
        authorizeExchangeDescriptorPermission(
          tx,
          owner.tenantId,
          limitedTokenHash,
          new Date(),
          syntheticDescriptor
        )
      );
      expect(routeDeny.allowed).toBe(false);

      const admin = getAdminSql();
      await admin`
        INSERT INTO awcms_mini_role_permissions (tenant_id, role_id, permission_id)
        SELECT ${owner.tenantId}, r.id, p.id
        FROM awcms_mini_roles r, awcms_mini_permissions p
        WHERE r.tenant_id = ${owner.tenantId} AND r.role_code = 'limited'
          AND p.module_key = 'identity_access' AND p.activity_code = 'user_management' AND p.action = 'read'
      `;

      const grantedPermissions = await withTenant(
        appSql,
        owner.tenantId,
        (tx) =>
          fetchGrantedPermissionKeys(tx, owner.tenantId, limited.tenantUserId)
      );

      expect(
        isDescriptorPermissionGranted(
          grantedPermissions,
          syntheticDescriptor.requiredPermission
        )
      ).toBe(true);

      const routeAllow = await withTenant(appSql, owner.tenantId, (tx) =>
        authorizeExchangeDescriptorPermission(
          tx,
          owner.tenantId,
          limitedTokenHash,
          new Date(),
          syntheticDescriptor
        )
      );
      expect(routeAllow.allowed).toBe(true);
    });

    // Issue #820 Cacat 3: this test used to pass `null` (an unresolvable
    // descriptor) and assert `allowed: true` — it asserted the fail-open
    // itself. `null` is no longer representable at this signature; the
    // genuine no-op case is a RESOLVED descriptor declaring no extra
    // requirement, which is what this now covers. Each route's own handling
    // of an unresolvable descriptor is covered by the route tests below.
    test("a resolved descriptor with no requiredPermission is a no-op (always allowed)", async () => {
      const owner = await bootstrap();
      const noAccess = await bootstrapNoAccessUser(owner);
      const appSql = getDatabaseClient();

      const result = await withTenant(appSql, owner.tenantId, (tx) =>
        authorizeExchangeDescriptorPermission(
          tx,
          owner.tenantId,
          hashSessionToken(noAccess.token),
          new Date(),
          {
            key: "data_exchange.synthetic_test_descriptor",
            ownerModuleKey: "data_exchange",
            direction: "both",
            formats: ["csv"],
            schemaVersion: "1.0",
            limits: { maxFileBytes: 1024, maxRowCount: 10, maxFieldsPerRow: 5 },
            adapterRegistryKey: "reference_items",
            sensitiveFields: { fieldNames: [] },
            description: "synthetic descriptor with no requiredPermission"
          }
        )
      );
      expect(result.allowed).toBe(true);
    });

    test("a malformed requiredPermission string fails CLOSED (500), never silently open", async () => {
      const owner = await bootstrap();
      const appSql = getDatabaseClient();

      const result = await withTenant(appSql, owner.tenantId, (tx) =>
        authorizeExchangeDescriptorPermission(
          tx,
          owner.tenantId,
          hashSessionToken(owner.token),
          new Date(),
          {
            key: "data_exchange.synthetic_test_descriptor",
            ownerModuleKey: "data_exchange",
            direction: "both",
            formats: ["csv"],
            schemaVersion: "1.0",
            limits: { maxFileBytes: 1024, maxRowCount: 10, maxFieldsPerRow: 5 },
            adapterRegistryKey: "reference_items",
            // Only two segments -- not a valid "module.activity.action" key.
            requiredPermission: "not-a-valid-permission-key",
            sensitiveFields: { fieldNames: [] },
            description:
              "synthetic descriptor with a malformed requiredPermission"
          }
        )
      );

      // Even the FULLY-permissioned owner is denied -- a malformed
      // descriptor-declared permission is never silently treated as "no
      // extra requirement".
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.denied.status).toBe(500);
      }
    });

    test("exports/{id}/download enforces the resolved descriptor's requiredPermission end-to-end (security-auditor finding on PR #782 follow-up: download.ts was the one call site that resolved a descriptor without checking it)", async () => {
      const owner = await bootstrap();
      const sql = getWorkerTestSql();

      await sql.begin(async (tx) => {
        await tx.unsafe(
          `SET LOCAL app.current_tenant_id = '${owner.tenantId}'`
        );
        await tx`
          INSERT INTO awcms_mini_data_exchange_reference_items (tenant_id, code, label, value, status)
          VALUES (${owner.tenantId}, 'widget-download-guard', 'Widget Download Guard', 1, 'active')
        `;
      });

      const create = await invoke<{ data: { job: any } }>(createExportRoute, {
        method: "POST",
        path: "/api/v1/data-exchange/exports",
        headers: authHeaders(owner, "download-guard-export-key"),
        body: { exportKey: REFERENCE_ITEMS_KEY, format: "csv" }
      });
      const jobId = create.body.data.job.id;
      await drainWorker(sql, owner.tenantId);

      // Holds the generic `data_exchange.export_downloads.read` guard
      // download.ts's own top-level check requires, but nothing else --
      // the exact "plausible broad ops/support downloads exports role"
      // shape the security-auditor finding described.
      const limited = await bootstrapLimitedUser(owner, [
        {
          moduleKey: "data_exchange",
          activityCode: "export_downloads",
          action: "read"
        }
      ]);

      // `reference_items` ships with no `requiredPermission` today (this
      // module's README explains why -- no real owning-module adapter has
      // registered one yet). Proving `download.ts` genuinely calls
      // `authorizeExchangeDescriptorPermission` (not just that the
      // function itself works, already covered above) requires a
      // descriptor that DOES declare one -- so this temporarily overrides
      // the REAL, shared, process-global descriptor object for this
      // test's duration only, the same "mutate real shared registry state,
      // restore afterward" shape `registerExchangeAdapterForTests`/
      // `resetExchangeAdaptersForTests` already establish for adapters.
      const descriptor = dataExchangeModule.dataExchange?.find(
        (candidate) => candidate.key === REFERENCE_ITEMS_KEY
      );
      if (!descriptor) {
        throw new Error(
          "reference_items descriptor not found on dataExchangeModule -- test setup assumption broken."
        );
      }
      const originalRequiredPermission = descriptor.requiredPermission;
      descriptor.requiredPermission = "identity_access.user_management.read";

      try {
        const denied = await invokeRaw(downloadExportRoute, {
          method: "GET",
          path: `/api/v1/data-exchange/exports/${jobId}/download`,
          params: { id: jobId },
          headers: authHeaders(limited)
        });
        expect(denied.status).toBe(403);

        // The fully-permissioned owner (setup wizard grants every
        // permission to the owner role, including
        // identity_access.user_management.read) still succeeds -- proves
        // this is a real, targeted missing-permission denial, not a
        // blanket regression that would break every download.
        const allowed = await invokeRaw(downloadExportRoute, {
          method: "GET",
          path: `/api/v1/data-exchange/exports/${jobId}/download`,
          params: { id: jobId },
          headers: authHeaders(owner)
        });
        expect(allowed.status).toBe(200);
      } finally {
        descriptor.requiredPermission = originalRequiredPermission;
      }
    });
  });

  describe("export download audit trail (security-auditor finding on PR #782)", () => {
    test("downloading export file content writes an audit event distinct from the completion event", async () => {
      const owner = await bootstrap();
      const sql = getWorkerTestSql();

      await sql.begin(async (tx) => {
        await tx.unsafe(
          `SET LOCAL app.current_tenant_id = '${owner.tenantId}'`
        );
        await tx`
          INSERT INTO awcms_mini_data_exchange_reference_items (tenant_id, code, label, value, status)
          VALUES (${owner.tenantId}, 'widget-audit', 'Widget Audit', 1, 'active')
        `;
      });

      const create = await invoke<{ data: { job: any } }>(createExportRoute, {
        method: "POST",
        path: "/api/v1/data-exchange/exports",
        headers: authHeaders(owner, "audit-export-key"),
        body: { exportKey: REFERENCE_ITEMS_KEY, format: "csv" }
      });
      const jobId = create.body.data.job.id;
      await drainWorker(sql, owner.tenantId);

      const download = await invokeRaw(downloadExportRoute, {
        method: "GET",
        path: `/api/v1/data-exchange/exports/${jobId}/download`,
        params: { id: jobId },
        headers: authHeaders(owner)
      });
      expect(download.status).toBe(200);

      const admin = getAdminSql();
      const auditRows = (await admin`
        SELECT action, resource_type, resource_id, message
        FROM awcms_mini_audit_events
        WHERE tenant_id = ${owner.tenantId} AND resource_type = 'export_job'
          AND resource_id = ${jobId} AND action = 'export'
        ORDER BY created_at ASC
      `) as {
        action: string;
        resource_type: string;
        resource_id: string;
        message: string;
      }[];

      // One entry from the worker's own "export completed" audit
      // (export-execute-job.ts) and one from THIS download -- proving WHO
      // downloaded the artifact is now traceable, not just that the job
      // completed.
      expect(auditRows.length).toBeGreaterThanOrEqual(2);
      expect(auditRows.some((row) => row.message.includes("downloaded"))).toBe(
        true
      );
      expect(auditRows.some((row) => row.message.includes("completed"))).toBe(
        true
      );
    });
  });

  /**
   * Issue #820 (raw-value guard) + #831 (offset clamp), both on
   * `GET .../imports/{id}/preview`.
   *
   * These drive the REAL route handler, not the projection helpers in
   * isolation — the defects being fixed were precisely of the "the helper
   * is correct, nothing calls it / the route decides something else" class
   * (cf. #740/#769), which a helper-level test cannot detect.
   *
   * `resolveImportDescriptor` re-reads `listModules()` on every request, so
   * these tests swap the live `reference_items` descriptor's policy for the
   * duration of one test and restore it afterwards. That keeps the route,
   * the registry lookup and the permission checks all real, and is the only
   * way to exercise a sensitive descriptor today: no module in the base
   * declares one yet (which is exactly why these defects went unnoticed).
   */
  describe("preview raw-value guard (Issue #820) and offset clamp (Issue #831)", () => {
    const referenceDescriptor = dataExchangeModule.dataExchange!.find(
      (descriptor) => descriptor.key === REFERENCE_ITEMS_KEY
    )! as {
      sensitiveFields?: {
        fieldNames: readonly string[];
        rawValuePermission?: string;
        naturalKeyField?: string;
      };
    };
    const originalPolicy = referenceDescriptor.sensitiveFields;

    afterEach(() => {
      referenceDescriptor.sensitiveFields = originalPolicy;
    });

    async function stageAndValidate(owner: Bootstrap, idempotencyKey: string) {
      const stage = await stageCsv(
        owner,
        "code,label,value\nwidget-a,Widget A,10\n",
        idempotencyKey
      );
      expect(stage.status).toBe(200);
      await drainWorker(getWorkerTestSql(), owner.tenantId);
      return stage.body.data.batch.id as string;
    }

    test("a descriptor declaring NO sensitiveFields masks every value — omission must not reveal (Cacat 1)", async () => {
      const owner = await bootstrap();
      const batchId = await stageAndValidate(owner, "guard-key-1");

      // The pre-#820 default: no policy declared. This used to set
      // `canSeeRawValues = true` and return every staged value raw, with no
      // raw-value permission check performed at all.
      referenceDescriptor.sensitiveFields = undefined;

      // The tenant OWNER — the most privileged caller there is — still sees
      // nothing raw. No permission unmasks an undeclared policy.
      const preview = await invoke<{ data: { rows: any[] } }>(getPreview, {
        method: "GET",
        path: `/api/v1/data-exchange/imports/${batchId}/preview`,
        params: { id: batchId },
        headers: authHeaders(owner)
      });

      expect(preview.status).toBe(200);
      const row = preview.body.data.rows[0];
      expect(Object.keys(row.fields).length).toBeGreaterThan(0);
      for (const value of Object.values(row.fields)) {
        expect(value).toBe("[REDACTED]");
      }
      expect(row.naturalKey).toBe("[REDACTED]");
      // Non-content metadata still flows — the preview stays navigable.
      expect(row.proposedAction).toBe("create");
      expect(row.rowNumber).toBe(1);
    });

    test("the DESCRIPTOR's own rawValuePermission gates raw values — the broader data_exchange.preview_errors.read does not (Cacat 2)", async () => {
      const owner = await bootstrap();
      const batchId = await stageAndValidate(owner, "guard-key-2");

      // A descriptor declaring a NARROW permission of its own, exactly as
      // the contract has always promised it could.
      referenceDescriptor.sensitiveFields = {
        fieldNames: ["label", "code"],
        rawValuePermission: "identity_access.user_management.read",
        naturalKeyField: "code"
      };

      // A caller holding the BROAD, generic raw-value permission the route
      // used to hardcode — and nothing the descriptor actually asked for.
      // Pre-#820 this caller saw NIK/NPWP-equivalents in the clear.
      const broad = await bootstrapLimitedUser(owner, [
        { moduleKey: "data_exchange", activityCode: "imports", action: "read" },
        {
          moduleKey: "data_exchange",
          activityCode: "preview_errors",
          action: "read"
        }
      ]);

      const denied = await invoke<{ data: { rows: any[] } }>(getPreview, {
        method: "GET",
        path: `/api/v1/data-exchange/imports/${batchId}/preview`,
        params: { id: batchId },
        headers: authHeaders(broad)
      });

      expect(denied.status).toBe(200);
      const maskedRow = denied.body.data.rows[0];
      expect(maskedRow.fields.label).toBe("[REDACTED]");
      expect(maskedRow.fields.code).toBe("[REDACTED]");
      // Cacat 4: naturalKey IS the sensitive `code` here — masking `fields`
      // while echoing the same value back as `naturalKey` masks nothing.
      expect(maskedRow.naturalKey).toBe("[REDACTED]");
      // A field outside the policy is untouched (the adapter normalizes
      // `value` to a number, so this is the stored shape, unmasked).
      expect(maskedRow.fields.value).toBe(10);

      // The descriptor's OWN permission — and only it — reveals the values.
      const admin = getAdminSql();
      await admin`
        INSERT INTO awcms_mini_role_permissions (tenant_id, role_id, permission_id)
        SELECT ${owner.tenantId}, r.id, p.id
        FROM awcms_mini_roles r, awcms_mini_permissions p
        WHERE r.tenant_id = ${owner.tenantId} AND r.role_code = 'limited'
          AND p.module_key = 'identity_access' AND p.activity_code = 'user_management' AND p.action = 'read'
      `;

      const allowed = await invoke<{ data: { rows: any[] } }>(getPreview, {
        method: "GET",
        path: `/api/v1/data-exchange/imports/${batchId}/preview`,
        params: { id: batchId },
        headers: authHeaders(broad)
      });

      expect(allowed.status).toBe(200);
      expect(allowed.body.data.rows[0].fields.label).toBe("Widget A");
      expect(allowed.body.data.rows[0].naturalKey).toBe("widget-a");
    });

    test("naturalKey stays visible when it is NOT declared sensitive (masking is not blanket)", async () => {
      const owner = await bootstrap();
      const batchId = await stageAndValidate(owner, "guard-key-3");

      referenceDescriptor.sensitiveFields = {
        fieldNames: ["label"],
        rawValuePermission: "identity_access.user_management.read",
        naturalKeyField: "code"
      };

      const limited = await bootstrapLimitedUser(owner, [
        { moduleKey: "data_exchange", activityCode: "imports", action: "read" }
      ]);

      const preview = await invoke<{ data: { rows: any[] } }>(getPreview, {
        method: "GET",
        path: `/api/v1/data-exchange/imports/${batchId}/preview`,
        params: { id: batchId },
        headers: authHeaders(limited)
      });

      expect(preview.status).toBe(200);
      expect(preview.body.data.rows[0].fields.label).toBe("[REDACTED]");
      // `code` is the naturalKey but is not in `fieldNames` — it is the
      // row's identity in the preview list and stays readable.
      expect(preview.body.data.rows[0].naturalKey).toBe("widget-a");
    });

    test("a batch whose importKey is no longer registered is DENIED, not opened (Cacat 3)", async () => {
      const owner = await bootstrap();
      const batchId = await stageAndValidate(owner, "guard-key-4");

      // Simulates the owning module being disabled/removed via
      // `module_management` AFTER the batch was staged: the key stops
      // resolving. Pre-#820 this made the batch MORE readable than while
      // its module ran — the descriptor gate returned `allowed: true` for a
      // null descriptor AND the (now absent) sensitiveFields defaulted to
      // "nothing is sensitive", so every value came back raw.
      const admin = getAdminSql();
      await admin`
        UPDATE awcms_mini_data_exchange_import_batches
        SET import_key = 'data_exchange.retired_descriptor'
        WHERE tenant_id = ${owner.tenantId} AND id = ${batchId}
      `;

      const preview = await invoke<{ data?: { rows: any[] }; error?: any }>(
        getPreview,
        {
          method: "GET",
          path: `/api/v1/data-exchange/imports/${batchId}/preview`,
          params: { id: batchId },
          headers: authHeaders(owner)
        }
      );

      expect(preview.status).toBe(409);
      expect(preview.body.data).toBeUndefined();
    });

    test("a deep offset is clamped instead of reaching Postgres verbatim (Issue #831)", async () => {
      const owner = await bootstrap();
      const batchId = await stageAndValidate(owner, "guard-key-5");

      const preview = await invoke<{
        data: { rows: any[]; offset: number; limit: number };
      }>(getPreview, {
        method: "GET",
        path: `/api/v1/data-exchange/imports/${batchId}/preview?offset=5000000`,
        params: { id: batchId },
        headers: authHeaders(owner)
      });

      expect(preview.status).toBe(200);
      // The echoed offset proves the clamp happened BEFORE the query: an
      // unclamped 5_000_000 would have been sent to Postgres as an OFFSET
      // to walk and discard. The ceiling equals the registry's hard cap on
      // rows per batch, so it can never hide a reachable row.
      expect(preview.body.data.offset).toBe(PREVIEW_OFFSET_MAX);
      expect(preview.body.data.offset).toBeLessThan(5_000_000);
      expect(preview.body.data.rows).toEqual([]);

      // A legitimate in-range offset is untouched.
      const inRange = await invoke<{ data: { offset: number } }>(getPreview, {
        method: "GET",
        path: `/api/v1/data-exchange/imports/${batchId}/preview?offset=0`,
        params: { id: batchId },
        headers: authHeaders(owner)
      });
      expect(inRange.body.data.offset).toBe(0);
    });
  });
});
