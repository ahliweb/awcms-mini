/**
 * Full-online auth security status summary (Issue #592, epic: full-online
 * auth hardening #587-#593) — a single pure, env-derived read that the
 * `/admin/security` SSR page (Issue #592) uses to render the epic's five
 * gates (#587 shared gate, #588 Turnstile, #589 MFA, #590 Google login,
 * #591 generic SSO) at a glance.
 *
 * No DB/network I/O here — mirrors every other feature's own `*-config.ts`
 * gate module in this epic (`online-security-config.ts`, `mfa-config.ts`,
 * `google-oidc-config.ts`, `sso-config.ts`, `../security/turnstile.ts`),
 * just recombined into one summary. This deliberately avoids adding a new
 * API endpoint purely to expose deployment-wide status booleans that are
 * not tenant-scoped data — the admin page calls this directly from its own
 * frontmatter, same convention `admin/settings.astro` uses to call
 * `fetchTenantSettings` directly instead of round-tripping through its own
 * HTTP API.
 *
 * `configured` never exposes a credential's VALUE, only whether the
 * env var(s) a feature needs are present (issue's own security note:
 * "Avoid leaking whether a provider credential exists beyond safe status
 * flags such as `configured: true`") — every list of required var NAMES is
 * imported from the feature's own config module (`TURNSTILE_REQUIRED_WHEN_ENABLED`,
 * `AUTH_MFA_REQUIRED_WHEN_ENABLED`, `GOOGLE_OIDC_REQUIRED_WHEN_ENABLED`,
 * `SSO_REQUIRED_WHEN_ENABLED`) rather than re-listing var names here, so
 * this file can never drift from `scripts/validate-env.ts`'s own
 * requirements.
 */
import {
  isFullOnlineSecurityActive,
  isOnlineSecurityEnabled,
  resolveOnlineSecurityProfile,
  type OnlineSecurityProfile
} from "./online-security-config";
import {
  isTurnstileEnabled,
  TURNSTILE_REQUIRED_WHEN_ENABLED
} from "../security/turnstile";
import { isMfaEnabled, AUTH_MFA_REQUIRED_WHEN_ENABLED } from "./mfa-config";
import {
  isGoogleLoginEnabled,
  GOOGLE_OIDC_REQUIRED_WHEN_ENABLED
} from "./google-oidc-config";
import { isSsoEnabled, SSO_REQUIRED_WHEN_ENABLED } from "./sso-config";

function allEnvVarsPresent(
  names: readonly string[],
  env: NodeJS.ProcessEnv
): boolean {
  return names.every((name) => Boolean(env[name]?.trim()));
}

export type AuthSecurityFeatureStatus = {
  /** This feature's own flag (e.g. `TURNSTILE_ENABLED`) is `"true"`. Does NOT by itself mean the feature is actually active — see `AuthSecurityStatusSummary.gateActive`, which every feature also requires. */
  enabled: boolean;
  /** Every env var this feature requires when enabled is present (non-empty) — never reflects the var's actual value. */
  configured: boolean;
};

export type AuthSecurityStatusSummary = {
  gateEnabled: boolean;
  gateProfile: OnlineSecurityProfile;
  /** The single boolean every feature below is gated by in addition to its own `enabled` flag — `isFullOnlineSecurityActive(env)`, Issue #587. */
  gateActive: boolean;
  turnstile: AuthSecurityFeatureStatus;
  mfa: AuthSecurityFeatureStatus;
  googleLogin: AuthSecurityFeatureStatus;
  sso: AuthSecurityFeatureStatus;
};

export function resolveAuthSecurityStatusSummary(
  env: NodeJS.ProcessEnv = process.env
): AuthSecurityStatusSummary {
  return {
    gateEnabled: isOnlineSecurityEnabled(env),
    gateProfile: resolveOnlineSecurityProfile(env),
    gateActive: isFullOnlineSecurityActive(env),
    turnstile: {
      enabled: isTurnstileEnabled(env),
      configured: allEnvVarsPresent(TURNSTILE_REQUIRED_WHEN_ENABLED, env)
    },
    mfa: {
      enabled: isMfaEnabled(env),
      configured: allEnvVarsPresent(AUTH_MFA_REQUIRED_WHEN_ENABLED, env)
    },
    googleLogin: {
      enabled: isGoogleLoginEnabled(env),
      configured: allEnvVarsPresent(GOOGLE_OIDC_REQUIRED_WHEN_ENABLED, env)
    },
    sso: {
      enabled: isSsoEnabled(env),
      configured: allEnvVarsPresent(SSO_REQUIRED_WHEN_ENABLED, env)
    }
  };
}
