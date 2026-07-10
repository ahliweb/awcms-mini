-- Issue #636 (epic `news_portal` #631-#642/#649) — a genuinely tamper-proof
-- per-tenant "has this tenant applied the news_portal_full_online_r2 preset"
-- signal, read by `blog_content`'s `news-portal-r2-mode-gate.ts` to decide
-- whether R2-only media validation is active for a given tenant.
--
-- ## Why this is a NEW, dedicated table instead of reusing an existing one
-- (security-auditor finding, PR #666 second re-review)
--
-- Two earlier attempts at this signal both failed:
--   1. `awcms_mini_tenant_modules.enabled` (`fetchTenantModuleEntry`) is
--      opt-out-by-default — every tenant reads as "news_portal enabled"
--      whether or not the preset was ever applied, so it cannot distinguish
--      "opted in" from "never touched".
--   2. `awcms_mini_module_settings` (the generic per-tenant module settings
--      store, via `updateModuleSettings`) DOES persist an explicit marker,
--      but that table is directly tenant-writable through the generic
--      `PATCH /api/v1/tenant/modules/{moduleKey}/settings` endpoint, gated
--      only by the generic `module_management.settings.update` permission
--      (granted to Owner/Admin by default seed RBAC) — completely
--      unrelated to `blog_content`/`news_portal` permissions. A tenant
--      holding that generic permission could `PATCH` the marker key to
--      `null` and silently disable ALL of Issue #636's R2-only validation
--      for themselves, confirmed exploitable end-to-end in review.
--
-- This table has NO generic write endpoint anywhere — the ONLY code that
-- ever writes to it is `news-portal/application/apply-news-portal-preset.ts`
-- (`applyNewsPortalFullOnlineR2Preset`, the single sanctioned entry point
-- for this preset, per that file's own header comment). RLS FORCE'd like
-- every other tenant-scoped table in this repo, but that alone would not
-- have been enough for the two mechanisms above either — the real
-- protection here is architectural: no route/domain code outside
-- `apply-news-portal-preset.ts` imports the write function this table's
-- application-layer module exposes.
--
-- One row per tenant (tenant_id is the primary key, not a foreign
-- surrogate) — this table only ever needs to answer one yes/no question
-- per tenant, never a list.
CREATE TABLE IF NOT EXISTS awcms_mini_news_portal_tenant_state (
  tenant_id uuid PRIMARY KEY REFERENCES awcms_mini_tenants (id),
  full_online_r2_mode_applied_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE awcms_mini_news_portal_tenant_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_news_portal_tenant_state FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_news_portal_tenant_state_tenant_isolation
  ON awcms_mini_news_portal_tenant_state
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
