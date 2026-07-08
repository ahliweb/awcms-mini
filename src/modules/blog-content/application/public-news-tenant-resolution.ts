import { withTenant } from "../../../lib/database/tenant-context";
import {
  resolvePublicTenantFromRequest,
  type PublicHostResolverConfig,
  type PublicTenantResolution
} from "../../../lib/tenant/public-host-tenant-resolver";
import { fetchTenantModuleEntries } from "../../module-management/application/tenant-module-lifecycle";
import {
  fetchEffectivePublicRouteSettings,
  type EffectivePublicRouteSettings
} from "./public-route-settings";

/**
 * Tenant resolution + module-enablement gate shared by all seven `/news`
 * routes (Issue #560, epic #555). Every `/news` route needs the exact same
 * two-step gate before it may query a single blog post row:
 *
 * 1. Resolve the tenant from the request via `resolvePublicTenantFromRequest`
 *    (Issue #559) — never `resolvePublicTenantByCode` (ADR-0009's
 *    `tenantCode`-in-path resolver), since `/news` carries no `tenantCode`
 *    path segment at all.
 * 2. Confirm `blog_content` is enabled for that tenant
 *    (`fetchTenantModuleEntries`, Module Management's existing tenant
 *    lifecycle service) — an explicit acceptance criterion of Issue #560
 *    that does not exist yet for the legacy `/blog/{tenantCode}` routes
 *    (a pre-existing gap this issue documents but deliberately does not
 *    retrofit — out of this issue's scope).
 *
 * Centralizing both steps here (rather than repeating them across seven
 * route files) means there is exactly one place that can leak the
 * distinction between "tenant not found/inactive", "tenant found but
 * blog_content disabled", and (since Issue #564) "tenant found but
 * publicRouteMode=disabled" — all three must produce the exact same
 * generic `null` (which every caller maps to the same 404 response), per
 * the epic's binding security note (never expose *why* a public route
 * 404s). Since Issue #562, that identical response is also
 * cost-normalized: see `padUnresolvedTenantLatency` below for the timing
 * side-channel fix that keeps these outcomes indistinguishable by response
 * latency, not just by response body.
 */
export type NewsTenantHandler<T> = (
  tx: Bun.TransactionSQL,
  tenant: PublicTenantResolution,
  routeSettings: EffectivePublicRouteSettings
) => Promise<T>;

const BLOG_CONTENT_MODULE_KEY = "blog_content";

/**
 * Timing side-channel fix (skill `awcms-mini-tenant-domain-routing` §Belum
 * ada — Follow-up keamanan, item 1, flagged non-blocking during Issue #560
 * review and required to close before Issue #562's API can populate
 * `awcms_mini_tenant_domains` with real mappings in production). Before this
 * fix, `withNewsTenant` had three outcomes with different latency: tenant
 * not resolved (fastest — no DB transaction at all), tenant resolved but
 * `blog_content` disabled (medium — opens `withTenant` + one
 * `fetchTenantModuleEntries` query), tenant resolved and enabled (slowest —
 * adds the actual content query). The first two both produce the exact same
 * generic 404, so a prober varying the `Host` header could learn "this
 * hostname maps to a real, active tenant" purely from response latency,
 * without the response body ever differing — the same class of leak
 * migration 033's fix closed for the host-lookup step itself (see that
 * migration's comment for the precedent this mirrors).
 *
 * This all-zero UUID is the same fail-closed sentinel `app.current_tenant_id`
 * defaults to when no tenant context is set (migration 013) — no real
 * tenant is ever created with this id (`awcms_mini_tenants.id` always comes
 * from `gen_random_uuid()`), so a query scoped to it is guaranteed to match
 * zero rows and never touches another tenant's data. It exists purely as a
 * round-trip-shape placeholder.
 */
const TIMING_PAD_TENANT_ID = "00000000-0000-0000-0000-000000000000";

/**
 * The module-enabled check plus (since Issue #564) the effective public
 * route settings fetch, factored out of `withNewsTenant` so
 * `padUnresolvedTenantLatency` can call the exact same function instead of
 * hand-duplicating its query sequence — the two can never drift apart,
 * which matters because a drift here is exactly the kind of thing that
 * would silently reopen the timing side-channel this file exists to close.
 * Runs unconditionally (module disabled or not, route mode disabled or
 * not) so every outcome that collapses to the same generic 404 —
 * module-disabled, route-mode-disabled, or (via `padUnresolvedTenantLatency`)
 * tenant-not-resolved — pays the identical round-trip shape.
 */
async function checkBlogContentAndRouteGate(
  tx: Bun.TransactionSQL,
  tenantId: string,
  env: NodeJS.ProcessEnv
): Promise<{
  blogContentEnabled: boolean;
  routeSettings: EffectivePublicRouteSettings;
}> {
  const moduleEntries = await fetchTenantModuleEntries(tx, tenantId);
  const blogContentEntry = moduleEntries.find(
    (entry) => entry.moduleKey === BLOG_CONTENT_MODULE_KEY
  );
  const routeSettings = await fetchEffectivePublicRouteSettings(
    tx,
    tenantId,
    env
  );

  return {
    // Fail-closed: a missing entry (module descriptor not registered, in
    // practice unreachable since blog_content is always in listModules())
    // is treated as disabled, not enabled by omission.
    blogContentEnabled: blogContentEntry?.tenantEnabled ?? false,
    routeSettings
  };
}

