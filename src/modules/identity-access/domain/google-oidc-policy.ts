/**
 * Pure Google OIDC decision logic (Issue #590) — same "pure decision, DB/
 * network does the fetching" shape as `mfa-policy.ts`'s
 * `evaluateMfaChallenge` and `password-reset-policy.ts`'s
 * `evaluatePasswordResetToken`. Nothing here makes a network call or reads
 * `process.env` directly — callers pass in already-resolved config/claims.
 */
export type OAuthRequestSnapshot = {
  expiresAt: Date;
  consumedAt: Date | null;
};

export type OAuthRequestDenyReason = "not_found" | "already_used" | "expired";

export type OAuthRequestEvaluation =
  { outcome: "valid" } | { outcome: "invalid"; reason: OAuthRequestDenyReason };

export function evaluateOAuthRequest(
  row: OAuthRequestSnapshot | null,
  now: Date
): OAuthRequestEvaluation {
  if (!row) {
    return { outcome: "invalid", reason: "not_found" };
  }

  if (row.consumedAt !== null) {
    return { outcome: "invalid", reason: "already_used" };
  }

  if (row.expiresAt.getTime() <= now.getTime()) {
    return { outcome: "invalid", reason: "expired" };
  }

  return { outcome: "valid" };
}

export type IdTokenClaims = {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  nonce?: unknown;
  sub?: unknown;
};

export type IdTokenValidationOptions = {
  expectedIssuers: readonly string[];
  expectedAudience: string;
  expectedNonce: string;
  /** Seconds; Unix time, matching the JWT `exp` claim's own unit. */
  nowSec: number;
};

export type IdTokenDenyReason =
  | "missing_subject"
  | "issuer_mismatch"
  | "audience_mismatch"
  | "expired"
  | "nonce_mismatch";

export type IdTokenValidation =
  | { outcome: "valid"; subject: string }
  | { outcome: "invalid"; reason: IdTokenDenyReason };

/**
 * Validates the claims of an ALREADY signature-verified ID token (signature
 * verification itself is `../../../lib/auth/jwt-verify.ts`'s job — this
 * function trusts its caller already confirmed the token is authentically
 * from Google before calling this). Matches the issue's acceptance
 * criterion: "ID token validation checks issuer, audience, expiration, and
 * nonce."
 */
export function validateIdTokenClaims(
  claims: IdTokenClaims,
  options: IdTokenValidationOptions
): IdTokenValidation {
  if (typeof claims.sub !== "string" || claims.sub.length === 0) {
    return { outcome: "invalid", reason: "missing_subject" };
  }

  if (
    typeof claims.iss !== "string" ||
    !options.expectedIssuers.includes(claims.iss)
  ) {
    return { outcome: "invalid", reason: "issuer_mismatch" };
  }

  if (claims.aud !== options.expectedAudience) {
    return { outcome: "invalid", reason: "audience_mismatch" };
  }

  if (typeof claims.exp !== "number" || claims.exp <= options.nowSec) {
    return { outcome: "invalid", reason: "expired" };
  }

  if (claims.nonce !== options.expectedNonce) {
    return { outcome: "invalid", reason: "nonce_mismatch" };
  }

  return { outcome: "valid", subject: claims.sub };
}

/**
 * Auto-linking-by-email guardrail (issue's own acceptance criterion:
 * "Auto-linking by email... requires verified email and allowed domain
 * policy"). Fail-closed by construction: an empty `allowedDomains` list
 * (the default — `AUTH_GOOGLE_ALLOWED_DOMAINS` unset) means auto-linking is
 * NEVER allowed, not "allow any domain."
 */
export function isEmailDomainAllowed(
  email: string,
  allowedDomains: readonly string[]
): boolean {
  if (allowedDomains.length === 0) {
    return false;
  }

  const atIndex = email.lastIndexOf("@");

  if (atIndex === -1) {
    return false;
  }

  const domain = email.slice(atIndex + 1).toLowerCase();

  return allowedDomains.includes(domain);
}
