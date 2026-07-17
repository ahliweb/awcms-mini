import { assertUuid } from "../database/tenant-context";
import { log } from "../logging/logger";
import {
  getOrLoadDefaultTenantFromEnv,
  getOrLoadDefaultTenantFromSetupState,
  getOrLoadTenantByHost
} from "./public-tenant-cache";
import {
  resolvePublicTenantByCode,
  type PublicTenantResolution
} from "./public-tenant-resolver";

/**
 * Public host-based tenant resolution — Issue #559 (epic #555, online
 * public tenant routing). Resolves the tenant for anonymous public routes
 * (`/news`, Issue #560) from the request `Host`/domain/subdomain first,
 * then falls back safely to the same env/setup defaults offline/LAN
 * deployments already rely on for `/blog/{tenantCode}` (ADR-0009). This
 * module never touches tenant content — only `awcms_mini_tenant_domains`
 * (via the `SECURITY DEFINER` bootstrap function, migration 033),
 * `awcms_mini_tenants` (RLS-free by design, ADR-0003/migration 013), and
 * `awcms_mini_setup_state` (RLS-free singleton, migration 006).
 *
 * Every exported function here returns `null` for *any* non-resolving
 * case — unknown host, unmapped domain, non-`active` domain status
 * (`pending_verification`/`suspended`/`failed`), soft-deleted domain, or
 * an inactive tenant. Callers must treat `null` as a single generic "no
 * tenant" outcome (404), exactly like `resolvePublicTenantByCode` (ADR-0009)
 * — never branch on *why* resolution failed. The only function that ever
 * throws is `normalizePublicHost()`, and only for a genuinely-empty input
 * (a caller contract violation, not a runtime resolution outcome); a
 * non-empty but malformed host still returns `null`, never throws.
 *
 * **`tenant_code_legacy` mode is a fifth, standalone `null` case, decided in
 * Issue #560**: `resolvePublicTenantFromRequest()` returns `null`
 * unconditionally for this mode, without even attempting the env/setup
 * fallback chain — see that function's own docblock and
 * `PublicHostResolverConfig.mode`'s docblock for the full reasoning (this
 * was an open ambiguity two Issue #559 reviewers flagged, resolved here
 * rather than inherited silently into `/news`).
 */

export type { PublicTenantResolution };

type TenantDomainLookupRow = {
  tenant_id: string;
  domain_status: string;
  is_primary: boolean;
  route_mode: string;
  tenant_status: string;
  tenant_code: string;
  tenant_name: string;
  default_locale: string;
};

type TenantRow = {
  id: string;
  tenant_code: string;
  tenant_name: string;
  status: string;
  default_locale: string;
};

type SetupStateRow = {
  tenant_id: string | null;
};

/** The four modes documented for `PUBLIC_TENANT_RESOLUTION_MODE` (Issue #556). */
export type PublicTenantResolutionMode =
  "host_default" | "env_default" | "setup_default" | "tenant_code_legacy";

