/**
 * Google OIDC application logic (Issue #590, epic: full-online auth
 * hardening). Reuses this module's own #589 conventions:
 * `oauth-state-token.ts` mirrors `mfa-challenge-token.ts`'s shape, and
 * `consumeOAuthRequest` uses the exact `SELECT ... FOR UPDATE` +
 * compare-and-swap pattern PR #597's security review forced onto
 * `verifyMfaChallenge` — a bearer `state` token has the same "must not be
 * redeemable twice under a concurrency race" requirement a TOTP code does.
 */
import {
  findJwk,
  parseJwt,
  verifyJwtRs256
} from "../../../lib/auth/jwt-verify";
import {
  exchangeAuthorizationCode,
  fetchGoogleJwks,
  resolveGoogleRedirectUri,
  type GoogleJwks
} from "../../../lib/auth/google-oauth-client";
import {
  GOOGLE_OIDC_ENDPOINTS,
  resolveGoogleAllowedDomains,
  resolveGoogleClientId,
  resolveGoogleClientSecret
} from "../../../lib/auth/google-oidc-config";
import {
  generateOAuthState,
  generateOidcNonce,
  hashOAuthState,
  parseOAuthStateParam
} from "../../../lib/auth/oauth-state-token";
import {
  evaluateOAuthRequest,
  isEmailDomainAllowed,
  validateIdTokenClaims,
  type IdTokenClaims,
  type OAuthRequestDenyReason
} from "../domain/google-oidc-policy";
import { withTenant } from "../../../lib/database/tenant-context";
import {
  isMfaRequired,
  resolveChallengeTtlSec
} from "../../../lib/auth/mfa-config";
import { createMfaChallenge, findActiveMfaFactor } from "./mfa";

export type OAuthPurpose = "login" | "link";

export async function createOAuthRequest(
  tx: Bun.SQL,
  tenantId: string,
  purpose: OAuthPurpose,
  identityId: string | null,
  ttlSec: number,
  now: Date
): Promise<{ state: string; nonce: string; expiresAt: Date }> {
  const state = generateOAuthState();
  const stateHash = hashOAuthState(state);
  const nonce = generateOidcNonce();
  const expiresAt = new Date(now.getTime() + ttlSec * 1000);

  await tx`
    INSERT INTO awcms_mini_oidc_auth_requests
      (tenant_id, provider, state_hash, nonce, purpose, identity_id, expires_at)
    VALUES (${tenantId}, 'google', ${stateHash}, ${nonce}, ${purpose}, ${identityId}, ${expiresAt})
  `;

  return { state, nonce, expiresAt };
}

export type ConsumeOAuthRequestResult =
  | {
      ok: true;
      purpose: OAuthPurpose;
      identityId: string | null;
      nonce: string;
    }
  | { ok: false; reason: OAuthRequestDenyReason };

/**
 * Looks up and single-use-consumes an OAuth request by its raw `state`
 * value. `FOR UPDATE` + a CAS `UPDATE ... WHERE consumed_at IS NULL` (not a
 * blind SET) — the same fix PR #597 applied to `verifyMfaChallenge` —
 * closes the race where two concurrent callback requests carrying the same
 * `state` (e.g. a doubled browser redirect, or an attacker replaying an
 * intercepted callback URL) could otherwise both read "not yet consumed"
 * before either commits.
 */
export async function consumeOAuthRequest(
  tx: Bun.SQL,
  tenantId: string,
  rawState: string,
  now: Date
): Promise<ConsumeOAuthRequestResult> {
  const stateHash = hashOAuthState(rawState);

  const rows = (await tx`
    SELECT id, purpose, identity_id, nonce, expires_at, consumed_at
    FROM awcms_mini_oidc_auth_requests
    WHERE tenant_id = ${tenantId} AND provider = 'google' AND state_hash = ${stateHash}
    FOR UPDATE
  `) as {
    id: string;
    purpose: OAuthPurpose;
    identity_id: string | null;
    nonce: string;
    expires_at: Date;
    consumed_at: Date | null;
  }[];
  const row = rows[0];

  const evaluation = evaluateOAuthRequest(
    row
      ? {
          expiresAt: new Date(row.expires_at),
          consumedAt: row.consumed_at
        }
      : null,
    now
  );

  if (evaluation.outcome === "invalid") {
    return { ok: false, reason: evaluation.reason };
  }

  const consumedRows = (await tx`
    UPDATE awcms_mini_oidc_auth_requests
    SET consumed_at = ${now}
    WHERE id = ${row!.id} AND consumed_at IS NULL
    RETURNING id
  `) as { id: string }[];

  if (consumedRows.length === 0) {
    return { ok: false, reason: "already_used" };
  }

  return {
    ok: true,
    purpose: row!.purpose,
    identityId: row!.identity_id,
    nonce: row!.nonce
  };
}

