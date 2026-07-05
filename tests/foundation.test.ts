import { describe, expect, test } from "bun:test";

import { ok } from "../src/modules/_shared/api-response";
import {
  activeRecordPredicate,
  deletedRecordPredicate,
  shouldIncludeDeleted,
  shouldOnlyListDeleted
} from "../src/modules/_shared/soft-delete";
import { getModuleByKey, listModules } from "../src/modules";
import {
  computeMigrationChecksum,
  discoverMigrationFiles,
  redactDatabaseUrl,
  stripOptionalTransactionWrapper,
  validateAppliedChecksums
} from "../scripts/db-migrate";
import {
  checkAsyncApi,
  checkOpenApi,
  runApiSpecChecks
} from "../scripts/api-spec-check";

describe("api response helper", () => {
  test("ok() returns standardized JSON response", async () => {
    const response = ok({ status: "ok" }, { requestId: "req-1" });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8"
    );
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { status: "ok" },
      meta: { requestId: "req-1" }
    });
  });
});

describe("soft delete helper", () => {
  test("defaults to active records only", () => {
    expect(shouldIncludeDeleted()).toBe(false);
    expect(shouldOnlyListDeleted()).toBe(false);
    expect(activeRecordPredicate()).toBe("deleted_at IS NULL");
    expect(deletedRecordPredicate("table.deleted_at")).toBe(
      "table.deleted_at IS NOT NULL"
    );
  });

  test("includeDeleted and onlyDeleted are explicit", () => {
    expect(shouldIncludeDeleted({ includeDeleted: true })).toBe(true);
    expect(shouldIncludeDeleted({ onlyDeleted: true })).toBe(true);
    expect(shouldOnlyListDeleted({ includeDeleted: true })).toBe(false);
    expect(shouldOnlyListDeleted({ onlyDeleted: true })).toBe(true);
  });
});

describe("module registry", () => {
  test("tenant_admin, profile_identity, identity_access, and sync_storage are registered after Issue 2.1-2.4, 12.1, and 6.1", () => {
    expect(listModules()).toHaveLength(4);
    expect(getModuleByKey("tenant_admin")).toMatchObject({
      key: "tenant_admin",
      status: "experimental"
    });
    expect(getModuleByKey("profile_identity")).toMatchObject({
      key: "profile_identity",
      status: "experimental",
      dependencies: ["tenant_admin"]
    });
    expect(getModuleByKey("identity_access")).toMatchObject({
      key: "identity_access",
      status: "experimental",
      dependencies: ["tenant_admin", "profile_identity"]
    });
    expect(getModuleByKey("sync_storage")).toMatchObject({
      key: "sync_storage",
      status: "experimental",
      dependencies: ["tenant_admin"]
    });
    expect(getModuleByKey("unknown_module")).toBeUndefined();
  });
});

