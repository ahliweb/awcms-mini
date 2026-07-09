/**
 * MFA/TOTP config gate (Issue #589, epic: full-online auth hardening).
 * Mirrors `../security/turnstile.ts`'s `isTurnstileRequired` shape exactly —
 * `isMfaRequired` is the ONE function `login.ts` and every MFA endpoint
 * checks; local/offline/LAN deployments never read these env vars and never
 * change login behavior.
 */
import { isFullOnlineSecurityActive } from "./online-security-config";

const DEFAULT_TOTP_ISSUER = "AWCMS-Mini";
const DEFAULT_TOTP_PERIOD_SEC = 30;
const DEFAULT_TOTP_DIGITS = 6;
const DEFAULT_CHALLENGE_TTL_SEC = 300;
const KNOWN_TOTP_DIGITS = [6, 8] as const;

/**
 * Env var required only when `AUTH_MFA_ENABLED=true`
 * (`scripts/validate-env.ts`'s `checkMfaConfig`). Only the encryption key
 * needs its own dedicated required-var check — the TOTP issuer/period/digits/
 * challenge-TTL/rate-limit vars all have safe numeric/string defaults below
 * and are never required.
 */
export const AUTH_MFA_REQUIRED_WHEN_ENABLED = [
  "AUTH_MFA_SECRET_ENCRYPTION_KEY"
] as const;

export function isMfaEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AUTH_MFA_ENABLED === "true";
}

/**
 * The single boolean every MFA endpoint and `login.ts` must check before
 * doing anything MFA-related — true only when BOTH the full-online gate
 * (Issue #587) and this feature's own flag agree. Matches the issue's
 * acceptance criterion "MFA is active only when #587 gate is enabled and
 * AUTH_MFA_ENABLED=true."
 */
export function isMfaRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return isFullOnlineSecurityActive(env) && isMfaEnabled(env);
}

export function resolveTotpIssuer(
  env: NodeJS.ProcessEnv = process.env
): string {
  const raw = env.AUTH_MFA_TOTP_ISSUER?.trim();

  return raw && raw.length > 0 ? raw : DEFAULT_TOTP_ISSUER;
}

export function resolveTotpPeriodSec(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = Number(env.AUTH_MFA_TOTP_PERIOD_SEC);

  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TOTP_PERIOD_SEC;
}

export function resolveTotpDigits(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = Number(env.AUTH_MFA_TOTP_DIGITS);

  return (KNOWN_TOTP_DIGITS as readonly number[]).includes(raw)
    ? raw
    : DEFAULT_TOTP_DIGITS;
}

export function resolveChallengeTtlSec(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = Number(env.AUTH_MFA_CHALLENGE_TTL_SEC);

  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CHALLENGE_TTL_SEC;
}
