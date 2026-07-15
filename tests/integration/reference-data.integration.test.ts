/**
 * Integration tests for `reference_data` (Issue #750, epic #738
 * platform-evolution Wave 3, ADR-0021) against real PostgreSQL, through
 * the REAL Astro route handlers: value-set/code CRUD + deprecate/restore,
 * tenant override/extension creation (policy-gated) and resolved merge
 * precedence, cross-tenant isolation (RLS), the validated import pipeline
 * (dry-run -> commit, ADVERSARIAL destructive-replace rejection of a
 * referenced code, rollback), and Idempotency-Key replay/conflict.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  createCookieJar,
  getAdminSql,
  getTestSql,
  integrationEnabled,
  invoke,
  provisionAppRole,
  resetDatabase
} from "./harness";
import { withTenant } from "../../src/lib/database/tenant-context";

import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import {
  GET as listValueSets,
  POST as createValueSet
} from "../../src/pages/api/v1/reference-data/value-sets/index";
import {
  DELETE as deprecateValueSet,
  GET as getValueSet,
  PATCH as updateValueSet
} from "../../src/pages/api/v1/reference-data/value-sets/[key]";
import {
  GET as listCodes,
  POST as createCode
} from "../../src/pages/api/v1/reference-data/value-sets/[key]/codes/index";
import {
  GET as listImports,
  POST as dryRunImport
} from "../../src/pages/api/v1/reference-data/value-sets/[key]/imports/index";
import { POST as commitImport } from "../../src/pages/api/v1/reference-data/value-sets/[key]/imports/[importId]/commit";
import { POST as rollbackImport } from "../../src/pages/api/v1/reference-data/value-sets/[key]/imports/[importId]/rollback";
import {
  GET as listTenantCodes,
  POST as createTenantCode
} from "../../src/pages/api/v1/reference-data/tenant-codes/index";

import { hashPassword } from "../../src/lib/auth/password";

const OWNER_LOGIN = "owner@example.com";
const OWNER_PASSWORD = "integration-test-reference-data-owner-password";

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

/** Second tenant seeded directly via the privileged admin client — same convention `organization-structure.integration.test.ts`'s `bootstrapSecondTenant` documents (setup wizard is a global one-time singleton). */
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

let keyCounter = 0;
function idKey(): string {
  keyCounter += 1;
  return `test-idem-key-${keyCounter}-${Math.random().toString(36).slice(2)}`;
}

async function createValueSetFixture(
  owner: Bootstrap,
  key: string,
  overridePolicy: string = "tenant_extend_and_override"
): Promise<void> {
  const result = await invoke(createValueSet, {
    method: "POST",
    path: "/api/v1/reference-data/value-sets",
    headers: authHeaders(owner, idKey()),
    body: { key, name: key, overridePolicy }
  });
  expect(result.status).toBe(200);
}

async function createCodeFixture(
  owner: Bootstrap,
  valueSetKey: string,
  code: string
): Promise<void> {
  const result = await invoke(createCode, {
    method: "POST",
    path: `/api/v1/reference-data/value-sets/${valueSetKey}/codes`,
    params: { key: valueSetKey },
    headers: authHeaders(owner, idKey()),
    body: { code, labels: [{ locale: "en", label: code }] }
  });
  expect(result.status).toBe(200);
}

const suite = integrationEnabled ? describe : describe.skip;