export type VerifyIdTokenResult =
  | { ok: true; subject: string; email: string | null; emailVerified: boolean }
  | { ok: false; code: "GOOGLE_ID_TOKEN_INVALID" | "GOOGLE_MISCONFIGURED" };

/**
 * Full ID token verification pipeline: parse -> fetch/select the matching
 * JWKS key -> verify the RS256 signature (cryptographic proof this token
 * really came from Google, not just well-formed JSON — issue's own security
 * note: "Do not trust query parameters alone; validate ID token
 * cryptographically") -> validate claims (issuer/audience/expiry/nonce, via
 * the pure `validateIdTokenClaims`). Every failure mode collapses to the
 * same generic `GOOGLE_ID_TOKEN_INVALID` (anti-enumeration, matches this
 * module's `MFA_CHALLENGE_INVALID`/`completePasswordReset` convention) —
 * the specific reason is for internal audit logging only, never returned.
 */
export async function verifyGoogleIdToken(
  idToken: string,
  expectedClientId: string,
  expectedNonce: string,
  nowSec: number
): Promise<VerifyIdTokenResult> {
  let parsed;

  try {
    parsed = parseJwt(idToken);
  } catch {
    return { ok: false, code: "GOOGLE_ID_TOKEN_INVALID" };
  }

  if (parsed.header.alg !== "RS256" || !parsed.header.kid) {
    return { ok: false, code: "GOOGLE_ID_TOKEN_INVALID" };
  }

  const jwksResult = await fetchGoogleJwks();

  if (!jwksResult.ok) {
    return { ok: false, code: "GOOGLE_MISCONFIGURED" };
  }

  const jwk = findJwk(
    jwksResult.jwks as GoogleJwks & { keys: never[] },
    parsed.header.kid
  );

  if (!jwk) {
    return { ok: false, code: "GOOGLE_ID_TOKEN_INVALID" };
  }

  const signatureValid = await verifyJwtRs256(
    parsed.signingInput,
    parsed.signature,
    jwk
  );

  if (!signatureValid) {
    return { ok: false, code: "GOOGLE_ID_TOKEN_INVALID" };
  }

  const claimsValidation = validateIdTokenClaims(
    parsed.payload as IdTokenClaims,
    {
      expectedIssuers: GOOGLE_OIDC_ENDPOINTS.issuers,
      expectedAudience: expectedClientId,
      expectedNonce,
      nowSec
    }
  );

  if (claimsValidation.outcome === "invalid") {
    return { ok: false, code: "GOOGLE_ID_TOKEN_INVALID" };
  }

  const email =
    typeof parsed.payload.email === "string" ? parsed.payload.email : null;
  const emailVerified = parsed.payload.email_verified === true;

  return {
    ok: true,
    subject: claimsValidation.subject,
    email,
    emailVerified
  };
}

/** Used by `callback.ts` to find an existing account after ID token verification succeeds. */
export async function findIdentityByProviderSubject(
  tx: Bun.SQL,
  tenantId: string,
  subject: string
): Promise<string | null> {
  const rows = (await tx`
    SELECT identity_id FROM awcms_mini_identity_provider_accounts
    WHERE tenant_id = ${tenantId} AND provider = 'google' AND provider_subject = ${subject}
  `) as { identity_id: string }[];

  return rows[0]?.identity_id ?? null;
}

export type AutoLinkResult = { ok: true; identityId: string } | { ok: false };

/**
 * Auto-link-by-email (issue's own acceptance criterion: "requires verified
 * email and allowed domain policy"). Only ever runs when no provider
 * account already exists for this `subject` — `callback.ts` tries
 * `findIdentityByProviderSubject` first. Requires: `emailVerified` true,
 * the email's domain in the configured allow-list
 * (`isEmailDomainAllowed` — fail-closed on an empty list), a tenant-active
 * identity whose `login_identifier` exactly equals `email`, and that
 * identity's `tenant_user` membership active — the same eligibility
 * checks `requestPasswordReset` already applies before treating an
 * identifier as "real."
 */