describe("database migration runner helpers", () => {
  test("checksum is stable and prefixed", () => {
    const sql = "CREATE TABLE awcms_mini_example (id uuid PRIMARY KEY);";

    expect(computeMigrationChecksum(sql)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(computeMigrationChecksum(sql)).toBe(computeMigrationChecksum(sql));
  });

  test("optional BEGIN/COMMIT wrapper is stripped before runner transaction", () => {
    expect(
      stripOptionalTransactionWrapper("BEGIN;\nSELECT 1;\nCOMMIT;\n")
    ).toBe("SELECT 1;");
  });

  test("applied checksum mismatch fails fast", () => {
    expect(() =>
      validateAppliedChecksums(
        [
          {
            name: "001_awcms_mini_foundation_schema.sql",
            path: "sql/001_awcms_mini_foundation_schema.sql",
            sql: "SELECT 1;",
            checksum: "sha256:new"
          }
        ],
        [
          {
            migration_name: "001_awcms_mini_foundation_schema.sql",
            checksum: "sha256:old"
          }
        ]
      )
    ).toThrow("Checksum mismatch");
  });

  test("database url redaction removes password-bearing url", () => {
    const databaseUrl =
      "postgres://awcms-mini:secret-password@localhost:5432/awcms-mini";

    expect(redactDatabaseUrl(`failed for ${databaseUrl}`, databaseUrl)).toBe(
      "failed for [redacted DATABASE_URL]"
    );
  });

  test("real sql/ migrations are discoverable, ordered, and transaction-control-free", async () => {
    const migrations = await discoverMigrationFiles();

    expect(migrations.map((migration) => migration.name)).toEqual([
      "001_awcms_mini_foundation_schema.sql",
      "002_awcms_mini_tenant_office_schema.sql",
      "003_awcms_mini_central_profile_management_schema.sql",
      "004_awcms_mini_identity_login_schema.sql",
      "005_awcms_mini_abac_access_control_schema.sql",
      "006_awcms_mini_setup_wizard_schema.sql",
      "007_awcms_mini_sync_storage_outbox_inbox_schema.sql"
    ]);
    for (const migration of migrations) {
      expect(migration.checksum).toMatch(/^sha256:[a-f0-9]{64}$/);
    }
  });

  test("tenant/office schema declares RLS and soft-delete on office-scoped tables", async () => {
    const migrations = await discoverMigrationFiles();
    const tenantOfficeSchema = migrations.find(
      (migration) =>
        migration.name === "002_awcms_mini_tenant_office_schema.sql"
    );

    expect(tenantOfficeSchema).toBeDefined();
    expect(tenantOfficeSchema?.sql).toContain(
      "ALTER TABLE awcms_mini_offices ENABLE ROW LEVEL SECURITY"
    );
    expect(tenantOfficeSchema?.sql).toContain(
      "ALTER TABLE awcms_mini_physical_locations ENABLE ROW LEVEL SECURITY"
    );
    expect(tenantOfficeSchema?.sql).toContain(
      "ALTER TABLE awcms_mini_tenant_settings ENABLE ROW LEVEL SECURITY"
    );
    expect(tenantOfficeSchema?.sql).toContain("deleted_at timestamptz");
  });

  test("central profile schema declares RLS, dedup, and merge source-ne-target constraint", async () => {
    const migrations = await discoverMigrationFiles();
    const profileSchema = migrations.find(
      (migration) =>
        migration.name ===
        "003_awcms_mini_central_profile_management_schema.sql"
    );

    expect(profileSchema).toBeDefined();
    expect(profileSchema?.sql).toContain(
      "ALTER TABLE awcms_mini_profiles ENABLE ROW LEVEL SECURITY"
    );
    expect(profileSchema?.sql).toContain(
      "awcms_mini_profile_identifiers_dedup_key"
    );
    expect(profileSchema?.sql).toContain(
      "CHECK (source_profile_id <> target_profile_id)"
    );
  });

  test("identity/login schema declares RLS on identities, tenant_users, and sessions", async () => {
    const migrations = await discoverMigrationFiles();
    const identitySchema = migrations.find(
      (migration) =>
        migration.name === "004_awcms_mini_identity_login_schema.sql"
    );

    expect(identitySchema).toBeDefined();
    expect(identitySchema?.sql).toContain(
      "ALTER TABLE awcms_mini_identities ENABLE ROW LEVEL SECURITY"
    );
    expect(identitySchema?.sql).toContain(
      "ALTER TABLE awcms_mini_tenant_users ENABLE ROW LEVEL SECURITY"
    );
    expect(identitySchema?.sql).toContain(
      "ALTER TABLE awcms_mini_sessions ENABLE ROW LEVEL SECURITY"
    );
    expect(identitySchema?.sql).toContain(
      "awcms_mini_identities_tenant_login_key"
    );
  });

  test("abac schema declares RLS on tenant-scoped tables, seeds a generic permission catalog, and keeps the global permissions table RLS-free", async () => {
    const migrations = await discoverMigrationFiles();
    const abacSchema = migrations.find(
      (migration) =>
        migration.name === "005_awcms_mini_abac_access_control_schema.sql"
    );

    expect(abacSchema).toBeDefined();
    expect(abacSchema?.sql).toContain(
      "ALTER TABLE awcms_mini_roles ENABLE ROW LEVEL SECURITY"
    );
    expect(abacSchema?.sql).toContain(
      "ALTER TABLE awcms_mini_role_permissions ENABLE ROW LEVEL SECURITY"
    );
    expect(abacSchema?.sql).toContain(
      "ALTER TABLE awcms_mini_access_assignments ENABLE ROW LEVEL SECURITY"
    );
    expect(abacSchema?.sql).toContain(
      "ALTER TABLE awcms_mini_abac_policies ENABLE ROW LEVEL SECURITY"
    );
    expect(abacSchema?.sql).toContain(
      "ALTER TABLE awcms_mini_abac_decision_logs ENABLE ROW LEVEL SECURITY"
    );
    expect(abacSchema?.sql).not.toContain(
      "ALTER TABLE awcms_mini_permissions ENABLE ROW LEVEL SECURITY"
    );
    expect(abacSchema?.sql).toContain("'tenant_admin', 'office_management'");
    expect(abacSchema?.sql).not.toContain("catalog_inventory");
    expect(abacSchema?.sql).not.toContain("sales_pos");
  });

  test("setup wizard schema declares a global RLS-free singleton lock table", async () => {
    const migrations = await discoverMigrationFiles();
    const setupSchema = migrations.find(
      (migration) => migration.name === "006_awcms_mini_setup_wizard_schema.sql"
    );

    expect(setupSchema).toBeDefined();
    expect(setupSchema?.sql).toContain(
      "CREATE TABLE IF NOT EXISTS awcms_mini_setup_state"
    );
    expect(setupSchema?.sql).toContain("id boolean PRIMARY KEY DEFAULT true");
    expect(setupSchema?.sql).not.toContain("ENABLE ROW LEVEL SECURITY");
  });

  test("sync storage schema declares RLS on all tenant-scoped tables and an idempotency ledger", async () => {
    const migrations = await discoverMigrationFiles();
    const syncSchema = migrations.find(
      (migration) =>
        migration.name === "007_awcms_mini_sync_storage_outbox_inbox_schema.sql"
    );

    expect(syncSchema).toBeDefined();
    expect(syncSchema?.sql).toContain(
      "ALTER TABLE awcms_mini_sync_nodes ENABLE ROW LEVEL SECURITY"
    );
    expect(syncSchema?.sql).toContain(
      "ALTER TABLE awcms_mini_sync_outbox ENABLE ROW LEVEL SECURITY"
    );
    expect(syncSchema?.sql).toContain(
      "ALTER TABLE awcms_mini_sync_inbox ENABLE ROW LEVEL SECURITY"
    );
    expect(syncSchema?.sql).toContain(
      "ALTER TABLE awcms_mini_sync_push_batches ENABLE ROW LEVEL SECURITY"
    );
    expect(syncSchema?.sql).toContain("awcms_mini_sync_push_batches_key");
  });
});

describe("api contract baseline", () => {
  test("OpenAPI and AsyncAPI baseline files pass spec checks", async () => {
    await expect(runApiSpecChecks()).resolves.toEqual([]);
  });

  test("OpenAPI checker requires shared response schema", () => {
    expect(
      checkOpenApi(
        {
          openapi: "3.1.0",
          info: {},
          paths: { "/api/v1/health": { get: {} } },
          components: {
            schemas: {},
            securitySchemes: {},
            parameters: {}
          }
        },
        "openapi/test.yaml"
      ).some((problem) => problem.message.includes("ApiSuccess"))
    ).toBe(true);
  });

  test("AsyncAPI checker requires domain event envelope", () => {
    expect(
      checkAsyncApi(
        {
          asyncapi: "3.0.0",
          info: {},
          channels: {},
          components: { messages: {}, schemas: {}, securitySchemes: {} }
        },
        "asyncapi/test.yaml"
      ).some((problem) => problem.message.includes("DomainEventEnvelope"))
    ).toBe(true);
  });
});
