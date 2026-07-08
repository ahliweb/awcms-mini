import { withTenant } from "../../../lib/database/tenant-context";
import {
  resolvePublicTenantFromRequest,
  type PublicHostResolverConfig,
  type PublicTenantResolution
} from "../../../lib/tenant/public-host-tenant-resolver";
import { fetchTenantModuleEntries } from "../../module-management/application/tenant-module-lifecycle";

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
 * distinction between "tenant not found/inactive" and "tenant found but
 * blog_content disabled" — both must produce the exact same generic `null`
 * (which every caller maps to the same 404 response), per the epic's
 * binding security note (never expose *why* a public route 404s).
 */
export type NewsTenantHandler<T> = (
  tx: Bun.TransactionSQL,
  tenant: PublicTenantResolution
) => Promise<T>;

const BLOG_CONTENT_MODULE_KEY = "blog_content";

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
 * opens a tenant-scoped transaction (`withTenant`) and confirms
 * `blog_content` is enabled before invoking `handler`. Returns `null` for
 * every non-resolving case — unknown/inactive tenant, unknown/unmapped
 * host, `tenant_code_legacy` mode (Issue #560's decision, see
 * `public-host-tenant-resolver.ts`), or `blog_content` disabled for the
 * resolved tenant — so every route can map `null` straight to its own
 * generic 404 response without ever branching on which case occurred.
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
    return null;
  }

  return withTenant(sql, tenant.tenantId, async (tx) => {
    const moduleEntries = await fetchTenantModuleEntries(tx, tenant.tenantId);
    const blogContentEntry = moduleEntries.find(
      (entry) => entry.moduleKey === BLOG_CONTENT_MODULE_KEY
    );

    // Fail-closed: a missing entry (module descriptor not registered, in
    // practice unreachable since blog_content is always in listModules())
    // is treated as disabled, not enabled by omission.
    if (!blogContentEntry?.tenantEnabled) {
      return null;
    }

    return handler(tx, tenant);
  });
}
