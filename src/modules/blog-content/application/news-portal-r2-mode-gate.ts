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
 * ## Why this does NOT check `fetchTenantModuleEntry(...).tenantEnabled` (reviewer + security-auditor finding, PR #666 review)
 *
 * `fetchTenantModuleEntry`'s `tenantEnabled` is **opt-out-by-default**
 * (its own docblock: "no `awcms_mini_tenant_modules` row means
 * `tenantEnabled: true`") — the same convention every module in this repo
 * uses. Virtually every tenant reads as `news_portal`-enabled whether or
 * not they ever applied the R2-only preset, which makes `tenantEnabled`
 * alone useless as an opt-in signal.
 *
 * An earlier version of this file tried `entry.enabledAt !== null` instead
 * (reasoning: only an explicit `enableTenantModule` call sets that column).
 * That is ALSO broken, for a subtler reason confirmed by a failing
 * integration test: `enableTenantModule` (called by
 * `applyModulePreset`/`applyNewsPortalFullOnlineR2Preset`) validates
 * against the tenant's CURRENT state first — and a fresh tenant already
 * reads as `news_portal`-enabled (the same opt-out-by-default default
 * above), so the lifecycle validation rejects the enable attempt with
 * `MODULE_ALREADY_ENABLED`, which `applyModulePreset` treats as
 * `already_satisfied` and — critically — **never writes a row at all**.
 * So a tenant that genuinely just applied the preset ALSO has
 * `enabledAt: null`, identical to a tenant that never touched it. There is
 * no way to derive "did this tenant apply the preset" from
 * `awcms_mini_tenant_modules` state, full stop — enabling an
 * already-enabled-by-default module is a no-op by design (idempotency),
 * not a distinguishable event.
 *
 * The real, working signal: `applyNewsPortalFullOnlineR2Preset`
 * (`news-portal/application/apply-news-portal-preset.ts`) persists an
 * explicit `fullOnlineR2ModeAppliedAt` timestamp into this tenant's
 * `news_portal` row in the generic per-tenant module-settings store
 * (`awcms_mini_module_settings`, via `updateModuleSettings` — the same
 * mechanism `blog_content`'s own `publicRouteMode` setting already uses)
 * on every successful application. A tenant that never ran the preset has
 * no such key in its settings at all. This is unambiguous, unlike either
 * `awcms_mini_tenant_modules` signal above.
 *
 * Deliberately a runtime check here, NOT a `module.ts` `dependencies`
 * entry: `blog_content`'s module descriptor intentionally does not
 * declare a dependency on `news_portal` (and `news_portal` intentionally
 * does not declare one on `blog_content` either — see that module's own
 * header comment) to avoid `MODULE_REVERSE_DEPENDENCY_ACTIVE` permanently
 * blocking either module from being disabled independently. A runtime
 * query has none of that lifecycle-graph cost.
 */
import { fetchModuleSettingsView } from "../../module-management/application/module-settings";
import { evaluateNewsPortalFullOnlineR2Readiness } from "../../news-portal/domain/news-portal-preset-readiness";

const NEWS_PORTAL_MODULE_KEY = "news_portal";
const FULL_ONLINE_R2_MODE_APPLIED_SETTING_KEY = "fullOnlineR2ModeAppliedAt";

/**
 * `true` only when BOTH signals agree: the deployment's env is genuinely
 * configured for the `news_portal_full_online_r2` preset AND this
 * specific tenant has genuinely applied it at least once (a
 * `fullOnlineR2ModeAppliedAt` key present in its `news_portal` module
 * settings — see this file's header for why weaker signals don't work).
 * Fail-closed on every ambiguous case (module descriptor not registered,
 * settings row missing, key absent).
 */
export async function isNewsPortalFullOnlineR2ModeActiveForTenant(
  tx: Bun.SQL,
  tenantId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  if (!evaluateNewsPortalFullOnlineR2Readiness(env).ready) {
    return false;
  }

  const settings = await fetchModuleSettingsView(
    tx,
    tenantId,
    NEWS_PORTAL_MODULE_KEY
  );

  return (
    typeof settings?.effective[FULL_ONLINE_R2_MODE_APPLIED_SETTING_KEY] ===
    "string"
  );
}
