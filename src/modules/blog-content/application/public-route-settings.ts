/**
 * Effective "public route" settings for `blog_content`'s two public route
 * families — `/news` (Issue #560) and legacy `/blog/{tenantCode}` (Issue
 * #540) — Issue #564, epic #555.
 *
 * Deliberately reads from TWO existing, already-authoritative stores
 * instead of inventing a third:
 *
 * 1. `blog_content`'s module descriptor `settings.defaults`
 *    (`module.ts`) + the tenant's `awcms_mini_module_settings` override,
 *    via Module Management's generic tenant-settings framework (Issue
 *    #516/epic #510, `fetchModuleSettingsView`). Owns the four genuinely
 *    new keys this issue introduces: `publicRouteMode`, `publicBasePath`,
 *    `legacyTenantRouteEnabled`, `publicLabel`.
 * 2. `awcms_mini_blog_settings` (Issue #537, wired up by Issue #543,
 *    `fetchBlogSettings`). Still owns `rssEnabled`/`sitemapEnabled` — they
 *    are NOT duplicated into store (1) even though the issue's own example
 *    JSON lists them alongside the four new keys. Two independent,
 *    writable stores for the identical concept would be a real
 *    single-source-of-truth bug: an admin could flip "RSS enabled" to
 *    false in the generic `/admin/modules/blog_content` settings panel
 *    while `/news/feed.xml` (`src/pages/news/feed.xml.ts`) and
 *    `/blog/{tenantCode}/feed.xml.ts` keep reading the OLD
 *    `awcms_mini_blog_settings` value and stay enabled. `rssEnabled`/
 *    `sitemapEnabled` already worked end-to-end before this issue (Issue
 *    #543 wrote them, Issue #540/#560 read them) — this module only reads
 *    them here, for route-handler convenience, never writes them through
 *    this path.
 *
 * `fetchEffectivePublicRouteSettings` merges READ access to both into one
 * DTO so `/news`/`/blog/{tenantCode}` route handlers don't need to call two
 * functions and remember which field lives where — it does not create a
 * third writable store. Every field's write path is still whichever of the
 * two stores above already owns it: `PATCH /api/v1/tenant/modules/blog_content/settings`
 * for the first four, `PATCH /api/v1/blog/settings` for the last two.
 */
import { fetchBlogSettings } from "./blog-settings-directory";
import { fetchModuleSettingsView } from "../../module-management/application/module-settings";

const BLOG_CONTENT_MODULE_KEY = "blog_content";

/**
 * `domain_default` (the module descriptor's own default value) means
 * "behave as today" — `/news` resolves the tenant per
 * `PUBLIC_TENANT_RESOLUTION_MODE` (doc 18) exactly as it did before this
 * issue. `disabled` is the one new behavior: every `/news` route collapses
 * to the same generic 404 `withNewsTenant` already produces for an
 * unresolved tenant or a disabled `blog_content` module (see
 * `public-news-tenant-resolution.ts`). Scoped to `/news` only — the legacy
 * `/blog/{tenantCode}` family has its own, independent on/off switch,
 * `legacyTenantRouteEnabled` below.
 */
export const PUBLIC_ROUTE_MODES = ["domain_default", "disabled"] as const;
export type PublicRouteMode = (typeof PUBLIC_ROUTE_MODES)[number];

export type EffectivePublicRouteSettings = {
  publicRouteMode: PublicRouteMode;
  publicBasePath: string;
  legacyTenantRouteEnabled: boolean;
  publicLabel: string;
  rssEnabled: boolean;
  sitemapEnabled: boolean;
};

const DEFAULT_PUBLIC_ROUTE_MODE: PublicRouteMode = "domain_default";
const DEFAULT_PUBLIC_BASE_PATH = "/news";
const DEFAULT_LEGACY_TENANT_ROUTE_ENABLED = true;
const DEFAULT_PUBLIC_LABEL = "News";
const MAX_PUBLIC_LABEL_LENGTH = 80;

function isPublicRouteMode(value: unknown): value is PublicRouteMode {
  return (
    typeof value === "string" &&
    (PUBLIC_ROUTE_MODES as readonly string[]).includes(value)
  );
}

/**
 * Same absolute-path shape check `scripts/validate-env.ts` applies to
 * `PUBLIC_CANONICAL_BASE_PATH` (Issue #556) — a tenant-writable value must
 * not silently corrupt every generated `/news` link with a malformed path.
 * A value that fails this check is treated as "not set" (falls back to the
 * env var, then the hardcoded default) rather than rejected at write time —
 * this function is read-side normalization, not the PATCH validator (the
 * generic module-settings framework intentionally has no per-module field
 * schema, see `module-management/domain/module-settings.ts`).
 */