export async function autoLinkByEmail(
  tx: Bun.SQL,
  tenantId: string,
  email: string,
  emailVerified: boolean,
  allowedDomains: readonly string[],
  subject: string,
  now: Date
): Promise<AutoLinkResult> {
  if (!emailVerified || !isEmailDomainAllowed(email, allowedDomains)) {
    return { ok: false };
  }

  const tenantRows = (await tx`
    SELECT status FROM awcms_mini_tenants WHERE id = ${tenantId}
  `) as { status: string }[];

  if (tenantRows[0]?.status !== "active") {
    return { ok: false };
  }

  const identityRows = (await tx`
    SELECT id, status FROM awcms_mini_identities
    WHERE tenant_id = ${tenantId} AND login_identifier = ${email}
  `) as { id: string; status: string }[];
  const identity = identityRows[0];

  if (!identity || identity.status !== "active") {
    return { ok: false };
  }

  const tenantUserRows = (await tx`
    SELECT status FROM awcms_mini_tenant_users
    WHERE tenant_id = ${tenantId} AND identity_id = ${identity.id}
  `) as { status: string }[];

  if (tenantUserRows[0]?.status !== "active") {
    return { ok: false };
  }

  // Compare-and-swap-free INSERT is safe here because both unique indexes
  // on `awcms_mini_identity_provider_accounts` (subject-scoped and
  // identity-scoped) enforce the invariant at the DB level — a concurrent
  // duplicate insert throws a unique-violation rather than silently
  // double-linking.
  await tx`
    INSERT INTO awcms_mini_identity_provider_accounts
      (tenant_id, identity_id, provider, provider_subject, linked_at, created_at, updated_at)
    VALUES (${tenantId}, ${identity.id}, 'google', ${subject}, ${now}, ${now}, ${now})
  `;

  return { ok: true, identityId: identity.id };
}

export type LinkProviderAccountResult =
  { ok: true } | { ok: false; code: "GOOGLE_ALREADY_LINKED" };

/**
 * Explicit link (authenticated user choosing to attach Google as an
 * additional login method). Rejects if this identity already has a Google
 * account linked, or if this specific Google subject is already linked to
 * a DIFFERENT identity in this tenant (both enforced by the unique indexes;
 * checked here first only to return a clean, specific error code instead
 * of a raw constraint-violation exception).
 */
export async function linkProviderAccount(
  tx: Bun.SQL,
  tenantId: string,
  identityId: string,
  subject: string,
  now: Date
): Promise<LinkProviderAccountResult> {
  const existingRows = (await tx`
    SELECT identity_id FROM awcms_mini_identity_provider_accounts
    WHERE tenant_id = ${tenantId} AND provider = 'google'
      AND (identity_id = ${identityId} OR provider_subject = ${subject})
  `) as { identity_id: string }[];

  if (existingRows.length > 0) {
    return { ok: false, code: "GOOGLE_ALREADY_LINKED" };
  }

  await tx`
    INSERT INTO awcms_mini_identity_provider_accounts
      (tenant_id, identity_id, provider, provider_subject, linked_at, created_at, updated_at)
    VALUES (${tenantId}, ${identityId}, 'google', ${subject}, ${now}, ${now}, ${now})
  `;

  return { ok: true };
}

export type UnlinkProviderAccountResult =
  { ok: true } | { ok: false; code: "GOOGLE_NOT_LINKED" };

export async function unlinkProviderAccount(
  tx: Bun.SQL,
  tenantId: string,
  identityId: string
): Promise<UnlinkProviderAccountResult> {
  const deletedRows = (await tx`
    DELETE FROM awcms_mini_identity_provider_accounts
    WHERE tenant_id = ${tenantId} AND identity_id = ${identityId} AND provider = 'google'
    RETURNING id
  `) as { id: string }[];

  if (deletedRows.length === 0) {
    return { ok: false, code: "GOOGLE_NOT_LINKED" };
  }

  return { ok: true };
}

export type GoogleOAuthErrorCode =
  | "GOOGLE_OAUTH_STATE_INVALID"
  | "GOOGLE_TOKEN_EXCHANGE_FAILED"
  | "GOOGLE_ID_TOKEN_INVALID"
  | "GOOGLE_ACCOUNT_NOT_LINKED"
  | "GOOGLE_ALREADY_LINKED"
  | "GOOGLE_MISCONFIGURED"
  | "ACCESS_DENIED";

export type CompleteGoogleOAuthResult =
  | { outcome: "session_ready"; tenantId: string; identityId: string }
  | {
      outcome: "mfa_required";
      tenantId: string;
      identityId: string;
      challengeToken: string;
      challengeExpiresAt: Date;
    }
  | { outcome: "linked"; tenantId: string; identityId: string }
  | { outcome: "error"; code: GoogleOAuthErrorCode };

/**
 * The single orchestrator both `callback.ts` (GET, Google's own redirect
 * target) and the eventual client-driven completion path call — deliberately
 * NOT a `tx`-scoped function like every other function in this file: it
 * spans MULTIPLE transactions with external HTTP calls (token exchange,
 * JWKS fetch) in between, and those calls must never happen inside a DB
 * transaction (ADR-0006). Takes the raw `sql` client and opens/closes
 * `withTenant` transactions itself, exactly as an endpoint normally would —
 * centralized here (rather than duplicated per endpoint) because this
 * specific sequencing (verify state -> exchange code -> verify ID token ->
 * resolve identity -> MFA gate) is complex enough that duplicating it would
 * risk the two call sites silently diverging on a security-relevant step.
 *
 * Session/cookie creation and audit logging remain the CALLING endpoint's
 * responsibility (matches this module's existing convention — `login.ts`,
 * `mfa/totp/verify.ts` — of owning their own cookies/audit calls), so this
 * function only ever returns identity/challenge identifiers, never sets a
 * cookie or writes an audit row itself.
 */
