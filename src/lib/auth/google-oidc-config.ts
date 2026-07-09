/**
 * Google OIDC login config gate (Issue #590, epic: full-online auth
 * hardening). Mirrors `../security/turnstile.ts`'s `isTurnstileRequired`
 * and `./mfa-config.ts`'s `isMfaRequired` shape exactly — `isGoogleLoginRequired`
 * is the ONE function every Google-login endpoint and `login.astro` checks;
 * local/offline/LAN deployments never read these env vars, never call
 * Google, never render the button.
 */
import { isFullOnlineSecurityActive } from "./online-security-config";

const DEFAULT_REDIRECT_PATH = "/api/v1/auth/providers/google/callback";

/** Google's own, fixed OIDC endpoints — this issue is Google-specific (a generic OIDC provider is Issue #591), so these are hardcoded constants, not discovered via `.well-known/openid-configuration` at runtime (one fewer external call and failure mode per login attempt). */
export const GOOGLE_OIDC_ENDPOINTS = {
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
  jwksUri: "https://www.googleapis.com/oauth2/v3/certs",
  /** Google's ID tokens use either form as `iss` depending on token version — both are accepted. */
  issuers: ["https://accounts.google.com", "accounts.google.com"] as const
};

/**
 * Env vars required only when `AUTH_GOOGLE_LOGIN_ENABLED=true`
 * (`scripts/validate-env.ts`'s `checkGoogleOidcConfig`).
 */
export const GOOGLE_OIDC_REQUIRED_WHEN_ENABLED = [
  "AUTH_GOOGLE_CLIENT_ID",
  "AUTH_GOOGLE_CLIENT_SECRET"
] as const;

export function isGoogleLoginEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.AUTH_GOOGLE_LOGIN_ENABLED === "true";
}

/**
 * The single boolean every Google-login endpoint and `login.astro` must
 * check before doing anything Google/OIDC-related — true only when BOTH the
 * full-online gate (Issue #587) and this feature's own flag agree. Matches
 * the issue's acceptance criterion "Google login is active only when #587
 * gate is enabled and AUTH_GOOGLE_LOGIN_ENABLED=true."
 */
export function isGoogleLoginRequired(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return isFullOnlineSecurityActive(env) && isGoogleLoginEnabled(env);
}

export function resolveGoogleClientId(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  return env.AUTH_GOOGLE_CLIENT_ID;
}

export function resolveGoogleClientSecret(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  return env.AUTH_GOOGLE_CLIENT_SECRET;
}

/** Comma-separated list, trimmed, lowercased, empty entries dropped. An empty result means auto-linking-by-email is never allowed (fail closed — see `google-oidc-policy.ts`'s `isEmailDomainAllowed`). */
export function resolveGoogleAllowedDomains(
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const raw = env.AUTH_GOOGLE_ALLOWED_DOMAINS;

  if (!raw) {
    return [];
  }

  return raw
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter((domain) => domain.length > 0);
}

export function resolveGoogleRedirectPath(
  env: NodeJS.ProcessEnv = process.env
): string {
  const raw = env.AUTH_GOOGLE_REDIRECT_PATH?.trim();

  return raw && raw.length > 0 ? raw : DEFAULT_REDIRECT_PATH;
}
