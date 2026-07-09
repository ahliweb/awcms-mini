import { defineModule } from "../_shared/module-contract";

/**
 * `tenant_domain` (Issue #558, epic #555 — online public tenant routing &
 * tenant domain management). This issue registers the **module descriptor
 * only** — the management API (#562), host-based resolver (#559), admin UI
 * (#563), and the optional Cloudflare DNS adapter (#567,
 * `infrastructure/cloudflare-dns-adapter.ts`, not wired into any route yet)
 * have since landed. The descriptor exists now so
 * the database-backed module registry (Module Management, epic #510) can
 * track this module's lifecycle/permissions/settings from day one, the
 * same "register the descriptor before the feature is fully built" order
 * every other module in this repo has followed since Issue #511.
 *
 * `type: "system"` (not `"domain"` or `"integration"`): this module
 * manages hostname/subdomain -> tenant mapping consumed by every public
 * route (the resolver in #559, and every `/news` request since #560) — it
 * is routing/platform infrastructure that all tenants share the mechanism
 * of, not a tenant-facing business feature (contrast `blog_content`, `type:
 * "domain"`). It is also not `"integration"`: that type fits a module
 * whose primary job is talking to an external provider (e.g. `email`'s
 * Mailketing adapter) — `tenant_domain` works fully with
 * `verification_method: 'manual'` and zero external providers; the
 * optional Cloudflare DNS adapter (#567,
 * `infrastructure/cloudflare-dns-adapter.ts`) is an enhancement bolted on
 * later (no route calls it yet), not this module's defining trait. `"system"` matches
 * `module_management`'s own reasoning: generic platform infrastructure
 * that other modules/tenants depend on, not a domain feature.
 */
export const tenantDomainModule = defineModule({
  key: "tenant_domain",
  name: "Tenant Domain",
  version: "0.1.0",
  status: "active",
  description:
    "Tenant domain/subdomain mapping for online-primary public routing (epic #555). Issue #557 added the `awcms_mini_tenant_domains` schema (migration 031: hostname/normalized_hostname, domain_type subdomain|custom_domain, route_mode canonical|legacy_blog, status pending_verification|active|suspended|failed, verification_method dns_txt|dns_cname|file|manual, is_primary/redirect_to_primary, tenant-scoped RLS with FORCE) and its permission catalog seed (migration 032: tenant_domain.domains.{read,create,update,delete,verify,set_primary}). Issue #558 (this descriptor) registers the module in the trusted code catalog so it syncs into `awcms_mini_modules` and its six permissions sync/report cleanly against the migration 032 seed. The public host-based tenant resolver with offline/LAN fallback (#559), the tenant domain management API (#562), the admin UI (#563), and the optional Cloudflare DNS adapter (#567) have since landed. This module never stores a DNS provider API token/credential in the database: `verification_token_hash` (migration 031) is an internal bearer-token hash, `verification_record_value` is the public DNS record value the tenant publishes (not a secret), and the Cloudflare adapter's own API token/zone id are read only from `TENANT_DOMAIN_CLOUDFLARE_*` env vars, never persisted here or in `awcms_mini_module_settings`.",
  dependencies: ["tenant_admin", "identity_access"],
  type: "system",
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1/tenant/domains"
  },
  navigation: [
    {
      labelKey: "admin.layout.nav_tenant_domains",
      path: "/admin/tenant/domains",
      order: 60,
      requiredPermission: "tenant_domain.domains.read"
    }
  ],
  permissions: [
    {
      activityCode: "domains",
      action: "read",
      description: "Read tenant domain/subdomain mappings"
    },
    {
      activityCode: "domains",
      action: "create",
      description: "Add a tenant domain/subdomain mapping"
    },
    {
      activityCode: "domains",
      action: "update",
      description: "Update a tenant domain/subdomain mapping"
    },
    {
      activityCode: "domains",
      action: "delete",
      description: "Soft delete a tenant domain/subdomain mapping"
    },
    {
      activityCode: "domains",
      action: "verify",
      description: "Verify ownership of a tenant domain/subdomain"
    },
    {
      activityCode: "domains",
      action: "set_primary",
      description: "Set a tenant domain as the active primary domain"
    }
  ],
  settings: {
    schemaVersion: 1,
    // Non-secret operational preference only (module-contract.ts's header
    // rule): the default domain verification mode is manual DNS
    // attestation, never an automatic provider. This is not a default of
    // "dns_txt"/"dns_cname" — those still require an operator/tenant to
    // publish a DNS record themselves; "manual" means no automated check
    // at all is assumed until a tenant/operator explicitly picks one of
    // the other `verification_method` values (migration 031). The
    // optional Cloudflare DNS adapter (#567,
    // `infrastructure/cloudflare-dns-adapter.ts`) is selected purely via
    // the `TENANT_DOMAIN_DNS_PROVIDER` env var (not this settings object,
    // and not wired into any route yet) — it never defaults this value
    // away from manual on its own.
    defaults: { defaultVerificationMethod: "manual" }
  }
});