export type PublicHostResolverConfig = {
  /**
   * `PUBLIC_TENANT_RESOLUTION_MODE` (Issue #556). Only `"host_default"`
   * enables step 1 (host/domain lookup) below — every other value,
   * including `undefined` (not set at all, today's offline/LAN default)
   * and any unrecognized string, skips straight to the env/setup fallback
   * chain (steps 2-4). This keeps the `awcms_mini_tenant_domains` bootstrap
   * function entirely unreached by deployments that never opted into
   * online/host-based routing — smaller attack surface, not just smaller
   * code path, for the common offline/LAN case.
   *
   * The env/setup fallback chain (steps 2-4) always runs regardless of
   * mode — that is the "safe fallback" the issue title names, and matches
   * the acceptance criterion that an unset/other mode still tries
   * `PUBLIC_DEFAULT_TENANT_ID` -> `PUBLIC_DEFAULT_TENANT_CODE` ->
   * `awcms_mini_setup_state.tenant_id` before giving up.
   *
   * **Explicit exception, decided in Issue #560** (flagged as an unresolved
   * ambiguity by two Issue #559 reviewers, resolved here rather than
   * inherited silently): `mode === "tenant_code_legacy"` skips the *entire*
   * chain, steps 1-4 alike, and resolution always returns `null`. This mode
   * means "no default tenant guess — every route must carry an explicit
   * `tenantCode` in its own path", which is exactly what
   * `/blog/{tenantCode}` (ADR-0009) does and what `/news` (Issue #560,
   * epic #555) structurally cannot: `/news` has no `tenantCode` path
   * segment at all. Resolving *any* tenant for a `/news` request under this
   * mode would silently defeat the operator's explicit choice to disable
   * default-tenant guessing. This is the ONE case where `mode` gates more
   * than step 1 — `undefined` (not set at all, today's offline/LAN
   * default) is deliberately NOT folded into this case and keeps running
   * the full safe-fallback chain, because an operator who never touched
   * `PUBLIC_TENANT_RESOLUTION_MODE` has not made any explicit "no default
   * tenant" choice.
   */
  mode?: string;
  /**
   * `PUBLIC_TRUST_PROXY` (Issue #556), default `false`. Only when `true`
   * is `X-Forwarded-Host` read at all; otherwise the plain `Host` header is
   * always used, matching the epic's binding security note ("never trust
   * X-Forwarded-Host without a trusted proxy in front").
   */
  trustProxy?: boolean;
};

export type PublicHostResolverDeps = {
  resolvePublicTenantByHost: typeof resolvePublicTenantByHost;
  resolveDefaultPublicTenantFromEnv: typeof resolveDefaultPublicTenantFromEnv;
  resolveDefaultPublicTenantFromSetupState: typeof resolveDefaultPublicTenantFromSetupState;
};

const MAX_HOST_LENGTH = 253; // RFC 1035 total hostname length limit.
const MAX_LABEL_LENGTH = 63; // RFC 1035 per-label length limit.
const HOST_LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Shared DNS-hostname shape check (length + per-label charset), used by
 * `normalizePublicHost()` (after it strips the port) and, as defense in
 * depth, directly inside `resolvePublicTenantByHost()` — that function is
 * exported and documented as directly callable (Issue #560 and beyond), so
 * it must not rely solely on "the caller already normalized this" as its
 * only guard. Does not strip a port or lowercase — the input is expected to
 * already be normalized; this only re-validates shape.
 */
function isValidHostnameShape(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > MAX_HOST_LENGTH ||
    value.startsWith(".") ||
    value.endsWith(".") ||
    value.includes("..") ||
    value.includes("_") ||
    /\s/.test(value)
  ) {
    return false;
  }

  return value
    .split(".")
    .every(
      (label) =>
        label.length > 0 &&
        label.length <= MAX_LABEL_LENGTH &&
        HOST_LABEL_PATTERN.test(label)
    );
}

/**
 * Normalizes an untrusted `Host`/`X-Forwarded-Host` value for use as a
 * lookup key: strips a trailing `:<port>`, lowercases, trims, and validates
 * DNS hostname shape. Returns `null` for anything that doesn't look like a
 * plausible hostname (defense in depth — the DB lookup this feeds is
 * already parameterized, this is an additional reject-early gate against
 * obviously-malformed/oversized/injected input before it ever reaches a
 * query). IPv6 literals (`[::1]`) are rejected: tenant domain mappings are
 * always by hostname, never by IP literal.
 *
 * Throws only when `rawHost` itself is empty/not a string — that is a
 * caller contract violation (e.g. calling this directly with `""`), not a
 * runtime resolution outcome, so it is intentionally distinguishable from
 * every other "not a valid/known host" case, which returns `null`.
 * `resolvePublicTenantFromRequest()` never calls this with an empty string
 * — a request with no `Host` header just skips step 1 entirely.
 */
