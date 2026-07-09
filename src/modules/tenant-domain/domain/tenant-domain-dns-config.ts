/**
 * Tenant domain DNS provider configuration (Issue #567, epic #555). Pure —
 * no `process.env` reads here; `scripts/validate-env.ts` and the Cloudflare
 * adapter's resolver (`../infrastructure/cloudflare-dns-adapter.ts`) both
 * pass in whatever `env` they were given, the same split
 * `email/domain/email-config.ts` already uses for its own provider
 * selection.
 *
 * `"manual"` (default, MVP) means the operator publishes DNS records
 * themselves and verifies via `POST /api/v1/tenant/domains/{id}/verify`
 * (Issue #562) exactly as today — this module makes zero outbound DNS/HTTP
 * calls in that mode, and none of the vars below are required. `"cloudflare"`
 * is the one optional adapter that can create/check DNS records for
 * platform-managed subdomains on a Cloudflare-managed zone. Choosing
 * `cloudflare` never becomes a hard dependency (epic #555 §Out of scope;
 * skill `awcms-mini-tenant-domain-routing` §Aturan lintas-issue #9) — manual
 * DNS setup must keep working whether this var is left unset or explicitly
 * set to `"manual"`.
 */
export const KNOWN_TENANT_DOMAIN_DNS_PROVIDERS = [
  "manual",
  "cloudflare"
] as const;

export type TenantDomainDnsProviderKind =
  (typeof KNOWN_TENANT_DOMAIN_DNS_PROVIDERS)[number];

export function isKnownTenantDomainDnsProvider(
  value: string | undefined
): value is TenantDomainDnsProviderKind {
  return (KNOWN_TENANT_DOMAIN_DNS_PROVIDERS as readonly string[]).includes(
    value ?? ""
  );
}

/**
 * Env var names required only when `TENANT_DOMAIN_DNS_PROVIDER=cloudflare`.
 *
 * `TENANT_DOMAIN_PLATFORM_ROOT_DOMAIN` is deliberately a *separate* variable
 * from `PUBLIC_PLATFORM_ROOT_DOMAIN` (Issue #556) even though the two will
 * often hold the same value operationally: `PUBLIC_PLATFORM_ROOT_DOMAIN`
 * gates the public host-based *resolver* (which subdomains are trusted to
 * resolve a tenant, Issue #559); this one scopes which hostnames the
 * Cloudflare adapter is allowed to create/query DNS records for (defense in
 * depth — see `validateDnsRecordInput` in the adapter file, and note that
 * this also reflects a real Cloudflare API constraint: a zone/token can only
 * manage records within its own zone). Conflating the two would let a change
 * meant for one concern silently change the other.
 */
export const TENANT_DOMAIN_CLOUDFLARE_REQUIRED_WHEN_SELECTED = [
  "TENANT_DOMAIN_PLATFORM_ROOT_DOMAIN",
  "TENANT_DOMAIN_CLOUDFLARE_ZONE_ID",
  "TENANT_DOMAIN_CLOUDFLARE_API_TOKEN"
] as const;

/**
 * Default per-call timeout for the Cloudflare adapter's `withTimeout`-bounded
 * network calls (security audit follow-up on PR #580 — this was previously
 * hardcoded in `../infrastructure/cloudflare-dns-adapter.ts` with no way to
 * tune it per-deployment). Optional — `TENANT_DOMAIN_CLOUDFLARE_TIMEOUT_MS`
 * is *not* in `TENANT_DOMAIN_CLOUDFLARE_REQUIRED_WHEN_SELECTED` above; an
 * unset or invalid value always falls back to this default, exactly the same
 * "never fail boot over an optional tuning knob" convention
 * `email/domain/email-config.ts`'s `resolveEmailSendTimeoutMs` already uses
 * for `EMAIL_SEND_TIMEOUT_MS` (not validated by `scripts/validate-env.ts`
 * either, for the same reason).
 */
export const DEFAULT_TENANT_DOMAIN_CLOUDFLARE_TIMEOUT_MS = 8_000;

export function resolveTenantDomainCloudflareTimeoutMs(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = Number(env.TENANT_DOMAIN_CLOUDFLARE_TIMEOUT_MS);

  return Number.isFinite(raw) && raw > 0
    ? raw
    : DEFAULT_TENANT_DOMAIN_CLOUDFLARE_TIMEOUT_MS;
}
