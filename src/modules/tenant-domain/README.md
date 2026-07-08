# Tenant Domain

Epic #555 (online public tenant routing, `/news` routes, and tenant domain
management). This module (`key: tenant_domain`) owns hostname/subdomain ->
tenant mapping so public routes can resolve a tenant without a `tenantCode`
in the path. See `.claude/skills/awcms-mini-tenant-domain-routing/SKILL.md`
for the full cross-issue context (config, schema, and everything still
outstanding across the epic).

## Scope per issue

Issue #556: `PUBLIC_*` env config (`scripts/validate-env.ts`'s
`checkPublicRoutingConfig`) — resolution mode, default tenant, platform
root domain, canonical base path, trust-proxy flag. Lives outside this
module (config, not a module descriptor).

Issue #557: the `awcms_mini_tenant_domains` schema (see §Tables) and its
permission catalog seed (see §Permission seed).

Issue #558 (this module — `module.ts`): registers `tenant_domain` in the
trusted code module catalog (`src/modules/index.ts`) so it syncs into
`awcms_mini_modules` via `bun run modules:sync`, and declares the six
permissions from migration 032 so Module Management's permission
sync/status report has something to compare the database seed against.
**No API, no admin UI, no resolver, no DNS adapter** — see §Not yet
available below.

## Tables (migration `031_awcms_mini_tenant_domain_schema.sql`, Issue #557)

`awcms_mini_tenant_domains` — one row per hostname/subdomain mapped to a
tenant. Key columns: `hostname` (raw) + `normalized_hostname` (lowercase +
trimmed, kept in sync by a CHECK constraint); `domain_type`
(`subdomain | custom_domain`); `route_mode` (`canonical` -> future `/news`
routes, Issue #560 | `legacy_blog` -> existing `/blog/{tenantCode}` routes,
ADR-0009 — column exists, not consumed by any resolver yet); `status`
(`pending_verification | active | suspended | failed`; soft delete via
`deleted_at` is a separate, fifth "does not resolve traffic" state);
`verification_method` (`dns_txt | dns_cname | file | manual`, nullable);
`verification_token_hash` (sha256 hex, `sha256:`-prefixed, same
construction as `lib/auth/password-reset-token.ts`'s `hashResetToken` —
raw token never persisted); `verification_record_name` /
`verification_record_value` (public DNS record values the tenant
publishes, never a secret); `is_primary` + `redirect_to_primary`.

Constraints: `awcms_mini_tenant_domains_normalized_hostname_dedup`
(globally unique across tenants, `WHERE deleted_at IS NULL` — one hostname
belongs to exactly one tenant); `awcms_mini_tenant_domains_primary_dedup`
(at most one active primary domain per tenant). Standard soft delete
(`deleted_at`/`deleted_by`/`delete_reason`) frees a `normalized_hostname`
for reuse.