export function normalizePublicHost(rawHost: string): string | null {
  if (typeof rawHost !== "string" || rawHost.trim().length === 0) {
    throw new Error("normalizePublicHost: rawHost must be a non-empty string.");
  }

  const trimmed = rawHost.trim().toLowerCase();

  if (/\s/.test(trimmed)) {
    return null;
  }

  if (trimmed.startsWith("[")) {
    // IPv6 literal, e.g. "[::1]:4321" — not a supported tenant domain shape.
    return null;
  }

  const colonIndex = trimmed.lastIndexOf(":");
  const hostOnly = colonIndex === -1 ? trimmed : trimmed.slice(0, colonIndex);

  return isValidHostnameShape(hostOnly) ? hostOnly : null;
}

/**
 * Fetches an `active` tenant by id from `awcms_mini_tenants` — RLS-free by
 * design (ADR-0003/migration 013, same as `resolvePublicTenantByCode`'s
 * own table access), so this runs directly on the app-role connection,
 * before any `withTenant(...)` transaction. Not exported: every exported
 * resolution step in this file needs "look up a tenant by id and confirm
 * it's active", so it is centralized here rather than duplicated per step.
 */
async function fetchActivePublicTenantById(
  sql: Bun.SQL,
  tenantId: string
): Promise<PublicTenantResolution | null> {
  const rows = (await sql`
    SELECT id, tenant_code, tenant_name, status, default_locale
    FROM awcms_mini_tenants
    WHERE id = ${tenantId}
  `) as TenantRow[];

  const tenant = rows[0];

  if (!tenant || tenant.status !== "active") {
    return null;
  }

  return {
    tenantId: tenant.id,
    tenantCode: tenant.tenant_code,
    tenantName: tenant.tenant_name,
    defaultLocale: tenant.default_locale
  };
}

/**
 * Step 1 of the resolution order: hostname -> tenant, via the narrow
 * `SECURITY DEFINER` bootstrap function `awcms_mini_resolve_tenant_domain_lookup`
 * (migration 033). `normalizedHost` must already be normalized by
 * `normalizePublicHost()` — this function re-validates hostname *shape* as
 * defense in depth (it is exported and directly callable, e.g. by Issue
 * #560, not only reachable through `normalizePublicHost()`), but does not
 * re-strip a port or re-lowercase; callers must still normalize first.
 *
 * Exactly one query runs for every outcome (unknown host, non-`active`
 * domain, or non-`active` tenant) — the SQL function joins
 * `awcms_mini_tenants` in the same call and returns the tenant's own
 * status/code/name/locale alongside the domain row, specifically so this
 * function never needs a second, conditional round trip. An earlier
 * version issued a second query only when a domain row was found active,
 * which was a timing side-channel distinguishing "no such mapping" from
 * "mapping exists, tenant just isn't active" by response latency alone
 * (fixed in the same change, see migration 033's own comment for the full
 * writeup).
 *
 * Only `domain_status === 'active' AND tenant_status === 'active'`
 * resolves; every other combination — `pending_verification`/`suspended`/
 * `failed` domain, soft-deleted domain (already excluded by the SQL
 * function itself), or a non-`active` tenant — falls through to `null`
 * identically. `is_primary` and `route_mode` are read but not part of the
 * return value: they are not needed for base resolution (`route_mode` is
 * Issue #560's concern), and keeping the public resolver's read surface
 * minimal is a binding security note on this issue.
 */
export async function resolvePublicTenantByHost(
  sql: Bun.SQL,
  normalizedHost: string
): Promise<PublicTenantResolution | null> {
  if (
    typeof normalizedHost !== "string" ||
    !isValidHostnameShape(normalizedHost)
  ) {
    return null;
  }

  const rows = (await sql`
    SELECT
      tenant_id, domain_status, is_primary, route_mode,
      tenant_status, tenant_code, tenant_name, default_locale
    FROM awcms_mini_resolve_tenant_domain_lookup(${normalizedHost})
  `) as TenantDomainLookupRow[];

  const row = rows[0];

  if (
    !row ||
    row.domain_status !== "active" ||
    row.tenant_status !== "active"
  ) {
    return null;
  }

  return {
    tenantId: row.tenant_id,
    tenantCode: row.tenant_code,
    tenantName: row.tenant_name,
    defaultLocale: row.default_locale
  };
}

