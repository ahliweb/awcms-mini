/**
 * Full-online-only auth security feature gate (Issue #587, epic: full-online
 * auth hardening — #588 Cloudflare Turnstile, #589 MFA/TOTP, #590 Google
 * OIDC login, #591 generic tenant OIDC SSO, #592 admin policy UI). Pure — no
 * `process.env` reads here; `scripts/validate-env.ts` and
 * `scripts/security-readiness.ts` both pass in whatever `env` they were
 * given, the same split `email/domain/email-config.ts` and
 * `tenant-domain/domain/tenant-domain-dns-config.ts` already use for their
 * own conditional provider config.
 *
 * This is the SHARED gate every full-online auth hardening feature in this
 * epic must check before doing anything online/provider-related —
 * `isFullOnlineSecurityActive(env)` is the one function every one of those
 * features (and their tests) should call, rather than re-deriving the "both
 * the enable flag AND the profile must agree" rule themselves. Local/
 * offline/LAN deployments (the default — this pair of env vars is entirely
 * unset) always get `false` here and never depend on this gate for
 * anything: no Cloudflare/Google/OIDC call, no MFA challenge, no changed
 * login behavior.
 *
 * Deliberately an auth-specific gate, not a reuse of `APP_ENV=production` or
 * the deployment-profile concept — offline/LAN deployments can be
 * production-grade operationally without ever wanting these online-only
 * hardening features (see `docs/awcms-mini/deployment-profiles.md`).
 */
export const KNOWN_ONLINE_SECURITY_PROFILES = [
  "disabled",
  "full_online"
] as const;

export type OnlineSecurityProfile =
  (typeof KNOWN_ONLINE_SECURITY_PROFILES)[number];

export function isKnownOnlineSecurityProfile(
  value: string | undefined
): value is OnlineSecurityProfile {
  return (KNOWN_ONLINE_SECURITY_PROFILES as readonly string[]).includes(
    value ?? ""
  );
}

export function isOnlineSecurityEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.AUTH_ONLINE_SECURITY_ENABLED === "true";
}

/** Falls back to `"disabled"` for unset or unrecognized values — never throws. */
export function resolveOnlineSecurityProfile(
  env: NodeJS.ProcessEnv = process.env
): OnlineSecurityProfile {
  const raw = env.AUTH_ONLINE_SECURITY_PROFILE;

  return isKnownOnlineSecurityProfile(raw) ? raw : "disabled";
}

/**
 * The single boolean every full-online-only feature (#588-#592) gates on.
 * True only when BOTH the enable flag is `"true"` AND the profile is
 * exactly `"full_online"` — matches `checkOnlineAuthSecurityConfig`
 * (`scripts/validate-env.ts`)'s own rule that `AUTH_ONLINE_SECURITY_ENABLED=true`
 * requires `AUTH_ONLINE_SECURITY_PROFILE=full_online`, so any deployment
 * that has passed `bun run config:validate` will always have this agree
 * with `isOnlineSecurityEnabled` alone. Checking both here (rather than
 * trusting `config:validate` already ran) keeps this gate fail-closed even
 * if a deployment somehow skipped that step.
 */
export function isFullOnlineSecurityActive(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return (
    isOnlineSecurityEnabled(env) &&
    resolveOnlineSecurityProfile(env) === "full_online"
  );
}