suite("reference_data integration", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  test("value set + code: create, list, deprecate (idempotent), never a hard delete", async () => {
    const owner = await bootstrap();
    await createValueSetFixture(owner, "currency");
    await createCodeFixture(owner, "currency", "IDR");

    const list = await invoke<{ data: { codes: { code: string }[] } }>(
      listCodes,
      {
        method: "GET",
        path: "/api/v1/reference-data/value-sets/currency/codes",
        params: { key: "currency" },
        headers: authHeaders(owner)
      }
    );
    expect(list.status).toBe(200);
    expect(list.body.data.codes.map((c) => c.code)).toEqual(["IDR"]);

    const key = idKey();
    const deprecate1 = await invoke(deprecateValueSet, {
      method: "DELETE",
      path: "/api/v1/reference-data/value-sets/currency",
      params: { key: "currency" },
      headers: authHeaders(owner, key),
      body: { reason: "test deprecation" }
    });
    expect(deprecate1.status).toBe(200);

    // Same Idempotency-Key + same payload -> replay, not a 409/error.
    const deprecate2 = await invoke(deprecateValueSet, {
      method: "DELETE",
      path: "/api/v1/reference-data/value-sets/currency",
      params: { key: "currency" },
      headers: authHeaders(owner, key),
      body: { reason: "test deprecation" }
    });
    expect(deprecate2.status).toBe(200);

    // Same Idempotency-Key + DIFFERENT payload -> clean 409, not a raw error
    // (exercised on a fresh value set so the first call succeeds cleanly
    // rather than hitting "already deprecated" from the block above).
    await createValueSetFixture(owner, "unit_of_measure");
    const conflictKey2 = idKey();
    const attemptA = await invoke(deprecateValueSet, {
      method: "DELETE",
      path: "/api/v1/reference-data/value-sets/unit_of_measure",
      params: { key: "unit_of_measure" },
      headers: authHeaders(owner, conflictKey2),
      body: { reason: "reason A" }
    });
    expect(attemptA.status).toBe(200);
    const attemptB = await invoke(deprecateValueSet, {
      method: "DELETE",
      path: "/api/v1/reference-data/value-sets/unit_of_measure",
      params: { key: "unit_of_measure" },
      headers: authHeaders(owner, conflictKey2),
      body: { reason: "reason B (different)" }
    });
    expect(attemptB.status).toBe(409);

    // The value set row still physically exists (deprecated, not deleted).
    const admin = getAdminSql();
    const rows = (await admin`
      SELECT deprecated_at FROM awcms_mini_reference_value_sets WHERE key = 'currency'
    `) as { deprecated_at: Date | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deprecated_at).not.toBeNull();
  });

  test("tenant override policy gate: 'none' forbids both override and extension via the real endpoint", async () => {
    const owner = await bootstrap();
    await createValueSetFixture(owner, "fiscal_calendar", "none");
    await createCodeFixture(owner, "fiscal_calendar", "calendar_year");

    const codesList = await invoke<{
      data: { codes: { id: string; code: string }[] };
    }>(listCodes, {
      method: "GET",
      path: "/api/v1/reference-data/value-sets/fiscal_calendar/codes",
      params: { key: "fiscal_calendar" },
      headers: authHeaders(owner)
    });
    const baseCodeId = codesList.body.data.codes[0]!.id;

    const overrideAttempt = await invoke(createTenantCode, {
      method: "POST",
      path: "/api/v1/reference-data/tenant-codes",
      headers: authHeaders(owner, idKey()),
      body: {
        valueSet: "fiscal_calendar",
        baseCodeId,
        code: "calendar_year",
        labels: [{ locale: "en", label: "Override attempt" }]
      }
    });
    expect(overrideAttempt.status).toBe(403);

    const extensionAttempt = await invoke(createTenantCode, {
      method: "POST",
      path: "/api/v1/reference-data/tenant-codes",
      headers: authHeaders(owner, idKey()),
      body: {
        valueSet: "fiscal_calendar",
        baseCodeId: null,
        code: "custom_fy",
        labels: [{ locale: "en", label: "Custom FY" }]
      }
    });
    expect(extensionAttempt.status).toBe(403);
  });

  test("ADVERSARIAL (security-review Critical, direction 1): an 'override' whose submitted code does NOT match its baseCodeId's real code is rejected, even though the override policy itself allows override", async () => {
    const owner = await bootstrap();
    await createValueSetFixture(owner, "currency", "tenant_override");
    await createCodeFixture(owner, "currency", "IDR");
    await createCodeFixture(owner, "currency", "USD");

    const codesList = await invoke<{
      data: { codes: { id: string; code: string }[] };
    }>(listCodes, {
      method: "GET",
      path: "/api/v1/reference-data/value-sets/currency/codes",
      params: { key: "currency" },
      headers: authHeaders(owner)
    });
    const idrCodeId = codesList.body.data.codes.find(
      (c) => c.code === "IDR"
    )!.id;

    // Attempt: baseCodeId points at IDR, but the submitted code is "USD" --
    // a policy-bypass attempt to sneak in a differently-named code
    // disguised as an "override" under a policy that forbids extension.
    const mismatchAttempt = await invoke(createTenantCode, {
      method: "POST",
      path: "/api/v1/reference-data/tenant-codes",
      headers: authHeaders(owner, idKey()),
      body: {
        valueSet: "currency",
        baseCodeId: idrCodeId,
        code: "USD",
        labels: [{ locale: "en", label: "Sneaky mismatched override" }]
      }
    });
    expect(mismatchAttempt.status).toBe(409);
    expect(
      (mismatchAttempt.body as { error: { code: string } }).error.code
    ).toBe("CODE_MISMATCH_WITH_BASE_CODE");

    // No tenant row was created at all -- verify via the raw list (RLS
    // scoped to this tenant already via the API layer).
    const afterAttempt = await invoke<{ data: { tenantCodes: unknown[] } }>(
      listTenantCodes,
      {
        method: "GET",
        path: "/api/v1/reference-data/tenant-codes?valueSet=currency&mode=raw",
        headers: authHeaders(owner)
      }
    );
    expect(afterAttempt.body.data.tenantCodes).toHaveLength(0);
  });

  test("ADVERSARIAL (security-review Critical, direction 2): an 'extension' whose code already exists in the GLOBAL baseline is rejected, even though the override policy itself allows extension", async () => {
    const owner = await bootstrap();
    await createValueSetFixture(owner, "currency", "tenant_extend");
    await createCodeFixture(owner, "currency", "IDR");

    // Attempt: baseCodeId null (claims "extension"), but code "IDR"
    // already exists in the baseline -- if accepted, this would silently
    // shadow the baseline in the resolved view (domain/resolution.ts
    // always lets a same-code tenant row win), exactly what
    // "tenant_extend" (never override an existing code) forbids.
    const collisionAttempt = await invoke(createTenantCode, {
      method: "POST",
      path: "/api/v1/reference-data/tenant-codes",
      headers: authHeaders(owner, idKey()),
      body: {
        valueSet: "currency",
        baseCodeId: null,
        code: "IDR",
        labels: [{ locale: "en", label: "Disguised shadow override" }]
      }
    });
    expect(collisionAttempt.status).toBe(409);
    expect(
      (collisionAttempt.body as { error: { code: string } }).error.code
    ).toBe("CODE_COLLIDES_WITH_BASELINE");

    // The baseline resolved view must still show the REAL baseline label,
    // never a shadowed one.
    const resolved = await invoke<{
      data: { codes: { code: string; isTenantOverride: boolean }[] };
    }>(listTenantCodes, {
      method: "GET",
      path: "/api/v1/reference-data/tenant-codes?valueSet=currency&mode=resolved",
      headers: authHeaders(owner)
    });
    expect(resolved.body.data.codes).toHaveLength(1);
    expect(resolved.body.data.codes[0]!.isTenantOverride).toBe(false);
  });

  test("tenant override wins over baseline in the resolved merged view", async () => {
    const owner = await bootstrap();
    await createValueSetFixture(
      owner,
      "currency",
      "tenant_extend_and_override"
    );
    await createCodeFixture(owner, "currency", "IDR");

    const codesList = await invoke<{
      data: { codes: { id: string; code: string }[] };
    }>(listCodes, {
      method: "GET",
      path: "/api/v1/reference-data/value-sets/currency/codes",
      params: { key: "currency" },
      headers: authHeaders(owner)
    });
    const baseCodeId = codesList.body.data.codes[0]!.id;

    const override = await invoke(createTenantCode, {
      method: "POST",
      path: "/api/v1/reference-data/tenant-codes",
      headers: authHeaders(owner, idKey()),
      body: {
        valueSet: "currency",
        baseCodeId,
        code: "IDR",
        labels: [{ locale: "en", label: "Tenant IDR Override" }]
      }
    });
    expect(override.status).toBe(200);

    const resolved = await invoke<{
      data: {
        codes: { code: string; isTenantOverride: boolean; label: string }[];
      };
    }>(listTenantCodes, {
      method: "GET",
      path: "/api/v1/reference-data/tenant-codes?valueSet=currency&mode=resolved",
      headers: authHeaders(owner)
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body.data.codes).toHaveLength(1);
    expect(resolved.body.data.codes[0]!.isTenantOverride).toBe(true);
    expect(resolved.body.data.codes[0]!.label).toBe("Tenant IDR Override");
  });

  test("cross-tenant isolation: tenant B never sees tenant A's tenant-scoped override rows", async () => {
    const tenantA = await bootstrap("tenant-a", "Tenant A");
    const tenantB = await bootstrapSecondTenant("tenant-b", "Tenant B");

    await createValueSetFixture(tenantA, "currency", "tenant_extend");

    const createExtension = await invoke(createTenantCode, {
      method: "POST",
      path: "/api/v1/reference-data/tenant-codes",
      headers: authHeaders(tenantA, idKey()),
      body: {
        valueSet: "currency",
        baseCodeId: null,
        code: "TENANT_A_ONLY",
        labels: [{ locale: "en", label: "Tenant A only" }]
      }
    });
    expect(createExtension.status).toBe(200);

    // Tenant B queries the SAME value set -- must see ZERO tenant-scoped rows.
    const tenantBView = await invoke<{ data: { tenantCodes: unknown[] } }>(
      listTenantCodes,
      {
        method: "GET",
        path: "/api/v1/reference-data/tenant-codes?valueSet=currency&mode=raw",
        headers: authHeaders(tenantB)
      }
    );
    expect(tenantBView.status).toBe(200);
    expect(tenantBView.body.data.tenantCodes).toHaveLength(0);

    // Defense-in-depth: verify at the RAW SQL/RLS layer too, not just through
    // the API -- via the least-privilege `awcms_mini_app` role (`getTestSql()`
    // + `withTenant`), never the admin/superuser connection (a Postgres
    // superuser always bypasses RLS regardless of FORCE ROW LEVEL SECURITY,
    // so asserting via `getAdminSql()` here would prove nothing).
    const testSql = getTestSql();
    await withTenant(testSql, tenantB.tenantId, async (tx) => {
      const rlsScopedRows = (await tx`
        SELECT id FROM awcms_mini_reference_tenant_codes
      `) as { id: string }[];
      expect(rlsScopedRows).toHaveLength(0);
    });
  });

  test("validated import: dry-run is non-mutating, commit applies it, ADVERSARIAL destructive replace of a referenced code is rejected at commit, rollback reverts an unreferenced fresh commit", async () => {
    const owner = await bootstrap();
    await createValueSetFixture(
      owner,
      "unit_of_measure",
      "tenant_extend_and_override"
    );

    const dryRun = await invoke<{
      data: {
        import: { id: string; checksum: string; status: string };
        diff: { toCreate: string[] };
      };
    }>(dryRunImport, {
      method: "POST",
      path: "/api/v1/reference-data/value-sets/unit_of_measure/imports",
      params: { key: "unit_of_measure" },
      headers: authHeaders(owner, idKey()),
      body: {
        codes: [
          { code: "pcs", labels: [{ locale: "en", label: "Piece" }] },
          { code: "kg", labels: [{ locale: "en", label: "Kilogram" }] }
        ]
      }
    });
    expect(dryRun.status).toBe(200);
    expect(dryRun.body.data.import.status).toBe("validated");
    expect(dryRun.body.data.diff.toCreate.sort()).toEqual(["kg", "pcs"]);

    // Dry-run must NOT have written any codes yet.
    const preCommitCodes = await invoke<{ data: { codes: unknown[] } }>(
      listCodes,
      {
        method: "GET",
        path: "/api/v1/reference-data/value-sets/unit_of_measure/codes",
        params: { key: "unit_of_measure" },
        headers: authHeaders(owner)
      }
    );
    expect(preCommitCodes.body.data.codes).toHaveLength(0);

    const importId = dryRun.body.data.import.id;
    const checksum = dryRun.body.data.import.checksum;

    const commit = await invoke(commitImport, {
      method: "POST",
      path: `/api/v1/reference-data/value-sets/unit_of_measure/imports/${importId}/commit`,
      params: { key: "unit_of_measure", importId },
      headers: authHeaders(owner, idKey()),
      body: { checksum }
    });
    expect(commit.status).toBe(200);

    const postCommitCodes = await invoke<{
      data: { codes: { id: string; code: string }[] };
    }>(listCodes, {
      method: "GET",
      path: "/api/v1/reference-data/value-sets/unit_of_measure/codes",
      params: { key: "unit_of_measure" },
      headers: authHeaders(owner)
    });
    expect(postCommitCodes.body.data.codes.map((c) => c.code).sort()).toEqual([
      "kg",
      "pcs"
    ]);

    const kgCode = postCommitCodes.body.data.codes.find(
      (c) => c.code === "kg"
    )!;

    // A tenant now references "kg" via an override.
    const override = await invoke(createTenantCode, {
      method: "POST",
      path: "/api/v1/reference-data/tenant-codes",
      headers: authHeaders(owner, idKey()),
      body: {
        valueSet: "unit_of_measure",
        baseCodeId: kgCode.id,
        code: "kg",
        labels: [{ locale: "en", label: "Kilogram (tenant override)" }]
      }
    });
    expect(override.status).toBe(200);

    // ADVERSARIAL: a second import tries to destructively REPLACE "kg" (now referenced).
    const adversarialDryRun = await invoke<{
      data: { import: { id: string; checksum: string; status: string } };
    }>(dryRunImport, {
      method: "POST",
      path: "/api/v1/reference-data/value-sets/unit_of_measure/imports",
      params: { key: "unit_of_measure" },
      headers: authHeaders(owner, idKey()),
      body: {
        codes: [
          { code: "pcs", labels: [{ locale: "en", label: "Piece" }] },
          {
            code: "kg",
            labels: [{ locale: "en", label: "Kilogram REPURPOSED" }],
            replace: true
          }
        ]
      }
    });
    expect(adversarialDryRun.status).toBe(200);
    expect(adversarialDryRun.body.data.import.status).toBe("rejected");

    const adversarialCommit = await invoke(commitImport, {
      method: "POST",
      path: `/api/v1/reference-data/value-sets/unit_of_measure/imports/${adversarialDryRun.body.data.import.id}/commit`,
      params: {
        key: "unit_of_measure",
        importId: adversarialDryRun.body.data.import.id
      },
      headers: authHeaders(owner, idKey()),
      body: { checksum: adversarialDryRun.body.data.import.checksum }
    });
    // Rejected at the dry-run/re-validation layer -- the import batch's
    // OWN status is already "rejected", so commit refuses to proceed
    // (INVALID_STATUS), not a silent success.
    expect(adversarialCommit.status).toBe(409);

    // "kg" must be COMPLETELY UNCHANGED -- never silently deleted or repurposed.
    const admin = getAdminSql();
    const kgRow = (await admin`
      SELECT id FROM awcms_mini_reference_codes
      WHERE value_set_id = (SELECT id FROM awcms_mini_reference_value_sets WHERE key = 'unit_of_measure')
        AND code = 'kg'
    `) as { id: string }[];
    expect(kgRow).toHaveLength(1);
    expect(kgRow[0]!.id).toBe(kgCode.id);

    // Rollback the ORIGINAL (unreferenced-except-for-kg... wait kg IS now
    // referenced) commit is expected to be blocked for "kg" specifically --
    // exercise rollback on a SEPARATE, wholly-unreferenced import instead.
    await createValueSetFixture(owner, "fiscal_calendar", "none");
    const freshDryRun = await invoke<{
      data: { import: { id: string; checksum: string } };
    }>(dryRunImport, {
      method: "POST",
      path: "/api/v1/reference-data/value-sets/fiscal_calendar/imports",
      params: { key: "fiscal_calendar" },
      headers: authHeaders(owner, idKey()),
      body: {
        codes: [
          {
            code: "calendar_year",
            labels: [{ locale: "en", label: "Calendar Year" }]
          }
        ]
      }
    });
    const freshCommit = await invoke(commitImport, {
      method: "POST",
      path: `/api/v1/reference-data/value-sets/fiscal_calendar/imports/${freshDryRun.body.data.import.id}/commit`,
      params: {
        key: "fiscal_calendar",
        importId: freshDryRun.body.data.import.id
      },
      headers: authHeaders(owner, idKey()),
      body: { checksum: freshDryRun.body.data.import.checksum }
    });
    expect(freshCommit.status).toBe(200);

    const rollback = await invoke(rollbackImport, {
      method: "POST",
      path: `/api/v1/reference-data/value-sets/fiscal_calendar/imports/${freshDryRun.body.data.import.id}/rollback`,
      params: {
        key: "fiscal_calendar",
        importId: freshDryRun.body.data.import.id
      },
      headers: authHeaders(owner, idKey())
    });
    expect(rollback.status).toBe(200);

    const afterRollbackCodes = await invoke<{ data: { codes: unknown[] } }>(
      listCodes,
      {
        method: "GET",
        path: "/api/v1/reference-data/value-sets/fiscal_calendar/codes",
        params: { key: "fiscal_calendar" },
        headers: authHeaders(owner)
      }
    );
    expect(afterRollbackCodes.body.data.codes).toHaveLength(0);

    const importHistory = await invoke<{
      data: { imports: { status: string }[] };
    }>(listImports, {
      method: "GET",
      path: "/api/v1/reference-data/value-sets/fiscal_calendar/imports",
      params: { key: "fiscal_calendar" },
      headers: authHeaders(owner)
    });
    expect(
      importHistory.body.data.imports.some((i) => i.status === "rolled_back")
    ).toBe(true);
  });

  test("ADVERSARIAL (security-review High): reusing the same Idempotency-Key across ROLLBACK of two DIFFERENT import batches must NOT replay the first batch's cached response for the second -- the mismatched hash must yield 409 CONFLICT, and the second batch must still actually execute once given its OWN key", async () => {
    const owner = await bootstrap();
    await createValueSetFixture(owner, "unit_of_measure", "none");
    await createValueSetFixture(owner, "fiscal_calendar", "none");

    // Import batch A (unit_of_measure), committed.
    const dryRunA = await invoke<{
      data: { import: { id: string; checksum: string } };
    }>(dryRunImport, {
      method: "POST",
      path: "/api/v1/reference-data/value-sets/unit_of_measure/imports",
      params: { key: "unit_of_measure" },
      headers: authHeaders(owner, idKey()),
      body: {
        codes: [{ code: "pcs", labels: [{ locale: "en", label: "Piece" }] }]
      }
    });
    expect(dryRunA.status).toBe(200);
    const importA = dryRunA.body.data.import.id;
    const commitA = await invoke(commitImport, {
      method: "POST",
      path: `/api/v1/reference-data/value-sets/unit_of_measure/imports/${importA}/commit`,
      params: { key: "unit_of_measure", importId: importA },
      headers: authHeaders(owner, idKey()),
      body: { checksum: dryRunA.body.data.import.checksum }
    });
    expect(commitA.status).toBe(200);

    // Import batch B (fiscal_calendar), committed -- a DIFFERENT resource of
    // the SAME type (a reference-import batch), so it shares the same
    // request_scope ("reference_data_import_rollback") and tenant_id with A.
    const dryRunB = await invoke<{
      data: { import: { id: string; checksum: string } };
    }>(dryRunImport, {
      method: "POST",
      path: "/api/v1/reference-data/value-sets/fiscal_calendar/imports",
      params: { key: "fiscal_calendar" },
      headers: authHeaders(owner, idKey()),
      body: {
        codes: [
          {
            code: "calendar_year",
            labels: [{ locale: "en", label: "Calendar Year" }]
          }
        ]
      }
    });
    expect(dryRunB.status).toBe(200);
    const importB = dryRunB.body.data.import.id;
    const commitB = await invoke(commitImport, {
      method: "POST",
      path: `/api/v1/reference-data/value-sets/fiscal_calendar/imports/${importB}/commit`,
      params: { key: "fiscal_calendar", importId: importB },
      headers: authHeaders(owner, idKey()),
      body: { checksum: dryRunB.body.data.import.checksum }
    });
    expect(commitB.status).toBe(200);

    const reusedKey = idKey();

    // Roll back A with the reused key -- succeeds normally.
    const rollbackA = await invoke<{ data: { import: { id: string } } }>(
      rollbackImport,
      {
        method: "POST",
        path: `/api/v1/reference-data/value-sets/unit_of_measure/imports/${importA}/rollback`,
        params: { key: "unit_of_measure", importId: importA },
        headers: authHeaders(owner, reusedKey)
      }
    );
    expect(rollbackA.status).toBe(200);
    expect(rollbackA.body.data.import.id).toBe(importA);

    // Attempt to roll back B with the SAME key. Pre-fix, `computeRequestHash({})`
    // was identical for both requests, so this would silently REPLAY A's
    // cached response (200, describing A's import) without ever touching B --
    // B would appear "rolled back" to the caller while its codes stayed live.
    // Post-fix, the hash folds in `importId`, so the mismatch must be
    // detected and rejected as a conflict, never a false replay.
    const rollbackBReusedKey = await invoke(rollbackImport, {
      method: "POST",
      path: `/api/v1/reference-data/value-sets/fiscal_calendar/imports/${importB}/rollback`,
      params: { key: "fiscal_calendar", importId: importB },
      headers: authHeaders(owner, reusedKey)
    });
    expect(rollbackBReusedKey.status).toBe(409);
    expect(
      (rollbackBReusedKey.body as { error: { code: string } }).error.code
    ).toBe("IDEMPOTENCY_CONFLICT");

    // B must still be untouched -- NOT falsely reported as rolled back.
    const stillLiveCodes = await invoke<{ data: { codes: unknown[] } }>(
      listCodes,
      {
        method: "GET",
        path: "/api/v1/reference-data/value-sets/fiscal_calendar/codes",
        params: { key: "fiscal_calendar" },
        headers: authHeaders(owner)
      }
    );
    expect(stillLiveCodes.body.data.codes).toHaveLength(1);

    // With its OWN distinct key, B's rollback genuinely executes.
    const rollbackBOwnKey = await invoke<{ data: { import: { id: string } } }>(
      rollbackImport,
      {
        method: "POST",
        path: `/api/v1/reference-data/value-sets/fiscal_calendar/imports/${importB}/rollback`,
        params: { key: "fiscal_calendar", importId: importB },
        headers: authHeaders(owner, idKey())
      }
    );
    expect(rollbackBOwnKey.status).toBe(200);
    expect(rollbackBOwnKey.body.data.import.id).toBe(importB);

    const afterRollbackCodes = await invoke<{ data: { codes: unknown[] } }>(
      listCodes,
      {
        method: "GET",
        path: "/api/v1/reference-data/value-sets/fiscal_calendar/codes",
        params: { key: "fiscal_calendar" },
        headers: authHeaders(owner)
      }
    );
    expect(afterRollbackCodes.body.data.codes).toHaveLength(0);
  });

  test("ADVERSARIAL (security-review High): reusing the same Idempotency-Key across COMMIT of two DIFFERENT import batches must NOT replay the first batch's cached response for the second -- the mismatched hash must yield 409 CONFLICT, and the second batch must still actually commit once given its OWN key", async () => {
    const owner = await bootstrap();
    await createValueSetFixture(owner, "unit_of_measure", "none");
    await createValueSetFixture(owner, "fiscal_calendar", "none");

    const dryRunA = await invoke<{
      data: { import: { id: string; checksum: string } };
    }>(dryRunImport, {
      method: "POST",
      path: "/api/v1/reference-data/value-sets/unit_of_measure/imports",
      params: { key: "unit_of_measure" },
      headers: authHeaders(owner, idKey()),
      body: {
        codes: [{ code: "pcs", labels: [{ locale: "en", label: "Piece" }] }]
      }
    });
    expect(dryRunA.status).toBe(200);
    const importA = dryRunA.body.data.import.id;

    const dryRunB = await invoke<{
      data: { import: { id: string; checksum: string } };
    }>(dryRunImport, {
      method: "POST",
      path: "/api/v1/reference-data/value-sets/fiscal_calendar/imports",
      params: { key: "fiscal_calendar" },
      headers: authHeaders(owner, idKey()),
      body: {
        codes: [
          {
            code: "calendar_year",
            labels: [{ locale: "en", label: "Calendar Year" }]
          }
        ]
      }
    });
    expect(dryRunB.status).toBe(200);
    const importB = dryRunB.body.data.import.id;

    const reusedKey = idKey();

    const commitA = await invoke<{ data: { import: { id: string } } }>(
      commitImport,
      {
        method: "POST",
        path: `/api/v1/reference-data/value-sets/unit_of_measure/imports/${importA}/commit`,
        params: { key: "unit_of_measure", importId: importA },
        headers: authHeaders(owner, reusedKey),
        body: { checksum: dryRunA.body.data.import.checksum }
      }
    );
    expect(commitA.status).toBe(200);
    expect(commitA.body.data.import.id).toBe(importA);

    // Same key, different import batch B, and (deliberately) B's OWN correct
    // checksum in the body -- pre-fix, commit only hashed `{ checksum }`, so
    // two distinct import batches whose payload happens to diff-hash
    // identically (or even just by accident of the store key colliding on
    // idempotency_key alone before this fix folded in importId) could
    // collide. Confirm the mismatch is now caught as a conflict, not a
    // silent replay of A's response for B.
    const commitBReusedKey = await invoke(commitImport, {
      method: "POST",
      path: `/api/v1/reference-data/value-sets/fiscal_calendar/imports/${importB}/commit`,
      params: { key: "fiscal_calendar", importId: importB },
      headers: authHeaders(owner, reusedKey),
      body: { checksum: dryRunB.body.data.import.checksum }
    });
    expect(commitBReusedKey.status).toBe(409);
    expect(
      (commitBReusedKey.body as { error: { code: string } }).error.code
    ).toBe("IDEMPOTENCY_CONFLICT");

    // B must still be untouched -- still "validated", never committed.
    const historyAfterConflict = await invoke<{
      data: { imports: { id: string; status: string }[] };
    }>(listImports, {
      method: "GET",
      path: "/api/v1/reference-data/value-sets/fiscal_calendar/imports",
      params: { key: "fiscal_calendar" },
      headers: authHeaders(owner)
    });
    expect(
      historyAfterConflict.body.data.imports.find((i) => i.id === importB)!
        .status
    ).toBe("validated");

    // With its OWN distinct key, B's commit genuinely executes.
    const commitBOwnKey = await invoke<{ data: { import: { id: string } } }>(
      commitImport,
      {
        method: "POST",
        path: `/api/v1/reference-data/value-sets/fiscal_calendar/imports/${importB}/commit`,
        params: { key: "fiscal_calendar", importId: importB },
        headers: authHeaders(owner, idKey()),
        body: { checksum: dryRunB.body.data.import.checksum }
      }
    );
    expect(commitBOwnKey.status).toBe(200);
    expect(commitBOwnKey.body.data.import.id).toBe(importB);

    const codesAfterCommit = await invoke<{
      data: { codes: { code: string }[] };
    }>(listCodes, {
      method: "GET",
      path: "/api/v1/reference-data/value-sets/fiscal_calendar/codes",
      params: { key: "fiscal_calendar" },
      headers: authHeaders(owner)
    });
    expect(codesAfterCommit.body.data.codes.map((c) => c.code)).toEqual([
      "calendar_year"
    ]);
  });

  test("ADVERSARIAL (security-review High, ownership check): an importId that does NOT belong to the value set named by {key} in the URL is rejected 404, for both commit and rollback", async () => {
    const owner = await bootstrap();
    await createValueSetFixture(owner, "unit_of_measure", "none");
    await createValueSetFixture(owner, "fiscal_calendar", "none");

    // A validated (not yet committed) import that genuinely belongs to
    // unit_of_measure.
    const dryRun = await invoke<{
      data: { import: { id: string; checksum: string } };
    }>(dryRunImport, {
      method: "POST",
      path: "/api/v1/reference-data/value-sets/unit_of_measure/imports",
      params: { key: "unit_of_measure" },
      headers: authHeaders(owner, idKey()),
      body: {
        codes: [{ code: "pcs", labels: [{ locale: "en", label: "Piece" }] }]
      }
    });
    expect(dryRun.status).toBe(200);
    const importId = dryRun.body.data.import.id;
    const checksum = dryRun.body.data.import.checksum;

    // Attempt to commit it via the WRONG value set's URL ({key} =
    // fiscal_calendar, but importId belongs to unit_of_measure).
    const commitWrongKey = await invoke(commitImport, {
      method: "POST",
      path: `/api/v1/reference-data/value-sets/fiscal_calendar/imports/${importId}/commit`,
      params: { key: "fiscal_calendar", importId },
      headers: authHeaders(owner, idKey()),
      body: { checksum }
    });
    expect(commitWrongKey.status).toBe(404);
    expect(
      (commitWrongKey.body as { error: { code: string } }).error.code
    ).toBe("NOT_FOUND");

    // Commit for real via the CORRECT key so there's a committed batch to
    // attempt a mismatched rollback against.
    const commitCorrectKey = await invoke<{ data: { import: { id: string } } }>(
      commitImport,
      {
        method: "POST",
        path: `/api/v1/reference-data/value-sets/unit_of_measure/imports/${importId}/commit`,
        params: { key: "unit_of_measure", importId },
        headers: authHeaders(owner, idKey()),
        body: { checksum }
      }
    );
    expect(commitCorrectKey.status).toBe(200);

    // Attempt to roll it back via the WRONG value set's URL.
    const rollbackWrongKey = await invoke(rollbackImport, {
      method: "POST",
      path: `/api/v1/reference-data/value-sets/fiscal_calendar/imports/${importId}/rollback`,
      params: { key: "fiscal_calendar", importId },
      headers: authHeaders(owner, idKey())
    });
    expect(rollbackWrongKey.status).toBe(404);
    expect(
      (rollbackWrongKey.body as { error: { code: string } }).error.code
    ).toBe("NOT_FOUND");

    // The import batch is untouched -- still committed, never rolled back
    // by the mismatched-key attempt.
    const historyAfterMismatch = await invoke<{
      data: { imports: { id: string; status: string }[] };
    }>(listImports, {
      method: "GET",
      path: "/api/v1/reference-data/value-sets/unit_of_measure/imports",
      params: { key: "unit_of_measure" },
      headers: authHeaders(owner)
    });
    expect(
      historyAfterMismatch.body.data.imports.find((i) => i.id === importId)!
        .status
    ).toBe("committed");

    // Rolling back via the CORRECT key succeeds.
    const rollbackCorrectKey = await invoke<{
      data: { import: { id: string } };
    }>(rollbackImport, {
      method: "POST",
      path: `/api/v1/reference-data/value-sets/unit_of_measure/imports/${importId}/rollback`,
      params: { key: "unit_of_measure", importId },
      headers: authHeaders(owner, idKey())
    });
    expect(rollbackCorrectKey.status).toBe(200);
  });

  test("ADVERSARIAL (security-review High, round 2): reusing the same Idempotency-Key across PATCH update of two DIFFERENT value sets with an identical-shaped body must NOT replay the first's cached response for the second -- the mismatched hash must yield 409 CONFLICT, and the second value set's own update must still actually apply once given its OWN key", async () => {
    const owner = await bootstrap();
    await createValueSetFixture(owner, "unit_of_measure", "none");
    await createValueSetFixture(owner, "fiscal_calendar", "none");

    const reusedKey = idKey();
    const sharedBody = { name: "Renamed", description: "Shared description" };

    // Update A (unit_of_measure) with the reused key -- succeeds normally.
    const updateA = await invoke<{ data: { valueSet: { key: string } } }>(
      updateValueSet,
      {
        method: "PATCH",
        path: "/api/v1/reference-data/value-sets/unit_of_measure",
        params: { key: "unit_of_measure" },
        headers: authHeaders(owner, reusedKey),
        body: sharedBody
      }
    );
    expect(updateA.status).toBe(200);
    expect(updateA.body.data.valueSet.key).toBe("unit_of_measure");

    // Attempt to update B (fiscal_calendar) with the SAME key and an
    // IDENTICALLY-shaped body. Pre-fix, `computeRequestHash(body)` never
    // included `key`, so this would silently REPLAY A's cached response
    // (200, describing A) without ever touching B -- B would appear
    // "renamed" to the caller while its name/description stayed untouched.
    // Post-fix, the hash folds in `key`, so the mismatch must be detected
    // and rejected as a conflict, never a false replay.
    const updateBReusedKey = await invoke(updateValueSet, {
      method: "PATCH",
      path: "/api/v1/reference-data/value-sets/fiscal_calendar",
      params: { key: "fiscal_calendar" },
      headers: authHeaders(owner, reusedKey),
      body: sharedBody
    });
    expect(updateBReusedKey.status).toBe(409);
    expect(
      (updateBReusedKey.body as { error: { code: string } }).error.code
    ).toBe("IDEMPOTENCY_CONFLICT");

    // B must still be untouched -- NOT falsely reported as renamed.
    const bUnchanged = await invoke<{
      data: { valueSet: { name: string; description: string | null } };
    }>(getValueSet, {
      method: "GET",
      path: "/api/v1/reference-data/value-sets/fiscal_calendar",
      params: { key: "fiscal_calendar" },
      headers: authHeaders(owner)
    });
    expect(bUnchanged.body.data.valueSet.name).toBe("fiscal_calendar");
    expect(bUnchanged.body.data.valueSet.description).not.toBe(
      "Shared description"
    );

    // With its OWN distinct key, B's update genuinely applies.
    const updateBOwnKey = await invoke<{
      data: { valueSet: { name: string; description: string | null } };
    }>(updateValueSet, {
      method: "PATCH",
      path: "/api/v1/reference-data/value-sets/fiscal_calendar",
      params: { key: "fiscal_calendar" },
      headers: authHeaders(owner, idKey()),
      body: sharedBody
    });
    expect(updateBOwnKey.status).toBe(200);
    expect(updateBOwnKey.body.data.valueSet.name).toBe("Renamed");
    expect(updateBOwnKey.body.data.valueSet.description).toBe(
      "Shared description"
    );
  });

  test("ADVERSARIAL (security-review High, round 2): reusing the same Idempotency-Key across DELETE (deprecate) of two DIFFERENT value sets with an identical-shaped body must NOT replay the first's cached response for the second -- the mismatched hash must yield 409 CONFLICT, and the second value set must still actually deprecate once given its OWN key", async () => {
    const owner = await bootstrap();
    await createValueSetFixture(owner, "unit_of_measure", "none");
    await createValueSetFixture(owner, "fiscal_calendar", "none");

    const reusedKey = idKey();
    const sharedBody = { reason: "no longer needed" };

    // Deprecate A (unit_of_measure) with the reused key -- succeeds normally.
    const deprecateA = await invoke<{ data: { valueSet: { key: string } } }>(
      deprecateValueSet,
      {
        method: "DELETE",
        path: "/api/v1/reference-data/value-sets/unit_of_measure",
        params: { key: "unit_of_measure" },
        headers: authHeaders(owner, reusedKey),
        body: sharedBody
      }
    );
    expect(deprecateA.status).toBe(200);
    expect(deprecateA.body.data.valueSet.key).toBe("unit_of_measure");

    // Attempt to deprecate B (fiscal_calendar) with the SAME key and an
    // IDENTICALLY-shaped body. Pre-fix, `computeRequestHash(body)` never
    // included `key`, so this would silently REPLAY A's cached response
    // (200, describing A as deprecated) without ever touching B -- B
    // would appear "deprecated" to the caller while remaining active.
    const deprecateBReusedKey = await invoke(deprecateValueSet, {
      method: "DELETE",
      path: "/api/v1/reference-data/value-sets/fiscal_calendar",
      params: { key: "fiscal_calendar" },
      headers: authHeaders(owner, reusedKey),
      body: sharedBody
    });
    expect(deprecateBReusedKey.status).toBe(409);
    expect(
      (deprecateBReusedKey.body as { error: { code: string } }).error.code
    ).toBe("IDEMPOTENCY_CONFLICT");

    // B must still be untouched -- NOT falsely reported as deprecated.
    const admin = getAdminSql();
    const stillActiveRows = (await admin`
      SELECT deprecated_at FROM awcms_mini_reference_value_sets WHERE key = 'fiscal_calendar'
    `) as { deprecated_at: Date | null }[];
    expect(stillActiveRows).toHaveLength(1);
    expect(stillActiveRows[0]!.deprecated_at).toBeNull();

    // With its OWN distinct key, B's deprecation genuinely applies.
    const deprecateBOwnKey = await invoke<{
      data: { valueSet: { key: string } };
    }>(deprecateValueSet, {
      method: "DELETE",
      path: "/api/v1/reference-data/value-sets/fiscal_calendar",
      params: { key: "fiscal_calendar" },
      headers: authHeaders(owner, idKey()),
      body: sharedBody
    });
    expect(deprecateBOwnKey.status).toBe(200);

    const nowDeprecatedRows = (await admin`
      SELECT deprecated_at FROM awcms_mini_reference_value_sets WHERE key = 'fiscal_calendar'
    `) as { deprecated_at: Date | null }[];
    expect(nowDeprecatedRows[0]!.deprecated_at).not.toBeNull();
  });

  test("every mutation endpoint requires Idempotency-Key (400 IDEMPOTENCY_REQUIRED when omitted)", async () => {
    const owner = await bootstrap();
    const missingKeyResult = await invoke(createValueSet, {
      method: "POST",
      path: "/api/v1/reference-data/value-sets",
      headers: {
        "content-type": "application/json",
        "x-awcms-mini-tenant-id": owner.tenantId,
        authorization: `Bearer ${owner.token}`
      },
      body: { key: "currency", name: "Currency", overridePolicy: "none" }
    });
    expect(missingKeyResult.status).toBe(400);
  });
});