/**
 * Steps 2-3 of the resolution order: `PUBLIC_DEFAULT_TENANT_ID` first, then
 * `PUBLIC_DEFAULT_TENANT_CODE` (exact order from the issue). A malformed
 * `PUBLIC_DEFAULT_TENANT_ID` (not a UUID) is treated as "this step did not
 * resolve" and falls through to the CODE check, rather than throwing —
 * config validation (Issue #556's `checkPublicRoutingConfig`) is the place
 * that should catch operator misconfiguration; this runtime path never
 * surfaces a parse error to a public caller.
 */
export async function resolveDefaultPublicTenantFromEnv(
  sql: Bun.SQL,
  env: NodeJS.ProcessEnv = process.env
): Promise<PublicTenantResolution | null> {
  const tenantId = env.PUBLIC_DEFAULT_TENANT_ID?.trim();

  if (tenantId) {
    try {
      assertUuid(tenantId);
      const resolved = await fetchActivePublicTenantById(sql, tenantId);

      if (resolved) {
        return resolved;
      }
    } catch {
      // Malformed PUBLIC_DEFAULT_TENANT_ID — fall through to the CODE
      // check below, never throw out of a public resolution path.
    }
  }

  const tenantCode = env.PUBLIC_DEFAULT_TENANT_CODE?.trim();

  if (tenantCode) {
    return resolvePublicTenantByCode(sql, tenantCode);
  }

  return null;
}

/**
 * Step 4 of the resolution order: `awcms_mini_setup_state.tenant_id` — the
 * tenant chosen during the setup wizard. `awcms_mini_setup_state` is a
 * RLS-free singleton table (migration 006), same "shared by design"
 * category as `awcms_mini_tenants` (migration 013's comment), so this also
 * runs directly on the app-role connection with no tenant context needed.
 */
export async function resolveDefaultPublicTenantFromSetupState(
  sql: Bun.SQL
): Promise<PublicTenantResolution | null> {
  const rows = (await sql`
    SELECT tenant_id
    FROM awcms_mini_setup_state
    WHERE id = true
  `) as SetupStateRow[];

  const tenantId = rows[0]?.tenant_id;

  if (!tenantId) {
    return null;
  }

  return fetchActivePublicTenantById(sql, tenantId);
}

/**
 * Cached wrappers (Issue #832, epic #818) — see `public-tenant-cache.ts`
 * for the binding key/staleness rules.
 *
 * These are deliberately SEPARATE functions rather than caching inside
 * `resolvePublicTenantByHost`/`resolveDefaultPublicTenantFrom*` themselves.
 * Those three are exported and directly callable, and both test suites use
 * them that way to assert *database* behavior — the integration suite's
 * "exactly one query for every outcome" timing-side-channel test
 * (`public-tenant-resolution.integration.test.ts`) counts real queries, and
 * would silently start passing for the wrong reason (zero queries, because
 * cached) if the cache lived inside them. Keeping the uncached functions
 * pure preserves those tests as real proofs, and `defaultDeps` — already
 * the established injection seam for this module — is where production
 * picks up the cached path. A caller that injects its own `deps` (unit
 * tests) therefore never touches the cache, which also keeps a
 * process-lived cache from leaking state between test cases.
 */
async function resolvePublicTenantByHostCached(
  sql: Bun.SQL,
  normalizedHost: string
): Promise<PublicTenantResolution | null> {
  return getOrLoadTenantByHost(normalizedHost, () =>
    resolvePublicTenantByHost(sql, normalizedHost)
  );
}