/**
 * Pads the "tenant did not resolve" path (including `tenant_code_legacy`
 * mode, which returns `null` from `resolvePublicTenantFromRequest` without
 * touching the DB at all) with the same round-trip *shape* the "tenant
 * resolved but module disabled or route mode disabled" path already pays
 * for real via `checkBlogContentAndRouteGate` — open a transaction, `SET
 * LOCAL` a tenant GUC, run that exact same check — so every outcome that
 * produces an identical generic 404 also costs the same number of DB round
 * trips. Uses the exact same `withTenant` helper every real tenant-scoped
 * query in this codebase uses, not a lighter/raw query, so pool
 * acquisition and circuit-breaker behavior are identical too, not just the
 * query count.
 *
 * Trade-off, documented rather than hidden: every `/news` request that
 * fails to resolve a tenant now depends on DB availability for this padding
 * query, even under `PUBLIC_TENANT_RESOLUTION_MODE=tenant_code_legacy`
 * (previously a guaranteed zero-DB-touch path). Every other mode already
 * depends on the DB for the resolver's own env/setup fallback chain
 * (`resolvePublicTenantFromRequest`'s steps 2-4 run unconditionally except
 * under `tenant_code_legacy`), so this only changes behavior for
 * deployments that explicitly opted into `tenant_code_legacy` — an
 * acceptable, deliberate cost for closing an otherwise-observable
 * side-channel on a route (`/news`) those deployments have chosen to never
 * resolve anyway.
 *
 * Exported (not just used internally) so
 * `tests/integration/blog-content-public-news.integration.test.ts` can
 * prove its round-trip cost directly matches
 * `checkBlogContentAndRouteGate`'s real cost, independent of
 * `resolvePublicTenantFromRequest`'s own — separately variable, pre-existing,
 * out-of-scope-for-this-fix — resolution cost (that resolver already has its
 * own timing-parity guarantee from migration 033/#559 for the one step this
 * fix does not touch). Scoping the proof to exactly what this fix changes
 * keeps the test meaningful instead of chasing full end-to-end round-trip
 * equality across every `PUBLIC_TENANT_RESOLUTION_MODE`/env/setup-state
 * permutation, which is not this fix's target.
 */
export async function padUnresolvedTenantLatency(
  sql: Bun.SQL,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  await withTenant(sql, TIMING_PAD_TENANT_ID, async (tx) => {
    await checkBlogContentAndRouteGate(tx, TIMING_PAD_TENANT_ID, env);
  });
}

/**
 * Builds `PublicHostResolverConfig` from the two env vars Issue #556
 * documents (`PUBLIC_TENANT_RESOLUTION_MODE`/`PUBLIC_TRUST_PROXY`) —
 * `resolvePublicTenantFromRequest` itself deliberately never reads
 * `process.env` (Issue #559, for testability), so every caller building a
 * config from the real environment does it the same way here instead of
 * re-deriving this mapping per route file.
 */
export function buildPublicHostResolverConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): PublicHostResolverConfig {
  return {
    mode: env.PUBLIC_TENANT_RESOLUTION_MODE,
    trustProxy: env.PUBLIC_TRUST_PROXY === "true"
  };
}

/**
 * Resolves the public tenant for a `/news` request and, only if resolved,
 * opens a tenant-scoped transaction (`withTenant`) and confirms both
 * `blog_content` is enabled AND the tenant's effective `publicRouteMode`
 * (Issue #564) is not `"disabled"` before invoking `handler`. Returns
 * `null` for every non-resolving case — unknown/inactive tenant,
 * unknown/unmapped host, `tenant_code_legacy` mode (Issue #560's decision,
 * see `public-host-tenant-resolver.ts`), `blog_content` disabled, or
 * `publicRouteMode=disabled` for the resolved tenant — so every route can
 * map `null` straight to its own generic 404 response without ever
 * branching on which case occurred. On success, `handler` also receives
 * the tenant's effective public route settings (`publicBasePath`,
 * `publicLabel`, `rssEnabled`, `sitemapEnabled`) so routes don't need a
 * second lookup for self-referential link generation.
 */
export async function withNewsTenant<T>(
  sql: Bun.SQL,
  request: Request,
  handler: NewsTenantHandler<T>,
  env: NodeJS.ProcessEnv = process.env
): Promise<T | null> {
  const config = buildPublicHostResolverConfigFromEnv(env);
  const tenant = await resolvePublicTenantFromRequest(sql, request, config);

  if (!tenant) {
    // Timing side-channel fix — see `padUnresolvedTenantLatency`'s own
    // docblock. Deliberately awaited and its result discarded: this call
    // exists only to pay the same round-trip cost the gate branch below
    // already pays, never to produce a value.
    await padUnresolvedTenantLatency(sql, env);
    return null;
  }

  return withTenant(sql, tenant.tenantId, async (tx) => {
    const { blogContentEnabled, routeSettings } =
      await checkBlogContentAndRouteGate(tx, tenant.tenantId, env);

    if (!blogContentEnabled || routeSettings.publicRouteMode === "disabled") {
      return null;
    }

    return handler(tx, tenant, routeSettings);
  });
}