RLS: `ENABLE` + `FORCE` with the standard `tenant_isolation` policy — same
as every other tenant-scoped table. This created a documented bootstrap
gap for the host-based resolver (#559): resolving `hostname -> tenant_id`
has to happen _before_ a tenant context exists, but FORCE RLS plus the
fail-closed GUC default (migration 013) means an un-tenant-scoped query
returns zero rows. `awcms_mini_tenants` solves the equivalent bootstrap
problem for `tenantCode -> tenant_id` lookups by being deliberately
RLS-free (migration 013); `tenant_domains` cannot use that same trick
because it holds tenant-manageable fields (`verification_token_hash`
etc.). Issue #559 closed this gap with a narrowly-scoped `SECURITY
DEFINER` function, `awcms_mini_resolve_tenant_domain_lookup` (migration
`033_awcms_mini_tenant_domain_lookup_function.sql`) — see
`.claude/skills/awcms-mini-tenant-domain-routing/SKILL.md` §Resolver for
the full mechanism/security writeup. `FORCE ROW LEVEL SECURITY` was **not**
dropped from this table to build it.

## Permission seed (migration `032_awcms_mini_tenant_domain_permissions.sql`, Issue #557)

Six permissions, `module_key = 'tenant_domain'`, `activity_code =
'domains'`: `read`, `create`, `update`, `delete`, `verify`, `set_primary`.
`module.ts`'s `permissions` array mirrors these six entries
(`activityCode`/`action`/`description`) exactly so Module Management's
permission sync/status report (`fetchModulePermissionSyncReport`, used by
the generic `admin/modules/[moduleKey].astro` detail page) shows no
`missing`/`mismatched_description`/`orphaned` entries for this module. No
role/access assignment uses these permissions yet — that depends on the
admin UI (#563) or manual assignment via the existing Access & Users
screens once the API (#562) exists to authorize against them.

## `module.ts`'s own descriptor

`type: "system"` — this module manages routing infrastructure shared by
every tenant's public traffic (hostname -> tenant resolution), not a
tenant-facing business feature (contrast `blog_content`, `type:
"domain"`), and it is not defined by talking to an external provider
(contrast `email`, `type` implicitly integration-shaped via its Mailketing
adapter) — `tenant_domain` is fully functional with `verification_method:
'manual'` and zero external providers; the optional Cloudflare DNS adapter
(#567) is a later, optional enhancement, not this module's defining trait.
Same reasoning `module_management` used for its own `type: "system"`.

`dependencies: ["tenant_admin", "identity_access"]` per the issue.
`isCore` is **not** set (unlike `module_management`) — nothing about this
module is required for the platform to function; a tenant that only ever
uses `/blog/{tenantCode}` legacy routing never needs a domain mapping at
all.

`api.basePath: "/api/v1/tenant/domains"` and `navigation.path:
"/admin/tenant/domains"` are declared now even though neither the API
(#562) nor the admin UI (#563) exist yet, per this issue's own explicit
descriptor requirements. Two consequences worth knowing about until those
issues land:

- Module Management's readiness check (`openApiDocumentedSignal`,
  `application/health-registry.ts`) will report this module's
  `openapi_documented` signal as `fail` until #562 adds real
  `/api/v1/tenant/domains` paths to the OpenAPI document — this is
  expected, not a regression.
- The navigation entry only ever appears in the admin sidebar for a
  caller holding `tenant_domain.domains.read`, and (per §Permission seed)
  no role has that permission yet. If an operator manually grants it via
  Access & Users before #563 ships, the link will 404 — a known,
  low-probability gap accepted for this issue rather than withholding the
  descriptor requirement the issue asked for.

`settings.defaults: { defaultVerificationMethod: "manual" }` — the only
non-secret operational preference this module currently declares
(`settings.schemaVersion: 1`). It intentionally does **not** default to
`dns_txt`/`dns_cname`/any automated provider mode; those still require an
operator/tenant to explicitly opt in per domain. No field here is, or
ever will be, a runtime secret/token/credential — a hard rule from
`module-contract.ts`'s header comment, checked by
`tests/modules/tenant-domain-module.test.ts`.

## Resolver (`src/lib/tenant/public-host-tenant-resolver.ts`, Issue #559)

Public host-based tenant resolution with offline/LAN-safe fallback.
**Library only** — not yet consumed by any route/endpoint (that is #560's
`/news` routes). Five functions: `normalizePublicHost` (strip port,
lowercase, validate DNS hostname shape — throws only on an empty input,
never on a merely-malformed one), `resolvePublicTenantByHost` (queries
`awcms_mini_resolve_tenant_domain_lookup`, the migration-033 `SECURITY
DEFINER` bootstrap function, then confirms the tenant itself is `active`),
`resolveDefaultPublicTenantFromEnv` (`PUBLIC_DEFAULT_TENANT_ID` then
`PUBLIC_DEFAULT_TENANT_CODE`), `resolveDefaultPublicTenantFromSetupState`
(`awcms_mini_setup_state.tenant_id`, also RLS-free by design), and the
orchestrator `resolvePublicTenantFromRequest`. Resolution order: host
lookup (only when `PUBLIC_TENANT_RESOLUTION_MODE=host_default`) -> env ID
-> env CODE -> setup state -> `null`. The env/setup fallback chain always
runs regardless of mode — every non-`host_default` mode (including unset,
today's offline/LAN default) skips straight to it, so the
`awcms_mini_tenant_domains` bootstrap function is never even reached by a
deployment that hasn't opted into online routing. Every failure path —
unknown host, non-`active` domain status, soft-deleted domain, inactive
tenant — returns the same `null`, never a distinguishable error. Full
mechanism/security writeup (including why the `SECURITY DEFINER` function
is safe, verified empirically, not assumed) is in
`.claude/skills/awcms-mini-tenant-domain-routing/SKILL.md` §Resolver.
Tests: `tests/unit/public-host-tenant-resolver.test.ts` (pure, mocked
deps) and `tests/integration/public-tenant-resolution.integration.test.ts`
(real Postgres, including RLS/bypass proof).

## Not yet available

- Tenant domain management API, `/api/v1/tenant/domains` (Issue #562).
- Admin UI, `/admin/tenant/domains` (Issue #563).
- `/news` public routes for `blog_content` (Issue #560) and the tenant
  setting that chooses between `/news` and legacy `/blog/{tenantCode}`
  (Issue #564).
- Optional Cloudflare DNS adapter (Issue #567) — explicitly out of scope
  for the whole epic as a hard dependency; manual DNS setup by the
  operator must keep working without it.

No `jobs` or `health` are declared on this module's descriptor yet — both
fields exist on `ModuleDescriptor` but, consistent with
`module_management`'s own README ("a descriptor should only claim a
capability once the corresponding feature is real, not in advance"),
there is no scheduled command or health check to describe until a later
issue adds one.