/**
 * Each wrapper stays strictly 1:1 with the function it caches, and each has
 * its own cache slot. Folding steps 2-4 into a single "chain" wrapper was
 * tried and rejected: `resolvePublicTenantFromRequest` calls the step-4 dep
 * whenever the step-2/3 dep returns null, so a chain wrapper that already
 * consulted setup state internally would make every no-default-tenant
 * deployment run the setup-state query a second time, uncached, on every
 * request — slower than the code it replaced. Keeping the wrappers 1:1
 * means the caching is invisible to `resolvePublicTenantFromRequest`'s
 * control flow: warm, each of steps 2-4 costs zero queries on its own.
 */
async function resolveDefaultPublicTenantFromEnvCached(
  sql: Bun.SQL
): Promise<PublicTenantResolution | null> {
  // Intentionally does not forward the underlying function's optional `env`
  // parameter: only `resolvePublicTenantFromRequest` reaches this wrapper,
  // and it always relies on the `process.env` default. A caller that needs
  // an explicit env object calls `resolveDefaultPublicTenantFromEnv`
  // directly (as the integration suite does), bypassing the cache — correct,
  // since env cannot change without a process restart anyway.
  return getOrLoadDefaultTenantFromEnv(() =>
    resolveDefaultPublicTenantFromEnv(sql)
  );
}

async function resolveDefaultPublicTenantFromSetupStateCached(
  sql: Bun.SQL
): Promise<PublicTenantResolution | null> {
  return getOrLoadDefaultTenantFromSetupState(() =>
    resolveDefaultPublicTenantFromSetupState(sql)
  );
}

const defaultDeps: PublicHostResolverDeps = {
  resolvePublicTenantByHost: resolvePublicTenantByHostCached,
  resolveDefaultPublicTenantFromEnv: resolveDefaultPublicTenantFromEnvCached,
  resolveDefaultPublicTenantFromSetupState:
    resolveDefaultPublicTenantFromSetupStateCached
};

/**
 * Extracts the host to resolve from a `Request`. Reads the plain `Host`
 * header by default; only reads `X-Forwarded-Host` when `trustProxy` is
 * `true` (Issue #556's `PUBLIC_TRUST_PROXY`, default `false`) — an
 * untrusted client can set `X-Forwarded-Host` to anything, so it must never
 * be read unless a trusted reverse proxy in front is guaranteed to
 * sanitize/overwrite it.
 *
 * **Binding operational requirement** (documented in
 * `.claude/skills/awcms-mini-tenant-domain-routing/SKILL.md` and
 * `docs/awcms-mini/18_configuration_env_reference.md` — repeated here so
 * the code and the docs cannot silently drift): a deployment that sets
 * `PUBLIC_TRUST_PROXY=true` MUST run behind a single, directly-adjacent
 * trusted edge proxy that fully OVERWRITES `X-Forwarded-Host` on every
 * request, never appends to (or forwards) a client-supplied value. This
 * repo's documented topology never legitimately produces more than one
 * `X-Forwarded-Host` value. If the header nonetheless contains more than
 * one comma-separated value at runtime, that is treated as a sign of a
 * misconfigured proxy chain (e.g. one that appends instead of overwrites,
 * which would let a client pre-seed an entry an attacker fully controls)
 * or a spoofing attempt — this function does NOT guess which of several
 * values is trustworthy (there is no "rightmost N trusted hops" config in
 * this codebase to anchor that logic on). It logs the anomaly and falls
 * back to the plain `Host` header instead, exactly as if `trustProxy` were
 * `false` for this one request.
 *
 * Exported (Issue #832) so `src/middleware.ts` can resolve the host string
 * synchronously, while the request object is still alive, and hand the
 * plain string to `resolvePublicTenantFromRequest`'s `Request | string`
 * overload from inside a deferred telemetry task. It must be exported
 * rather than reimplemented there: a second copy of the trust-proxy /
 * multi-value `X-Forwarded-Host` decision is exactly the kind of security
 * logic that drifts from its original and reintroduces a spoofing hole.
 */
