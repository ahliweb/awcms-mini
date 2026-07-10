/**
 * Tenant-scoped "is full-online R2-only news media mode actually active
 * right now" gate (Issue #636, epic `news_portal`).
 *
 * `evaluateNewsPortalFullOnlineR2Readiness` (`news-portal/domain/
 * news-portal-preset-readiness.ts`, Issue #632) answers a purely
 * env-based/global question: "COULD this deployment run the
 * `news_portal_full_online_r2` preset." It takes no `tenantId` at all — a
 * deployment can have every env var correct while a SPECIFIC tenant has
 * never actually applied the preset. Issue #636's validation (require R2
 * media references for blog post/page images) must be conditional on the
 * mode being active FOR THE TENANT MAKING THE REQUEST, not merely "this
 * deployment could run it" — otherwise a tenant that never opted into the
 * preset would suddenly have its plain-URL featured images/gallery blocks
 * rejected the moment ANY tenant on the same deployment turns on
 * `NEWS_MEDIA_R2_ENABLED`.
 *
 * ## THREE failed attempts before this one — read before touching this file again (PR #666, three review rounds)
 *
 * 1. `fetchTenantModuleEntry(...).tenantEnabled` — every module in this
 *    repo is opt-out-by-default (no `awcms_mini_tenant_modules` row means
 *    enabled), so virtually every tenant reads as `news_portal`-enabled
 *    regardless of whether they ever applied the preset. Made the entire
 *    tenant-scoping in this file a no-op — activating the preset for one
 *    tenant silently tightened validation for every OTHER tenant on the
 *    same deployment too.
 * 2. `entry.enabledAt !== null` — reasoning was "only an explicit
 *    `enableTenantModule` call sets this column." Also broken:
 *    `enableTenantModule` validates the tenant's CURRENT state first, and
 *    since that state already reads as enabled-by-default (same fact as
 *    #1), the lifecycle validation rejects the call as
 *    `MODULE_ALREADY_ENABLED`, which `applyModulePreset` treats as
 *    `already_satisfied` and — critically — never writes a row at all. A
 *    tenant that genuinely just applied the preset had `enabledAt: null`,
 *    identical to one that never touched it. Confirmed broken by a
 *    failing integration test, not just theory.
 * 3. `awcms_mini_module_settings` (`updateModuleSettings`/
 *    `fetchModuleSettingsView`) — this one DID correctly distinguish
 *    "applied" from "never touched." But that table is directly
 *    tenant-writable through the generic
 *    `PATCH /api/v1/tenant/modules/{moduleKey}/settings` endpoint, gated
 *    only by the generic `module_management.settings.update` permission
 *    (granted to Owner/Admin by default seed RBAC — entirely unrelated to
 *    `blog_content`/`news_portal` permissions). A tenant holding that
 *    permission could `PATCH` the marker key to `null` and silently
 *    disable ALL of this issue's validation for themselves — confirmed
 *    exploitable end-to-end in a security re-audit.
 *
 * The real, working signal: a brand-new, dedicated table
 * (`awcms_mini_news_portal_tenant_state`, migration `043`) that has NO
 * generic write endpoint anywhere. The only code that ever writes to it is
 * `news-portal/application/apply-news-portal-preset.ts`
 * (`applyNewsPortalFullOnlineR2Preset`, the sanctioned entry point for this
 * preset) — see that migration's header for the full reasoning.
 *
 * Deliberately a runtime check here, NOT a `module.ts` `dependencies`
 * entry: `blog_content`'s module descriptor intentionally does not
 * declare a dependency on `news_portal` (and `news_portal` intentionally
 * does not declare one on `blog_content` either — see that module's own
 * header comment) to avoid `MODULE_REVERSE_DEPENDENCY_ACTIVE` permanently
 * blocking either module from being disabled independently. A runtime
 * query has none of that lifecycle-graph cost.
 */
import { isFullOnlineR2ModeAppliedForTenant } from "../../news-portal/application/news-portal-tenant-state";
import { evaluateNewsPortalFullOnlineR2Readiness } from "../../news-portal/domain/news-portal-preset-readiness";

/**
 * `true` only when BOTH signals agree: the deployment's env is genuinely
 * configured for the `news_portal_full_online_r2` preset AND this
 * specific tenant has a row in `awcms_mini_news_portal_tenant_state` (see
 * this file's header for why three weaker signals all failed). Fail-closed
 * on every ambiguous case (no row at all — the default, overwhelming
 * majority state).
 */
export async function isNewsPortalFullOnlineR2ModeActiveForTenant(
  tx: Bun.SQL,
  tenantId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  if (!evaluateNewsPortalFullOnlineR2Readiness(env).ready) {
    return false;
  }

  return isFullOnlineR2ModeAppliedForTenant(tx, tenantId);
}
