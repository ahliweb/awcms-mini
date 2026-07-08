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
  assertNoTransactionControl,
  computeMigrationChecksum,
  discoverMigrationFiles,
  redactDatabaseUrl,
  stripDollarQuotedBlocks,
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
  test("tenant_admin, profile_identity, identity_access, sync_storage, reporting, logging, workflow, form_drafts, email, module_management, and blog_content are registered after Issue 2.1-2.4, 12.1, 6.1-6.3, 9.1, 10.1, 11.1, #484, #493-#498, #511-#513, #537", () => {
    expect(listModules()).toHaveLength(11);
    expect(getModuleByKey("tenant_admin")).toMatchObject({
      key: "tenant_admin",
      status: "active"
    });
    expect(getModuleByKey("profile_identity")).toMatchObject({
      key: "profile_identity",
      status: "active",
      dependencies: ["tenant_admin"]
    });
    expect(getModuleByKey("identity_access")).toMatchObject({
      key: "identity_access",
      status: "active",
      dependencies: ["tenant_admin", "profile_identity"]
    });
    expect(getModuleByKey("sync_storage")).toMatchObject({
      key: "sync_storage",
      status: "active",
      dependencies: ["tenant_admin"]
    });
    expect(getModuleByKey("reporting")).toMatchObject({
      key: "reporting",
      status: "active",
      dependencies: ["tenant_admin", "identity_access", "sync_storage", "email"]
    });
    expect(getModuleByKey("logging")).toMatchObject({
      key: "logging",
      status: "active",
      dependencies: ["tenant_admin"]
    });
    expect(getModuleByKey("workflow")).toMatchObject({
      key: "workflow",
      status: "active",
      dependencies: ["tenant_admin", "identity_access"]
    });
    expect(getModuleByKey("form_drafts")).toMatchObject({
      key: "form_drafts",
      status: "active",
      dependencies: ["identity_access"]
    });
    expect(getModuleByKey("email")).toMatchObject({
      key: "email",
      status: "active",
      dependencies: ["tenant_admin", "profile_identity", "identity_access"]
    });
    expect(getModuleByKey("module_management")).toMatchObject({
      key: "module_management",
      status: "active",
      type: "system",
      isCore: true,
      dependencies: ["tenant_admin", "identity_access"]
    });
    expect(getModuleByKey("blog_content")).toMatchObject({
      key: "blog_content",
      version: "0.7.0",
      status: "active",
      type: "domain",
      dependencies: ["tenant_admin", "identity_access"]
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

  test("dollar-quoted block bodies are removed before scanning for transaction control", () => {
    // A PL/pgSQL DO block legitimately contains BEGIN/END as block delimiters;
    // stripping the $$...$$ body leaves only the outer statement to scan.
    const doBlock =
      "DO $$\nBEGIN\n  CREATE ROLE awcms_mini_app NOLOGIN;\nEND\n$$;";
    expect(stripDollarQuotedBlocks(doBlock)).not.toContain("BEGIN");
    // Tagged dollar-quotes ($tag$ ... $tag$) are matched by their tag too — the
    // whole quoted span (delimiters included) is removed, taking COMMIT with it.
    const stripped = stripDollarQuotedBlocks("$fn$ COMMIT; $fn$");
    expect(stripped).not.toContain("COMMIT");
    expect(stripped.trim()).toBe("");
  });

  test("a DO block with BEGIN/END passes the transaction-control check", () => {
    // Regression guard for migration 013: its `DO $$ BEGIN ... END $$` must not
    // be misread as a top-level BEGIN;/COMMIT; transaction-control statement.
    expect(() =>
      assertNoTransactionControl(
        "DO $$\nBEGIN\n  CREATE ROLE awcms_mini_app NOLOGIN;\nEND\n$$;",
        "013_awcms_mini_enforce_rls_least_privilege.sql"
      )
    ).not.toThrow();
    // But a real top-level BEGIN; is still rejected.
    expect(() =>
      assertNoTransactionControl("BEGIN;\nSELECT 1;", "999_bad.sql")
    ).toThrow("transaction control");
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
      "007_awcms_mini_sync_storage_outbox_inbox_schema.sql",
      "008_awcms_mini_sync_storage_conflict_schema.sql",
      "009_awcms_mini_object_sync_queue_schema.sql",
      "010_awcms_mini_management_reporting_permission_schema.sql",
      "011_awcms_mini_audit_logging_schema.sql",
      "012_awcms_mini_workflow_approval_schema.sql",
      "013_awcms_mini_enforce_rls_least_privilege.sql",
      "014_awcms_mini_sync_node_management_permission_schema.sql",
      "015_awcms_mini_tenant_settings_management_permission_schema.sql",
      "016_awcms_mini_tenant_default_locale_english_schema.sql",
      "017_awcms_mini_sync_queue_conflict_performance_indexes.sql",
      "018_awcms_mini_object_sync_queue_dispatcher_schema.sql",
      "019_awcms_mini_form_drafts_schema.sql",
      "020_awcms_mini_email_schema.sql",
      "021_awcms_mini_email_template_i18n_schema.sql",
      "022_awcms_mini_password_reset_schema.sql",
      "023_awcms_mini_email_announcement_permission_schema.sql",
      "024_awcms_mini_email_message_cancel_permission_schema.sql",
      "025_awcms_mini_module_management_schema.sql",
      "026_awcms_mini_blog_content_schema.sql",
      "027_awcms_mini_blog_content_permissions.sql",
      "028_awcms_mini_blog_content_search_vector.sql",
      "029_awcms_mini_blog_content_presentation_schema.sql",
      "030_awcms_mini_blog_content_presentation_permissions.sql"
    ]);
    for (const migration of migrations) {
      expect(migration.checksum).toMatch(/^sha256:[a-f0-9]{64}$/);
    }
  });

  test("rls-enforcement migration FORCEs RLS on tenant tables and creates a least-privilege app role", async () => {
    const migrations = await discoverMigrationFiles();
    const rlsSchema = migrations.find(
      (migration) =>
        migration.name === "013_awcms_mini_enforce_rls_least_privilege.sql"
    );

    expect(rlsSchema).toBeDefined();
    // FORCE (not just ENABLE) is what makes RLS apply to the table owner.
    expect(rlsSchema?.sql).toContain(
      "ALTER TABLE awcms_mini_offices FORCE ROW LEVEL SECURITY"
    );
    expect(rlsSchema?.sql).toContain(
      "ALTER TABLE awcms_mini_profiles FORCE ROW LEVEL SECURITY"
    );
    // Least-privilege role, created NOLOGIN/passwordless (no secret in git).
    expect(rlsSchema?.sql).toContain("CREATE ROLE awcms_mini_app NOLOGIN");
    expect(rlsSchema?.sql).not.toMatch(
      /CREATE ROLE awcms_mini_app[^;]*PASSWORD/i
    );
    // Fail-closed default tenant GUC (all-zero UUID matches no real tenant).
    expect(rlsSchema?.sql).toContain(
      "app.current_tenant_id = '00000000-0000-0000-0000-000000000000'"
    );
    // DML grants only — no ownership/DDL handed to the app role.
    expect(rlsSchema?.sql).toContain(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO awcms_mini_app"
    );
  });

  test("sync node management migration seeds read/update permissions with no schema change", async () => {
    const migrations = await discoverMigrationFiles();
    const nodeMgmtSchema = migrations.find(
      (migration) =>
        migration.name ===
        "014_awcms_mini_sync_node_management_permission_schema.sql"
    );

    expect(nodeMgmtSchema).toBeDefined();
    expect(nodeMgmtSchema?.sql).toContain(
      "('sync_storage', 'node_management', 'read'"
    );
    expect(nodeMgmtSchema?.sql).toContain(
      "('sync_storage', 'node_management', 'update'"
    );
    expect(nodeMgmtSchema?.sql).not.toContain("CREATE TABLE");
    expect(nodeMgmtSchema?.sql).not.toContain("ALTER TABLE");
  });

  test("tenant settings management migration seeds read/update permissions with no schema change", async () => {
    const migrations = await discoverMigrationFiles();
    const settingsMgmtSchema = migrations.find(
      (migration) =>
        migration.name ===
        "015_awcms_mini_tenant_settings_management_permission_schema.sql"
    );

    expect(settingsMgmtSchema).toBeDefined();
    expect(settingsMgmtSchema?.sql).toContain(
      "('tenant_admin', 'tenant_settings', 'read'"
    );
    expect(settingsMgmtSchema?.sql).toContain(
      "('tenant_admin', 'tenant_settings', 'update'"
    );
    expect(settingsMgmtSchema?.sql).not.toContain("CREATE TABLE");
    expect(settingsMgmtSchema?.sql).not.toContain("ALTER TABLE");
  });

  test("default locale migration flips the tenant default to English without touching migration 002", async () => {
    const migrations = await discoverMigrationFiles();
    const localeSchema = migrations.find(
      (migration) =>
        migration.name ===
        "016_awcms_mini_tenant_default_locale_english_schema.sql"
    );
    const tenantOfficeSchema = migrations.find(
      (migration) =>
        migration.name === "002_awcms_mini_tenant_office_schema.sql"
    );

    expect(localeSchema).toBeDefined();
    expect(localeSchema?.sql).toContain(
      "ALTER TABLE awcms_mini_tenants ALTER COLUMN default_locale SET DEFAULT 'en'"
    );
    expect(localeSchema?.sql).not.toContain("CREATE TABLE");
    // Migration 002 itself is untouched — it keeps its original 'id' default;
    // 016 only changes what NEW rows get from here on, via a later ALTER.
    expect(tenantOfficeSchema?.sql).toContain(
      "default_locale text NOT NULL DEFAULT 'id'"
    );
  });

  test("performance index migration adds only indexes, no schema/data changes (Issue #435)", async () => {
    const migrations = await discoverMigrationFiles();
    const perfSchema = migrations.find(
      (migration) =>
        migration.name ===
        "017_awcms_mini_sync_queue_conflict_performance_indexes.sql"
    );

    expect(perfSchema).toBeDefined();
    expect(perfSchema?.sql).toContain(
      "CREATE INDEX IF NOT EXISTS awcms_mini_object_sync_queue_tenant_created_idx"
    );
    expect(perfSchema?.sql).toContain(
      "CREATE INDEX IF NOT EXISTS awcms_mini_object_sync_queue_tenant_status_created_idx"
    );
    expect(perfSchema?.sql).toContain(
      "CREATE INDEX IF NOT EXISTS awcms_mini_object_sync_queue_tenant_node_created_idx"
    );
    expect(perfSchema?.sql).toContain(
      "CREATE INDEX IF NOT EXISTS awcms_mini_sync_conflicts_tenant_created_idx"
    );
    expect(perfSchema?.sql).not.toContain("CREATE TABLE");
    expect(perfSchema?.sql).not.toContain("ALTER TABLE");
    expect(perfSchema?.sql).not.toContain("DROP INDEX");
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

  test("sync conflict schema declares RLS, an immutable conflict table, and generic conflict_resolution permissions", async () => {
    const migrations = await discoverMigrationFiles();
    const conflictSchema = migrations.find(
      (migration) =>
        migration.name === "008_awcms_mini_sync_storage_conflict_schema.sql"
    );

    expect(conflictSchema).toBeDefined();
    expect(conflictSchema?.sql).toContain(
      "ALTER TABLE awcms_mini_sync_aggregate_versions ENABLE ROW LEVEL SECURITY"
    );
    expect(conflictSchema?.sql).toContain(
      "ALTER TABLE awcms_mini_sync_conflicts ENABLE ROW LEVEL SECURITY"
    );
    expect(conflictSchema?.sql).toContain(
      "CHECK (conflict_type IN ('version_mismatch', 'missing_base_version'))"
    );
    expect(conflictSchema?.sql).toContain(
      "('sync_storage', 'conflict_resolution', 'read'"
    );
    expect(conflictSchema?.sql).toContain(
      "('sync_storage', 'conflict_resolution', 'approve'"
    );
  });

  test("object sync queue schema declares RLS, a retry-scan index, an upsert key, and generic object_queue permissions", async () => {
    const migrations = await discoverMigrationFiles();
    const objectQueueSchema = migrations.find(
      (migration) =>
        migration.name === "009_awcms_mini_object_sync_queue_schema.sql"
    );

    expect(objectQueueSchema).toBeDefined();
    expect(objectQueueSchema?.sql).toContain(
      "ALTER TABLE awcms_mini_object_sync_queue ENABLE ROW LEVEL SECURITY"
    );
    expect(objectQueueSchema?.sql).toContain(
      "CHECK (status IN ('pending', 'sent', 'failed'))"
    );
    expect(objectQueueSchema?.sql).toContain(
      "awcms_mini_object_sync_queue_key"
    );
    expect(objectQueueSchema?.sql).toContain(
      "awcms_mini_object_sync_queue_retry_idx"
    );
    expect(objectQueueSchema?.sql).toContain(
      "('sync_storage', 'object_queue', 'read'"
    );
    expect(objectQueueSchema?.sql).toContain(
      "('sync_storage', 'object_queue', 'retry'"
    );
  });

  test("management reporting schema seeds exactly one shared dashboard permission and declares no new table", async () => {
    const migrations = await discoverMigrationFiles();
    const reportingSchema = migrations.find(
      (migration) =>
        migration.name ===
        "010_awcms_mini_management_reporting_permission_schema.sql"
    );

    expect(reportingSchema).toBeDefined();
    expect(reportingSchema?.sql).toContain("('reporting', 'dashboard', 'read'");
    expect(reportingSchema?.sql).toContain(
      "ON CONFLICT (module_key, activity_code, action) DO NOTHING"
    );
    expect(reportingSchema?.sql).not.toContain("CREATE TABLE");
    expect(reportingSchema?.sql).not.toContain("ENABLE ROW LEVEL SECURITY");
    // One dashboard feature, not four fragmented permissions.
    expect(
      reportingSchema?.sql.match(/'reporting', 'dashboard'/g) ?? []
    ).toHaveLength(1);
  });

  test("audit logging schema declares the generic audit_events table with RLS and seeds the audit_trail/purge permissions", async () => {
    const migrations = await discoverMigrationFiles();
    const auditSchema = migrations.find(
      (migration) =>
        migration.name === "011_awcms_mini_audit_logging_schema.sql"
    );

    expect(auditSchema).toBeDefined();
    expect(auditSchema?.sql).toContain(
      "CREATE TABLE IF NOT EXISTS awcms_mini_audit_events"
    );
    expect(auditSchema?.sql).toContain(
      "ALTER TABLE awcms_mini_audit_events ENABLE ROW LEVEL SECURITY"
    );
    expect(auditSchema?.sql).toContain(
      "CHECK (severity IN ('info', 'warning', 'critical'))"
    );
    expect(auditSchema?.sql).toContain(
      "awcms_mini_audit_events_tenant_created_idx"
    );
    expect(auditSchema?.sql).toContain(
      "awcms_mini_audit_events_tenant_resource_idx"
    );
    expect(auditSchema?.sql).toContain("('logging', 'audit_trail', 'read'");
    expect(auditSchema?.sql).toContain(
      "('profile_identity', 'profile_management', 'purge'"
    );
    expect(auditSchema?.sql).toContain(
      "ON CONFLICT (module_key, activity_code, action) DO NOTHING"
    );
  });

  test("workflow approval schema declares the 4 workflow tables plus the generic idempotency store, all RLS, and seeds the read/approve permissions", async () => {
    const migrations = await discoverMigrationFiles();
    const workflowSchema = migrations.find(
      (migration) =>
        migration.name === "012_awcms_mini_workflow_approval_schema.sql"
    );

    expect(workflowSchema).toBeDefined();

    for (const table of [
      "awcms_mini_workflow_definitions",
      "awcms_mini_workflow_instances",
      "awcms_mini_workflow_tasks",
      "awcms_mini_workflow_decisions",
      "awcms_mini_idempotency_keys"
    ]) {
      expect(workflowSchema?.sql).toContain(
        `CREATE TABLE IF NOT EXISTS ${table}`
      );
      expect(workflowSchema?.sql).toContain(
        `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`
      );
    }

    expect(workflowSchema?.sql).toContain(
      "awcms_mini_workflow_definitions_key_dedup"
    );
    expect(workflowSchema?.sql).toContain(
      "CHECK (decision IN ('approve', 'reject'))"
    );
    expect(workflowSchema?.sql).toContain(
      "awcms_mini_idempotency_keys_scope_key"
    );
    expect(workflowSchema?.sql).toContain("('workflow', 'approval', 'read'");
    expect(workflowSchema?.sql).toContain("('workflow', 'approval', 'approve'");
    expect(workflowSchema?.sql).toContain(
      "ON CONFLICT (module_key, activity_code, action) DO NOTHING"
    );
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

  // Contract version is independent SemVer (ADR-0008) — the check only
  // enforces the X.Y.Z shape, not a specific value.
  test("OpenAPI checker requires info.version to be SemVer", () => {
    const problems = checkOpenApi(
      {
        openapi: "3.1.0",
        info: { version: "not-semver" },
        paths: { "/api/v1/health": { get: {} } },
        components: { schemas: {}, securitySchemes: {}, parameters: {} }
      },
      "openapi/test.yaml"
    );

    expect(
      problems.some((problem) => problem.message.includes("info.version"))
    ).toBe(true);
  });

  test("AsyncAPI checker requires info.version to be SemVer", () => {
    const problems = checkAsyncApi(
      {
        asyncapi: "3.0.0",
        info: { version: "v1" },
        channels: {},
        components: { messages: {}, schemas: {}, securitySchemes: {} }
      },
      "asyncapi/test.yaml"
    );

    expect(
      problems.some((problem) => problem.message.includes("info.version"))
    ).toBe(true);
  });
});