export function extractPublicHostHeader(
  request: Request,
  trustProxy: boolean
): string | null {
  if (trustProxy) {
    const forwarded = request.headers.get("x-forwarded-host");

    if (forwarded && forwarded.trim().length > 0) {
      const parts = forwarded
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);

      if (parts.length === 1) {
        return parts[0] as string;
      }

      if (parts.length > 1) {
        log("warning", "public_host_resolver.x_forwarded_host_multi_value", {
          valueCount: parts.length,
          // Not a secret, but capped defensively — this is an anomaly
          // report, not a place to let an attacker-sized header balloon
          // log storage.
          firstValuePreview: parts[0]?.slice(0, 100)
        });
      }
    }
  }

  return request.headers.get("host");
}

/**
 * Orchestrates the full resolution order for a public request:
 *
 * 0. `config.mode === "tenant_code_legacy"` — short-circuits to `null`
 *    immediately, before any of steps 1-4 run. **Decided in Issue #560**
 *    (this was an explicit open ambiguity flagged by two Issue #559
 *    reviewers — see `PublicHostResolverConfig.mode`'s docblock for the
 *    full reasoning): this mode means the operator explicitly opted OUT of
 *    any default-tenant guess, so a route with no `tenantCode` path segment
 *    (`/news`) must never resolve a tenant under it, not even via the
 *    env/setup fallback.
 * 1. Host/domain mapping (`resolvePublicTenantByHost`) — only attempted
 *    when `config.mode === "host_default"`.
 * 2. `PUBLIC_DEFAULT_TENANT_ID`
 * 3. `PUBLIC_DEFAULT_TENANT_CODE`
 *    (2-3 are both handled inside `resolveDefaultPublicTenantFromEnv`)
 * 4. `awcms_mini_setup_state.tenant_id`
 * 5. `null` (caller responds with a generic 404)
 *
 * Steps 2-4 always run for every mode EXCEPT `tenant_code_legacy` (step 0
 * above) — they are the "safe fallback" this issue's title promises, so an
 * offline/LAN deployment that never sets `PUBLIC_TENANT_RESOLUTION_MODE`
 * (`config.mode === undefined`) still gets a usable default tenant for
 * routes that don't carry an explicit `tenantCode` (`/news`, Issue #560).
 * `undefined` is deliberately NOT treated the same as explicit
 * `tenant_code_legacy` — only an operator who has actually set that value
 * has made the "no default tenant" choice this step 0 enforces.
 *
 * `requestOrHost` accepts either a `Request` (host header extracted per
 * `config.trustProxy`) or an already-known host string (bypasses header
 * extraction entirely — used by callers that resolved the host some other
 * way, and by tests). `deps` allows the three DB-touching steps to be
 * swapped for test doubles without a database (see
 * `tests/unit/public-host-tenant-resolver.test.ts`); production callers
 * should omit it and use the real implementations.
 */
export async function resolvePublicTenantFromRequest(
  sql: Bun.SQL,
  requestOrHost: Request | string,
  config: PublicHostResolverConfig = {},
  deps: PublicHostResolverDeps = defaultDeps
): Promise<PublicTenantResolution | null> {
  if (config.mode === "tenant_code_legacy") {
    return null;
  }

  const trustProxy = config.trustProxy ?? false;

  if (config.mode === "host_default") {
    const rawHost =
      typeof requestOrHost === "string"
        ? requestOrHost
        : extractPublicHostHeader(requestOrHost, trustProxy);

    if (rawHost && rawHost.trim().length > 0) {
      const normalizedHost = normalizePublicHost(rawHost);

      if (normalizedHost) {
        const byHost = await deps.resolvePublicTenantByHost(
          sql,
          normalizedHost
        );

        if (byHost) {
          return byHost;
        }
      }
    }
  }

  const byEnv = await deps.resolveDefaultPublicTenantFromEnv(sql);

  if (byEnv) {
    return byEnv;
  }

  const bySetupState = await deps.resolveDefaultPublicTenantFromSetupState(sql);

  if (bySetupState) {
    return bySetupState;
  }

  return null;
}
