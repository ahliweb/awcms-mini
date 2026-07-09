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
**Consumed by `/news` (Issue #560)** since that issue landed — via
`withNewsTenant()` (`src/modules/blog-content/application/public-news-tenant-resolution.ts`).
Five functions: `normalizePublicHost` (strip port, lowercase, validate DNS
hostname shape — throws only on an empty input, never on a
merely-malformed one), `resolvePublicTenantByHost` (queries
`awcms_mini_resolve_tenant_domain_lookup`, the migration-033 `SECURITY
DEFINER` bootstrap function, then confirms the tenant itself is `active`),
`resolveDefaultPublicTenantFromEnv` (`PUBLIC_DEFAULT_TENANT_ID` then
`PUBLIC_DEFAULT_TENANT_CODE`), `resolveDefaultPublicTenantFromSetupState`
(`awcms_mini_setup_state.tenant_id`, also RLS-free by design), and the
orchestrator `resolvePublicTenantFromRequest`. Resolution order:
`config.mode === "tenant_code_legacy"` short-circuits straight to `null`
(no fallback at all — decided in Issue #560, see below) -> otherwise host
lookup (only when `PUBLIC_TENANT_RESOLUTION_MODE=host_default`) -> env ID
-> env CODE -> setup state -> `null`. The env/setup fallback chain runs
for every mode except `tenant_code_legacy` — every other mode (including
unset, today's offline/LAN default) skips straight to it, so the
`awcms_mini_tenant_domains` bootstrap function is never even reached by a
deployment that hasn't opted into online routing. Every failure path —
unknown host, non-`active` domain status, soft-deleted domain, inactive
tenant, `tenant_code_legacy` mode — returns the same `null`, never a
distinguishable error. Full mechanism/security writeup (including why the
`SECURITY DEFINER` function is safe, verified empirically, not assumed,
and the full `tenant_code_legacy` decision writeup) is in
`.claude/skills/awcms-mini-tenant-domain-routing/SKILL.md` §Resolver.
Tests: `tests/unit/public-host-tenant-resolver.test.ts` (pure, mocked
deps) and `tests/integration/public-tenant-resolution.integration.test.ts`
(real Postgres, including RLS/bypass proof).

## `/news` public routes (Issue #560)

`src/pages/news/` (in the `blog_content` module, not this one) now
consumes the resolver above — see
`src/modules/blog-content/README.md` §Public routes `/news` and
`.claude/skills/awcms-mini-tenant-domain-routing/SKILL.md` §Rute publik
`/news` for the full writeup. This module (`tenant_domain`) is unchanged by
that issue — it still only owns the `awcms_mini_tenant_domains` schema,
the `SECURITY DEFINER` lookup function, and this descriptor.

## Tenant domain management API (`/api/v1/tenant/domains`, Issue #562)

Authenticated, tenant-scoped, audited CRUD + lifecycle actions over
`awcms_mini_tenant_domains` — the first application code that ever writes
rows to this table (the resolver, #559, only ever reads them). No admin UI
(#563) and no Cloudflare DNS provider calls (#567) — API only, exactly the
issue's own scope.

```txt
GET    /api/v1/tenant/domains              list, keyset-paginated
POST   /api/v1/tenant/domains              create
GET    /api/v1/tenant/domains/{id}         read one
PATCH  /api/v1/tenant/domains/{id}         partial update
DELETE /api/v1/tenant/domains/{id}         soft delete
POST   /api/v1/tenant/domains/{id}/verify        manual-first verify
POST   /api/v1/tenant/domains/{id}/set-primary   atomic primary swap
```

Files: `domain/tenant-domain-validation.ts` (pure input validation),
`application/tenant-domain-directory.ts` (DB access — every query runs
inside the caller's `withTenant` transaction, **never** the migration-033
`SECURITY DEFINER` bootstrap function, per the epic's binding rule that
#562's admin API and #559's anonymous public resolver never share a data
access path — skill `awcms-mini-tenant-domain-routing` §Aturan lintas-issue
#10), and `src/pages/api/v1/tenant/domains/**` (routes — thin orchestration
only, same shape as `blog_content`'s `src/pages/api/v1/blog/posts/**`).

**Auth/ABAC**: every route calls `authorizeInTransaction` with
`moduleKey: "tenant_domain"`, `activityCode: "domains"`, and one of
`read`/`create`/`update`/`delete`/`verify`/`set_primary` — the exact six
permissions migration 032 seeded. `verify` and `set_primary` did not exist
in `identity-access/domain/access-control.ts`'s `AccessAction` union before
this issue; both were added here (not added to `HIGH_RISK_ACTIONS` — see
that file's own docblock and `identity-access/README.md`'s "Vocabulary
`AccessAction` diperluas" section for the full reasoning, same
`retry`/`sync`/`enable`/`disable`/`check`/`publish` precedent). RLS `FORCE`d
on the table (migration 031) is defense in depth underneath every explicit
`tenant_id` filter in `tenant-domain-directory.ts` — a cross-tenant id is
invisible before the route can even distinguish it from "doesn't exist",
which is what makes `GET/PATCH/DELETE/verify/set-primary .../{id}` return
an identical generic 404 for an unknown id, a soft-deleted id, and another
tenant's id alike.

**Hostname validation** does not invent a second hostname-shape opinion: it
reuses `lib/tenant/public-host-tenant-resolver.ts`'s `normalizePublicHost()`
(Issue #559) directly — the same lowercase/trim/RFC-1035-shape check the
public resolver applies to an inbound `Host` header. A hostname containing
a port (`example.com:8443`) is rejected outright before normalization would
silently strip it, keeping `hostname`/`normalized_hostname` in sync with
migration 031's CHECK constraint. `hostname` is immutable after create (no
field for it in `UpdateTenantDomainInput`) — re-pointing a hostname to a
different tenant means delete-then-recreate, not an in-place rename.

**Duplicate hostname handling**: `awcms_mini_tenant_domains_normalized_hostname_dedup`
(migration 031) is a **global**, not per-tenant, unique index — one
hostname belongs to exactly one tenant. `POST /api/v1/tenant/domains`
catches that constraint violation and always returns a generic
`409 HOSTNAME_CONFLICT`, regardless of whether the colliding row belongs to
the caller's own tenant or a different one — Issue #562 §Security notes
binding rule: never leak whether a hostname belongs to another tenant. The
route never queries `awcms_mini_tenant_domains` across tenants to decide
which message to show; it only inspects the driver error message for the
constraint name.

**`verify`** (manual-first, Issue #562 §Security notes — no outbound
DNS/HTTP call in this issue): flips `status` from
`pending_verification`/`failed` to `active` purely from fields already on
the row (`verification_method` must be set; nothing else is checked — the
tenant/operator's claim is trusted). Verifying an already-`active` domain
is an idempotent no-op (returns the current row, not an error) — same
`from === to` transition-allowed convention `blog_content`'s
`isValidStatusTransition` already established. `suspended` domains refuse
verification (an explicit pause, not something an attestation should
silently override). Requires `Idempotency-Key`
(`modules/_shared/idempotency.ts`, scope `tenant_domain_verify`) — same
replay/conflict semantics as `POST /api/v1/blog/posts/{id}/publish`.

**`set-primary`** is atomic: `withTenant` already opens one
`sql.begin(...)` transaction per request, and `setPrimaryTenantDomain`
performs two UPDATEs against that same transaction in a fixed order — unset
any previous primary FIRST, set the new primary SECOND — so
`awcms_mini_tenant_domains_primary_dedup` (migration 031's partial unique
index, one active primary per tenant) is never violated mid-transaction.
Only a verified (`active`) domain can become primary. Also requires
`Idempotency-Key` (scope `tenant_domain_set_primary`).

**Never exposed in any response**: `verification_token_hash` — an internal
bearer-token hash (migration 031) — is never selected by
`tenant-domain-directory.ts`'s queries at all, let alone returned; nothing
in this issue writes it either (no verification-token-generation endpoint
exists yet). There is still no DNS provider secret column on this table
(Issue #567's concern, out of scope here) — the API surface adds none.

**Audit**: every mutation (`create`/`update`/`delete`/`verify`/
`set_primary`) writes exactly one `recordAuditEvent` call inside the same
transaction, action literal `tenant_domain.domain.<verb>` (`created`/
`updated`/`deleted`/`verified`/`set_primary`) — the
`tenant_domain.<resource>.<verb>` convention documented in skill
`awcms-mini-tenant-domain-routing`'s §Aturan lintas-issue #8, mirroring
`blog.<resource>.<verb>` from `blog_content`. `delete` uses
`severity: "warning"` with `attributes: { reason }`; the rest use
`severity: "info"`.

**Pagination**: `GET /api/v1/tenant/domains` uses the same opaque
`(created_at, id) DESC` keyset cursor shape as `GET /api/v1/email/messages`
(`modules/_shared/keyset-pagination.ts`) — `?cursor=` from a previous page's
`nextCursor`, bounded to 100 rows per page
(`TENANT_DOMAIN_LIST_LIMIT`), no `OFFSET`.

Test: `tests/integration/tenant-domain-api.integration.test.ts` — every
acceptance criterion above (CRUD, cross-tenant RLS/generic-404, duplicate
hostname 409, soft-delete-only, verify idempotency + status gating,
set-primary atomicity + idempotency, no `verification_token_hash` in any
response).

## Cloudflare DNS adapter (`infrastructure/cloudflare-dns-adapter.ts`, Issue #567)

Optional enhancement, **not a hard dependency** — manual domain management
(`POST /api/v1/tenant/domains/{id}/verify`, Issue #562) remains the MVP
default and keeps working with zero Cloudflare configuration. Nothing in
this repo calls this adapter yet: no route wires it into `.../verify` or a
"provision platform subdomain" flow (that is left for a future issue). This
issue only adds the provider boundary itself — config, adapter, and tests —
so that future work has a ready-made, security-reviewed integration point
instead of inventing one under time pressure.

### Config (`domain/tenant-domain-dns-config.ts`, `scripts/validate-env.ts`'s `checkTenantDomainDnsConfig`)

Five env vars, all optional/backward-compatible:

- `TENANT_DOMAIN_DNS_PROVIDER` — `manual` (default) | `cloudflare`. Left
  unset, `config:validate` passes exactly as before this issue.
- `TENANT_DOMAIN_PLATFORM_ROOT_DOMAIN` — required only when
  `TENANT_DOMAIN_DNS_PROVIDER=cloudflare`. **Deliberately a separate
  variable from `PUBLIC_PLATFORM_ROOT_DOMAIN`** (Issue #556) even though the
  two will often hold the same value operationally:
  `PUBLIC_PLATFORM_ROOT_DOMAIN` gates the public host-based _resolver_
  (which subdomains are trusted to resolve a tenant, Issue #559); this one
  scopes which hostnames the Cloudflare adapter is allowed to create/query
  DNS records for. Conflating the two would let a change meant for one
  concern silently change the other.
- `TENANT_DOMAIN_CLOUDFLARE_ZONE_ID` — required only when selected. Not a
  secret in the traditional sense, but still never rendered anywhere and
  redacted out of any adapter error text as defense in depth (see below).
- `TENANT_DOMAIN_CLOUDFLARE_API_TOKEN` — required only when selected. A
  real secret, read from env/secret manager only — **never** stored in
  `awcms_mini_tenant_domains`, `awcms_mini_module_settings`, or any other
  DB table, and never returned in any API response or rendered in any admin
  UI (binding rule, Issue #567 §Security notes; also epic #555's own §Aturan
  lintas-issue #7).
- `TENANT_DOMAIN_CLOUDFLARE_TIMEOUT_MS` — always optional, even when
  `cloudflare` is selected. Per-call timeout (ms) for the adapter's
  `withTimeout`-bounded network calls; unset or invalid always falls back to
  the safe default (8s) rather than failing boot — not in
  `TENANT_DOMAIN_CLOUDFLARE_REQUIRED_WHEN_SELECTED`, and not checked by
  `checkTenantDomainDnsConfig` for the same reason `EMAIL_SEND_TIMEOUT_MS`
  isn't checked either (security audit follow-up on PR #580 — this value
  used to be hardcoded with no way to tune it per-deployment).

### Adapter (`infrastructure/cloudflare-dns-adapter.ts`)

Port `TenantDomainDnsProvider` with two methods, both timeout-bounded
(`withTimeout`, default 8s — tunable via `TENANT_DOMAIN_CLOUDFLARE_TIMEOUT_MS`,
resolved by `resolveTenantDomainCloudflareTimeoutMs`
(`domain/tenant-domain-dns-config.ts`) the same way
`email/domain/email-config.ts`'s `resolveEmailSendTimeoutMs` resolves
`EMAIL_SEND_TIMEOUT_MS`: unset/invalid always falls back to the default,
never fails boot; security audit follow-up on PR #580, previously
hardcoded) and gated by a shared circuit breaker
(`getProviderCircuitBreaker("tenant-domain-cloudflare-dns")`) — the same
pattern `email/infrastructure/mailketing-provider.ts` and
`sync-storage/infrastructure/object-storage-uploader.ts` already use, and
meant to be called **outside** any DB transaction (ADR-0006):

- `createVerificationRecord({ recordType: "TXT" | "CNAME", recordName, recordValue })`
  — creates a DNS record on the configured zone. **Idempotent by
  construction**: it first lists existing records with the same
  type/name/content and returns `{ ok: true, alreadyExists: true }` without
  a second write if a match already exists, rather than depending on a
  specific Cloudflare duplicate-record error code.
- `checkVerificationStatus({ recordType, recordName, expectedValue })` —
  lists records at that name/type and reports whether one matches
  `expectedValue` (`{ ok: true, verified: boolean }`). CNAME comparison
  normalizes a trailing dot and case before matching.

**Input validation (binding, "no arbitrary DNS record creation from
user-controlled input")**: `validateDnsRecordInput()` (exported, pure)
rejects any `recordName` that is not `TENANT_DOMAIN_PLATFORM_ROOT_DOMAIN`
itself or a subdomain of it — before any network call is attempted. This
mirrors a real Cloudflare API constraint (one zone id/token can only manage
records within its own zone), not an arbitrary restriction. Record-name
shape validation is a **dedicated** check
(`isValidDnsRecordNameShape`), not a reuse of
`lib/tenant/public-host-tenant-resolver.ts`'s `normalizePublicHost()` (Issue
#559): DNS verification record names conventionally use an
underscore-prefixed label (e.g. `_acme-challenge.example.com`,
`_awcms-verify.tenant1.platform.example`) that a `Host`-header shape check
rightly rejects but every DNS verification flow needs to allow.
`normalizePublicHost()` is still reused, unchanged, for the CNAME _target
value_ (a real "points-to" hostname, not a record label) — that one keeps
the strict shape. `recordValue` is further bounded (no `\r`/`\n`, TXT
content ≤ 2048 chars — Cloudflare's own limit).

**Error redaction (binding, "no token, zone ID internals, or stack
trace")**: a provider HTTP error never surfaces Cloudflare's own
`errors[].message` text — only the numeric `errors[].code` values (safe,
non-identifying) are included. Any thrown-error text (network failure,
timeout) is also passed through `redact()`, which strips the configured
`apiToken`/`zoneId` values out of it as defense in depth (e.g. a network
error whose message happens to embed the request URL, which itself embeds
the zone id) before truncation to 300 characters.

`resolveTenantDomainDnsProvider(env)` is the production resolver (mirrors
`email/infrastructure/email-provider-resolver.ts`'s `resolveEmailProvider`
and `sync-storage/infrastructure/object-storage-uploader.ts`'s
`resolveObjectUploader`): builds the real Cloudflare provider when fully
configured, or a safe stub that returns a clear `{ ok: false }` result —
never throws — for `manual` mode, an unknown provider value, or a
`cloudflare` selection missing any of the three required vars. `bun run
config:validate` is what should already have caught a misconfigured
deployment at boot; this resolver is a second, defensive layer.

Test: `tests/unit/cloudflare-dns-adapter.test.ts` — pure `validateDnsRecordInput`
cases, and, against a local fake HTTP server (`Bun.serve`, same technique as
`tests/object-storage-uploader.test.ts`): success (create + idempotent
re-create), provider error (redaction proven against a server that
deliberately echoes the token/zone id in its error `message`, which the
adapter must never forward), timeout, circuit-breaker trip, and
`resolveTenantDomainDnsProvider`'s missing/invalid/unknown-env behavior.
`tests/validate-env.test.ts`'s `describe("checkTenantDomainDnsConfig", ...)`
covers the env-gating rules above.

## Not yet available

- Admin UI, `/admin/tenant/domains` (Issue #563) is done, but it never
  edits Cloudflare provider credentials — that stays env/secret-manager-only
  by design (out of scope for the whole epic, Issue #567 §Out of scope).
- Wiring `cloudflare-dns-adapter.ts` into
  `POST /api/v1/tenant/domains/{id}/verify` or a "provision platform
  subdomain" endpoint — Issue #567 added the provider boundary only, no
  route calls it yet.

No `jobs` or `health` are declared on this module's descriptor yet — both
fields exist on `ModuleDescriptor` but, consistent with
`module_management`'s own README ("a descriptor should only claim a
capability once the corresponding feature is real, not in advance"),
there is no scheduled command or health check to describe until a later
issue adds one.
