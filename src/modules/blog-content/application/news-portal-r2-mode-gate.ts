/**
 * Tenant-scoped "is full-online R2-only news media mode actually active
 * right now" gate (Issue #636, epic `news_portal`).
 *
 * `evaluateNewsPortalFullOnlineR2Readiness` (`news-portal/domain/
 * news-portal-preset-readiness.ts`, Issue #632) answers a purely
 * env-based/global question: "COULD this deployment run the
 * `news_portal_full_online_r2` preset." It takes no `tenantId` at all — a
 * deployment can have every env var correct while a SPECIFIC tenant has
 * never actually enabled the `news_portal` module (or has disabled it
 * again since). Issue #636's validation (require R2 media references for
 * blog post/page images) must be conditional on the mode being active FOR
 * THE TENANT MAKING THE REQUEST, not merely "this deployment could run
 * it" — otherwise a tenant that never opted into the preset would suddenly
 * have its plain-URL featured images/gallery blocks rejected the moment
 * ANY tenant on the same deployment turns on `NEWS_MEDIA_R2_ENABLED`.
 *
 * This file composes the two independent signals `blog_content` needs:
 * the existing global env check, AND a tenant-scoped module-enabled
 * check via `fetchTenantModuleEntry` — the exact same primitive
 * `public-news-tenant-resolution.ts`'s `checkBlogContentAndRouteGate`
 * already uses for `blog_content` itself, applied here to the
 * `news_portal` module key instead.
 *
 * Deliberately a runtime check here, NOT a `module.ts` `dependencies`
 * entry: `blog_content`'s module descriptor intentionally does not
 * declare a dependency on `news_portal` (and `news_portal` intentionally
 * does not declare one on `blog_content` either — see that module's own
 * header comment) to avoid `MODULE_REVERSE_DEPENDENCY_ACTIVE` permanently
 * blocking either module from being disabled independently. A runtime
 * query has none of that lifecycle-graph cost.
 */
import { fetchTenantModuleEntry } from "../../module-management/application/tenant-module-lifecycle";
import { evaluateNewsPortalFullOnlineR2Readiness } from "../../news-portal/domain/news-portal-preset-readiness";

const NEWS_PORTAL_MODULE_KEY = "news_portal";

/**
 * `true` only when BOTH signals agree: the deployment's env is genuinely
 * configured for the `news_portal_full_online_r2` preset AND this
 * specific tenant currently has the `news_portal` module enabled.
 * Fail-closed on every ambiguous case (missing tenant-module row, module
 * descriptor not registered) — same convention
 * `checkBlogContentAndRouteGate` already established for `blog_content`.
 */
export async function isNewsPortalFullOnlineR2ModeActiveForTenant(
  tx: Bun.SQL,
  tenantId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  if (!evaluateNewsPortalFullOnlineR2Readiness(env).ready) {
    return false;
  }

  const entry = await fetchTenantModuleEntry(
    tx,
    tenantId,
    NEWS_PORTAL_MODULE_KEY
  );

  return entry?.tenantEnabled ?? false;
}