function isValidBasePath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0) return false;
  if (!value.startsWith("/")) return false;
  if (/\s/.test(value)) return false;
  if (value.includes("//")) return false;
  if (value.length > 1 && value.endsWith("/")) return false;
  return true;
}

function resolveEnvFallbackBasePath(env: NodeJS.ProcessEnv): string {
  const raw = env.PUBLIC_CANONICAL_BASE_PATH;

  if (typeof raw !== "string") {
    return DEFAULT_PUBLIC_BASE_PATH;
  }

  const trimmed = raw.trim();

  return isValidBasePath(trimmed) ? trimmed : DEFAULT_PUBLIC_BASE_PATH;
}

/**
 * Reads both stores and returns one merged, defensively-normalized view.
 * Every field falls back to a safe default rather than throwing when a
 * tenant override holds a garbage-shaped value (e.g. `publicRouteMode:
 * "yolo"`) — the generic settings framework validates only "is this a
 * plain object with no secret-shaped key" (`validateModuleSettingsPatch`),
 * never per-field types, so this read path is where fail-safe
 * normalization actually happens.
 *
 * `publicBasePath` precedence: tenant override (if a valid absolute path)
 * -> `PUBLIC_CANONICAL_BASE_PATH` env (Issue #556, if set and valid) ->
 * hardcoded `/news`. Note this only changes *self-referential URLs/links*
 * `/news` route handlers generate (canonical `<link>`, RSS/sitemap
 * `<loc>`/`<link>`, internal cross-links) — it does NOT retarget which
 * Astro file route physically serves a request. `/news/**` are file-based
 * static routes (`src/pages/news/*`); Astro cannot repoint a static
 * route's own path per-tenant at runtime without a much larger, riskier
 * catch-all-route restructuring that is out of this issue's scope (see
 * `src/modules/blog-content/README.md` §Public route settings for the full
 * writeup of this decision).
 */
export async function fetchEffectivePublicRouteSettings(
  tx: Bun.SQL,
  tenantId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<EffectivePublicRouteSettings> {
  const moduleSettingsView = await fetchModuleSettingsView(
    tx,
    tenantId,
    BLOG_CONTENT_MODULE_KEY
  );
  const blogSettings = await fetchBlogSettings(tx, tenantId);

  const effective = moduleSettingsView?.effective ?? {};
  const fallbackBasePath = resolveEnvFallbackBasePath(env);

  const publicLabel =
    typeof effective.publicLabel === "string" &&
    effective.publicLabel.trim().length > 0 &&
    effective.publicLabel.length <= MAX_PUBLIC_LABEL_LENGTH
      ? effective.publicLabel
      : DEFAULT_PUBLIC_LABEL;

  return {
    publicRouteMode: isPublicRouteMode(effective.publicRouteMode)
      ? effective.publicRouteMode
      : DEFAULT_PUBLIC_ROUTE_MODE,
    publicBasePath: isValidBasePath(effective.publicBasePath)
      ? effective.publicBasePath
      : fallbackBasePath,
    legacyTenantRouteEnabled:
      typeof effective.legacyTenantRouteEnabled === "boolean"
        ? effective.legacyTenantRouteEnabled
        : DEFAULT_LEGACY_TENANT_ROUTE_ENABLED,
    publicLabel,
    rssEnabled: blogSettings.rssEnabled,
    sitemapEnabled: blogSettings.sitemapEnabled
  };
}

/**
 * Convenience wrapper for the 7 legacy `/blog/{tenantCode}/*` route files
 * (Issue #564) so each one makes a single call instead of re-deriving the
 * field name. Legacy routes deliberately do NOT get `withNewsTenant`'s
 * timing-parity treatment (`padUnresolvedTenantLatency`, etc.) — the
 * tenant code is already caller-supplied and visible in the URL path
 * itself, so there is no "does this identifier map to a real tenant"
 * existence question left to protect by response latency (unlike `/news`,
 * which resolves the tenant from an opaque `Host` header). This mirrors
 * the pre-existing, documented, out-of-scope gap that `/blog/{tenantCode}`
 * also has no `blog_content` module-disabled check at all (see this
 * module's README §Public routes `/news`, "Known pre-existing gap").
 */
export async function isLegacyTenantRouteEnabled(
  tx: Bun.SQL,
  tenantId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  const settings = await fetchEffectivePublicRouteSettings(tx, tenantId, env);

  return settings.legacyTenantRouteEnabled;
}
