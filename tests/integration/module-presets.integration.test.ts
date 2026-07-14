/**
 * Integration tests for the tenant module preset application service
 * (Issue #565, epic #555) against a real PostgreSQL: real
 * `awcms_mini_tenant_modules` row states and real
 * `awcms_mini_audit_events` rows after applying a preset, re-applying it
 * (idempotency), and switching from one preset to a different one (proving
 * the previous preset's non-listed, non-core modules actually get
 * disabled — design decision documented in
 * `src/modules/module-management/domain/module-presets.ts`).
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  createCookieJar,
  getAdminSql,
  integrationEnabled,
  invoke,
  provisionAppRole,
  resetDatabase
} from "./harness";

import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import { getDatabaseClient } from "../../src/lib/database/client";
import { withTenant } from "../../src/lib/database/tenant-context";
import { applyModulePreset } from "../../src/modules/module-management/application/module-presets";

const OWNER_LOGIN = "owner@example.com";
const OWNER_PASSWORD = "integration-test-owner-password";

type Bootstrap = { tenantId: string; token: string; tenantUserId: string };

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

async function fetchTenantModuleState(
  tenantId: string
): Promise<Map<string, boolean>> {
  const admin = getAdminSql();
  const rows = (await admin`
    SELECT module_key, enabled FROM awcms_mini_tenant_modules
    WHERE tenant_id = ${tenantId}
  `) as { module_key: string; enabled: boolean }[];

  return new Map(rows.map((row) => [row.module_key, row.enabled]));
}

async function fetchAuditActions(
  tenantId: string
): Promise<{ action: string; resource_id: string; attributes: unknown }[]> {
  const admin = getAdminSql();
  return (await admin`
    SELECT action, resource_id, attributes
    FROM awcms_mini_audit_events
    WHERE tenant_id = ${tenantId}
      AND action IN ('tenant_module_enabled', 'tenant_module_disabled')
    ORDER BY created_at ASC
  `) as { action: string; resource_id: string; attributes: unknown }[];
}

const suite = integrationEnabled ? describe : describe.skip;

suite("tenant module preset application service", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  test("applying online_website enables its listed modules (all default-enabled already, so no changes), disables the safely-disableable non-listed modules, and skips one blocked by a transitive dependency", async () => {
    const owner = await bootstrap();
    const sql = getDatabaseClient();

    const result = await withTenant(sql, owner.tenantId, (tx) =>
      applyModulePreset(
        tx,
        owner.tenantId,
        owner.tenantUserId,
        "online_website"
      )
    );

    expect(result.outcome).toBe("applied");
    if (result.outcome !== "applied") throw new Error("unreachable");

    // Every module is enabled by default for a fresh tenant, so
    // online_website's own listed modules are already in the target state
    // — the domain plan never even includes them as enable candidates
    // (nothing to attempt, nothing to report), so they simply don't
    // appear in `changes` at all.
    const changeByKey = new Map(result.changes.map((c) => [c.moduleKey, c]));
    for (const key of ["tenant_domain", "blog_content", "email", "reporting"]) {
      expect(changeByKey.has(key)).toBe(false);
    }
    // logging/workflow/form_drafts/visitor_analytics/news_portal/
    // idn_admin_regions aren't listed and nothing (that stays enabled)
    // depends on them, so they're safely disabled to actually produce the
    // profile. visitor_analytics itself depends on logging/reporting, but
    // nothing depends on visitor_analytics — a pure leaf — so it disables
    // cleanly and, once it's gone, unblocks logging the same way.
    // news_portal (Issue #632) deliberately declares no hard dependency on
    // blog_content/tenant_domain/visitor_analytics (see its own module.ts
    // comment), so it is likewise a pure leaf here. idn_admin_regions
    // (Issue #655) depends on identity_access/logging/module_management,
    // all of which stay enabled, but nothing depends on idn_admin_regions
    // itself — also a pure leaf. domain_event_runtime (Issue #742) depends
    // on tenant_admin/identity_access/logging, all of which stay enabled
    // (logging disables in this SAME preset application, but leaves-first
    // ordering disables domain_event_runtime first, same as it does for
    // visitor_analytics before logging) — nothing depends on
    // domain_event_runtime itself, also a pure leaf. organization_structure
    // (Issue #749) and document_infrastructure (Issue #751) both depend on
    // tenant_admin/identity_access/domain_event_runtime, all of which stay
    // enabled or disable in this same pass — nothing depends on either of
    // them, also pure leaves, and both disable BEFORE domain_event_runtime
    // (leaves-first ordering: a module that still depends on
    // domain_event_runtime must be disabled first).
    // data_exchange (Issue #752) depends on tenant_admin/identity_access/
    // logging/domain_event_runtime, all of which stay enabled or disable in
    // this same pass — nothing depends on data_exchange itself, also a pure
    // leaf, and it disables BEFORE both logging and domain_event_runtime for
    // the same reason.
    for (const key of [
      "logging",
      "workflow",
      "form_drafts",
      "visitor_analytics",
      "news_portal",
      "idn_admin_regions",
      "social_publishing",
      "data_lifecycle",
      "organization_structure",
      "document_infrastructure",
      "domain_event_runtime",
      "data_exchange"
    ]) {
      expect(changeByKey.get(key)?.outcome).toBe("applied");
      expect(changeByKey.get(key)?.action).toBe("disabled");
    }
    // sync_storage is also not listed, but `reporting` (which IS listed,
    // so stays enabled) depends on it — so it must be skipped, not
    // force-disabled, per the reverse-dependency protection design.
    expect(changeByKey.has("sync_storage")).toBe(false);
    expect(result.skipped).toContainEqual({
      moduleKey: "sync_storage",
      action: "disabled",
      reason: "reverse_dependency_active",
      message: expect.stringContaining("sync_storage")
    });

    const state = await fetchTenantModuleState(owner.tenantId);
    expect(state.get("tenant_domain")).not.toBe(false);
    expect(state.get("sync_storage")).not.toBe(false);
    expect(state.get("logging")).toBe(false);
    expect(state.get("workflow")).toBe(false);
    expect(state.get("form_drafts")).toBe(false);
    expect(state.get("visitor_analytics")).toBe(false);
    expect(state.get("news_portal")).toBe(false);
    expect(state.get("idn_admin_regions")).toBe(false);
    expect(state.get("social_publishing")).toBe(false);
    expect(state.get("data_lifecycle")).toBe(false);
    expect(state.get("organization_structure")).toBe(false);
    expect(state.get("document_infrastructure")).toBe(false);
    expect(state.get("domain_event_runtime")).toBe(false);
    expect(state.get("data_exchange")).toBe(false);

    const auditRows = await fetchAuditActions(owner.tenantId);
    const disabledResourceIds = auditRows
      .filter((r) => r.action === "tenant_module_disabled")
      .map((r) => r.resource_id)
      .sort();
    expect(disabledResourceIds).toEqual(
      [
        "form_drafts",
        "logging",
        "workflow",
        "visitor_analytics",
        "news_portal",
        "idn_admin_regions",
        "social_publishing",
        "data_lifecycle",
        "organization_structure",
        "document_infrastructure",
        "domain_event_runtime",
        "data_exchange"
      ].sort()
    );
    // No audit event for modules that were already in the target state.
    expect(auditRows.some((r) => r.action === "tenant_module_enabled")).toBe(
      false
    );
  });

  test("re-applying the same preset is idempotent: second call plans and changes nothing, writes no new audit events", async () => {
    const owner = await bootstrap();
    const sql = getDatabaseClient();

    await withTenant(sql, owner.tenantId, (tx) =>
      applyModulePreset(
        tx,
        owner.tenantId,
        owner.tenantUserId,
        "online_website"
      )
    );
    const firstAuditCount = (await fetchAuditActions(owner.tenantId)).length;
    expect(firstAuditCount).toBeGreaterThan(0);

    const second = await withTenant(sql, owner.tenantId, (tx) =>
      applyModulePreset(
        tx,
        owner.tenantId,
        owner.tenantUserId,
        "online_website"
      )
    );

    expect(second.outcome).toBe("applied");
    if (second.outcome !== "applied") throw new Error("unreachable");
    expect(second.changes.every((c) => c.outcome === "already_satisfied")).toBe(
      true
    );
    expect(second.changes.some((c) => c.outcome === "rejected")).toBe(false);

    const secondAuditCount = (await fetchAuditActions(owner.tenantId)).length;
    expect(secondAuditCount).toBe(firstAuditCount);
  });

  test("applying minimal disables every non-core module, protecting module_management/tenant_admin/identity_access/profile_identity", async () => {
    const owner = await bootstrap();
    const sql = getDatabaseClient();

    const result = await withTenant(sql, owner.tenantId, (tx) =>
      applyModulePreset(tx, owner.tenantId, owner.tenantUserId, "minimal")
    );

    expect(result.outcome).toBe("applied");
    if (result.outcome !== "applied") throw new Error("unreachable");

    // module_management is CORE_MODULE_CANNOT_BE_DISABLED-protected and
    // never even attempted (excluded from the plan entirely, per
    // resolveProtectedModuleKeys).
    expect(
      result.changes.some((c) => c.moduleKey === "module_management")
    ).toBe(false);
    expect(result.changes.some((c) => c.moduleKey === "tenant_admin")).toBe(
      false
    );
    expect(result.changes.some((c) => c.moduleKey === "identity_access")).toBe(
      false
    );
    expect(result.changes.some((c) => c.moduleKey === "profile_identity")).toBe(
      false
    );

    const state = await fetchTenantModuleState(owner.tenantId);
    // Protected modules have no row at all (never touched) or remain enabled.
    expect(state.get("module_management")).not.toBe(false);
    expect(state.get("tenant_admin")).not.toBe(false);
    expect(state.get("identity_access")).not.toBe(false);
    expect(state.get("profile_identity")).not.toBe(false);

    // Everything else disabled.
    for (const key of [
      "blog_content",
      "email",
      "reporting",
      "sync_storage",
      "tenant_domain",
      "workflow",
      "form_drafts",
      "visitor_analytics",
      "news_portal",
      "idn_admin_regions",
      "social_publishing",
      "data_lifecycle",
      "domain_event_runtime"
    ]) {
      expect(state.get(key)).toBe(false);
    }
  });

  test("switching from pos_lan to saas_online: pos_lan's own non-listed, non-blocked modules actually get disabled, and modules a still-kept module transitively needs (email under pos_lan, sync_storage under saas_online) are skipped rather than force-disabled", async () => {
    const owner = await bootstrap();
    const sql = getDatabaseClient();

    const posLan = await withTenant(sql, owner.tenantId, (tx) =>
      applyModulePreset(tx, owner.tenantId, owner.tenantUserId, "pos_lan")
    );
    expect(posLan.outcome).toBe("applied");
    if (posLan.outcome !== "applied") throw new Error("unreachable");

    // pos_lan lists sync_storage/reporting/workflow — reporting is what's
    // actually driving this: it depends on both sync_storage AND email, so
    // `email` (not listed by pos_lan at all) is transitively still
    // required and must be skipped, not disabled.
    expect(posLan.skipped).toContainEqual({
      moduleKey: "email",
      action: "disabled",
      reason: "reverse_dependency_active",
      message: expect.stringContaining("email")
    });
    // tenant_domain/blog_content are genuinely unrelated to anything kept
    // enabled, so they ARE safely disabled.
    const posLanChangeByKey = new Map(
      posLan.changes.map((c) => [c.moduleKey, c])
    );
    expect(posLanChangeByKey.get("tenant_domain")?.action).toBe("disabled");
    expect(posLanChangeByKey.get("blog_content")?.action).toBe("disabled");

    const stateAfterPosLan = await fetchTenantModuleState(owner.tenantId);
    expect(stateAfterPosLan.get("sync_storage")).not.toBe(false);
    expect(stateAfterPosLan.get("reporting")).not.toBe(false);
    expect(stateAfterPosLan.get("workflow")).not.toBe(false);
    expect(stateAfterPosLan.get("email")).not.toBe(false);
    expect(stateAfterPosLan.get("tenant_domain")).toBe(false);
    expect(stateAfterPosLan.get("blog_content")).toBe(false);

    const saas = await withTenant(sql, owner.tenantId, (tx) =>
      applyModulePreset(tx, owner.tenantId, owner.tenantUserId, "saas_online")
    );
    expect(saas.outcome).toBe("applied");
    if (saas.outcome !== "applied") throw new Error("unreachable");

    // saas_online lists tenant_domain — it was disabled by pos_lan, so it
    // actually gets (re-)enabled now.
    const changeByKey = new Map(saas.changes.map((c) => [c.moduleKey, c]));
    expect(changeByKey.get("tenant_domain")?.outcome).toBe("applied");
    expect(changeByKey.get("tenant_domain")?.action).toBe("enabled");
    // email/reporting/workflow were already enabled and stay listed (or,
    // for email, transitively required) by saas_online — untouched.
    expect(changeByKey.has("email")).toBe(false);
    expect(changeByKey.has("reporting")).toBe(false);
    expect(changeByKey.has("workflow")).toBe(false);

    // sync_storage is NOT listed by saas_online, so it's a disable
    // candidate — but reporting (kept enabled) still depends on it, so it
    // must be skipped, not disabled and not force-attempted.
    expect(saas.changes.some((c) => c.moduleKey === "sync_storage")).toBe(
      false
    );
    expect(saas.skipped).toContainEqual({
      moduleKey: "sync_storage",
      action: "disabled",
      reason: "reverse_dependency_active",
      message: expect.stringContaining("sync_storage")
    });

    const finalState = await fetchTenantModuleState(owner.tenantId);
    expect(finalState.get("sync_storage")).not.toBe(false);
    expect(finalState.get("tenant_domain")).toBe(true);
    expect(finalState.get("email")).not.toBe(false);
  });

  test("audit events carry the preset name and are written per-module, not one aggregate event", async () => {
    const owner = await bootstrap();
    const sql = getDatabaseClient();

    await withTenant(sql, owner.tenantId, (tx) =>
      applyModulePreset(tx, owner.tenantId, owner.tenantUserId, "minimal")
    );

    const auditRows = await fetchAuditActions(owner.tenantId);
    expect(auditRows.length).toBeGreaterThan(1);
    expect(auditRows.every((r) => r.action === "tenant_module_disabled")).toBe(
      true
    );
    for (const row of auditRows) {
      expect((row.attributes as { presetName?: string }).presetName).toBe(
        "minimal"
      );
    }
  });

  test("unknown preset name is rejected without touching any module state", async () => {
    const owner = await bootstrap();
    const sql = getDatabaseClient();

    const result = await withTenant(sql, owner.tenantId, (tx) =>
      applyModulePreset(
        tx,
        owner.tenantId,
        owner.tenantUserId,
        "does_not_exist"
      )
    );

    expect(result).toEqual({
      outcome: "rejected",
      code: "MODULE_PRESET_NOT_FOUND",
      message: expect.stringContaining("does_not_exist")
    });

    const auditRows = await fetchAuditActions(owner.tenantId);
    expect(auditRows).toEqual([]);
  });

  test("RLS: applying a preset for tenant A never writes tenant_modules rows for tenant B", async () => {
    const ownerA = await bootstrap("tenant-a", "Tenant A");
    const admin = getAdminSql();
    const tenantBId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    await admin`
      INSERT INTO awcms_mini_tenants
        (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
      VALUES (${tenantBId}, 'tenant-b', 'Tenant B', 'Tenant B Legal', 'active', 'en', 'light')
    `;

    const sql = getDatabaseClient();
    await withTenant(sql, ownerA.tenantId, (tx) =>
      applyModulePreset(tx, ownerA.tenantId, ownerA.tenantUserId, "minimal")
    );

    const rows = (await admin`
      SELECT count(*)::int AS count FROM awcms_mini_tenant_modules
      WHERE tenant_id = ${tenantBId}
    `) as { count: number }[];
    expect(rows[0]?.count).toBe(0);
  });
});
