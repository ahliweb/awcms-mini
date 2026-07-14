/**
 * Config accessors (doc 18) — Issue #754. Pure functions over an injected
 * `env`, same convention `email/domain/email-config.ts` already
 * established.
 */

/**
 * `INTEGRATION_HUB_ALLOW_PRIVATE_TARGETS` — the "explicit trusted
 * deployment policy" escape hatch `ssrf-guard.ts`'s header comment
 * documents. Default `false` (SSRF protection on). An operator running a
 * LAN-first deployment that legitimately wants to deliver outbound
 * webhooks to another system on the same private network sets this to
 * `"true"` — a deployment-wide, non-tenant-controlled opt-in.
 */
export function isPrivateTargetsAllowed(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.INTEGRATION_HUB_ALLOW_PRIVATE_TARGETS === "true";
}

export const INTEGRATION_HUB_OUTBOUND_DISPATCH_DEFAULT_LIMIT = 25;
export const INTEGRATION_HUB_OUTBOUND_DISPATCH_LEASE_MINUTES = 2;