export async function completeGoogleOAuthCallback(
  sql: Bun.SQL,
  rawStateParam: string,
  code: string | null,
  env: NodeJS.ProcessEnv,
  now: Date
): Promise<CompleteGoogleOAuthResult> {
  const parsedState = parseOAuthStateParam(rawStateParam);

  if (!parsedState) {
    return { outcome: "error", code: "GOOGLE_OAUTH_STATE_INVALID" };
  }

  const { tenantId, token } = parsedState;

  const consumeResult = await withTenant(sql, tenantId, (tx) =>
    consumeOAuthRequest(tx, tenantId, token, now)
  );

  if (!consumeResult.ok) {
    return { outcome: "error", code: "GOOGLE_OAUTH_STATE_INVALID" };
  }

  if (!code) {
    return { outcome: "error", code: "GOOGLE_OAUTH_STATE_INVALID" };
  }

  const clientId = resolveGoogleClientId(env);
  const clientSecret = resolveGoogleClientSecret(env);

  if (!clientId || !clientSecret) {
    return { outcome: "error", code: "GOOGLE_MISCONFIGURED" };
  }

  const exchangeResult = await exchangeAuthorizationCode({
    code,
    clientId,
    clientSecret,
    redirectUri: resolveGoogleRedirectUri(env)
  });

  if (!exchangeResult.ok) {
    return { outcome: "error", code: "GOOGLE_TOKEN_EXCHANGE_FAILED" };
  }

  const verifyResult = await verifyGoogleIdToken(
    exchangeResult.idToken,
    clientId,
    consumeResult.nonce,
    Math.floor(now.getTime() / 1000)
  );

  if (!verifyResult.ok) {
    return { outcome: "error", code: verifyResult.code };
  }

  return withTenant(sql, tenantId, async (tx) => {
    if (consumeResult.purpose === "link") {
      // `identityId` was captured server-side at `start`/`link`-initiation
      // time from an authenticated session — never trusted from this
      // callback request itself. The DB CHECK constraint on
      // `awcms_mini_oidc_auth_requests` guarantees a `link`-purpose row
      // always has one, but this is re-checked here rather than asserted,
      // since a `null` here indicates a schema/data invariant violation
      // that must fail closed, not crash.
      const linkIdentityId = consumeResult.identityId;

      if (!linkIdentityId) {
        return { outcome: "error", code: "GOOGLE_OAUTH_STATE_INVALID" };
      }

      const linkResult = await linkProviderAccount(
        tx,
        tenantId,
        linkIdentityId,
        verifyResult.subject,
        now
      );

      if (!linkResult.ok) {
        return { outcome: "error", code: linkResult.code };
      }

      return {
        outcome: "linked",
        tenantId,
        identityId: linkIdentityId
      };
    }

    let identityId = await findIdentityByProviderSubject(
      tx,
      tenantId,
      verifyResult.subject
    );

    if (!identityId) {
      const autoLink = await autoLinkByEmail(
        tx,
        tenantId,
        verifyResult.email ?? "",
        verifyResult.emailVerified,
        resolveGoogleAllowedDomains(env),
        verifyResult.subject,
        now
      );

      if (!autoLink.ok) {
        return { outcome: "error", code: "GOOGLE_ACCOUNT_NOT_LINKED" };
      }

      identityId = autoLink.identityId;
    }

    const identityRows = (await tx`
      SELECT status FROM awcms_mini_identities WHERE id = ${identityId}
    `) as { status: string }[];
    const tenantUserRows = (await tx`
      SELECT status FROM awcms_mini_tenant_users
      WHERE tenant_id = ${tenantId} AND identity_id = ${identityId}
    `) as { status: string }[];

    if (
      identityRows[0]?.status !== "active" ||
      tenantUserRows[0]?.status !== "active"
    ) {
      return { outcome: "error", code: "ACCESS_DENIED" };
    }

    if (isMfaRequired(env)) {
      const factor = await findActiveMfaFactor(tx, tenantId, identityId);

      if (factor) {
        const challenge = await createMfaChallenge(
          tx,
          tenantId,
          identityId,
          resolveChallengeTtlSec(env),
          now
        );

        return {
          outcome: "mfa_required",
          tenantId,
          identityId,
          challengeToken: challenge.token,
          challengeExpiresAt: challenge.expiresAt
        };
      }
    }

    return { outcome: "session_ready", tenantId, identityId };
  });
}
