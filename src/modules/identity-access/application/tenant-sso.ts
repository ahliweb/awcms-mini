/**
 * Generic tenant OIDC SSO application logic (Issue #591, epic: full-online
 * auth hardening) — the same orchestration shape as Issue #590's
 * `google-oidc.ts`, generalized to a TENANT-CONFIGURED provider
 * (`awcms_mini_auth_providers`, migration 036) instead of Google's hardcoded
 * endpoints. Deliberately does not import from `google-oidc.ts` (its
 * `createOAuthRequest`/`consumeOAuthRequest`/etc. all hardcode
 * `provider = 'google'`) — this file duplicates that small amount of logic,
 * parameterized by `providerKey`, against the SAME reused tables
 * (`awcms_mini_oidc_auth_requests`, `awcms_mini_identity_provider_accounts`
 * — both already provider-agnostic since migration 035, see that
 * migration's own comment). This keeps the existing, already-tested Google
 * login flow completely untouched while giving the generic flow its own
 * small, easily-audited implementation.
 *
 * Reuses `google-oidc-policy.ts`'s `evaluateOAuthRequest` and
 * `validateIdTokenClaims` verbatim — both are already pure and
 * provider-agnostic (they operate on generic snapshots/claims, no Google
 * constant baked in), exactly the kind of shared logic the epic's own
 * skill doc calls out as safe to reuse rather than re-derive.
 */
import {
  findJwk,
  parseJwt,
  verifyJwtRs256
} from "../../../lib/auth/jwt-verify";
import {
  discoverOidcConfiguration,
  exchangeAuthorizationCode,
  fetchProviderJwks
} from "../../../lib/auth/generic-oidc-client";
import {
  resolveSsoDiscoveryTimeoutMs,
  resolveSsoRedirectUri
} from "../../../lib/auth/sso-config";
import {
  decryptSsoClientSecret,
  resolveSsoEncryptionKey
} from "../../../lib/auth/sso-credential-crypto";
import {
  buildOAuthStateParam,
  generateOAuthState,
  generateOidcNonce,
  hashOAuthState,
  parseOAuthStateParam
} from "../../../lib/auth/oauth-state-token";
import {
  evaluateOAuthRequest,
  validateIdTokenClaims,
  type IdTokenClaims,
  type OAuthRequestDenyReason
} from "../domain/google-oidc-policy";
import { isAutoLinkAllowedForProvider } from "../domain/tenant-sso-policy";
import { withTenant } from "../../../lib/database/tenant-context";
import {
  isMfaRequired,
  resolveChallengeTtlSec
} from "../../../lib/auth/mfa-config";
import { createMfaChallenge, findActiveMfaFactor } from "./mfa";
import {
  fetchAuthProviderRowByKey,
  type AuthProviderRow
} from "./auth-provider-directory";
import { getTenantAuthPolicy } from "./tenant-auth-policy";

export type SsoOAuthPurpose = "login" | "link";

export async function createSsoOAuthRequest(
  tx: Bun.SQL,
  tenantId: string,
  providerKey: string,
  purpose: SsoOAuthPurpose,
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
    VALUES (${tenantId}, ${providerKey}, ${stateHash}, ${nonce}, ${purpose}, ${identityId}, ${expiresAt})
  `;

  return { state, nonce, expiresAt };
}

export type ConsumeSsoOAuthRequestResult =
  | {
      ok: true;
      purpose: SsoOAuthPurpose;
      identityId: string | null;
      nonce: string;
    }
  | { ok: false; reason: OAuthRequestDenyReason };

/** Same `SELECT ... FOR UPDATE` + compare-and-swap single-use pattern as `google-oidc.ts`'s `consumeOAuthRequest` (PR #597's fix, reused here from day one rather than re-introducing the race). */
export async function consumeSsoOAuthRequest(
  tx: Bun.SQL,
  tenantId: string,
  providerKey: string,
  rawState: string,
  now: Date
): Promise<ConsumeSsoOAuthRequestResult> {
  const stateHash = hashOAuthState(rawState);

  const rows = (await tx`
    SELECT id, purpose, identity_id, nonce, expires_at, consumed_at
    FROM awcms_mini_oidc_auth_requests
    WHERE tenant_id = ${tenantId} AND provider = ${providerKey} AND state_hash = ${stateHash}
    FOR UPDATE
  `) as {
    id: string;
    purpose: SsoOAuthPurpose;
    identity_id: string | null;
    nonce: string;
    expires_at: Date;
    consumed_at: Date | null;
  }[];
  const row = rows[0];

  const evaluation = evaluateOAuthRequest(
    row
      ? { expiresAt: new Date(row.expires_at), consumedAt: row.consumed_at }
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

/** Resolves a provider's client secret in plaintext, in memory only, for the token-exchange call this request makes — never persisted, logged, or returned. `null` means misconfigured (env var referenced but unset, or ciphertext present but the encryption key is unavailable/wrong). */
export function resolveProviderClientSecret(
  provider: AuthProviderRow,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  if (provider.client_secret_env_var) {
    const value = env[provider.client_secret_env_var];
    return value && value.length > 0 ? value : null;
  }

  if (provider.client_secret_ciphertext) {
    const key = resolveSsoEncryptionKey(env);

    if (!key) {
      return null;
    }

    try {
      return decryptSsoClientSecret(provider.client_secret_ciphertext, key);
    } catch {
      return null;
    }
  }

  return null;
}

export type BuildAuthorizationUrlResult =
  | { ok: true; authorizationUrl: string }
  | { ok: false; code: "SSO_PROVIDER_UNAVAILABLE" };

/** Discovers the provider's `authorization_endpoint` and builds the full redirect URL — the one step of the flow that needs a live provider call before the browser ever leaves this app. */
export async function buildSsoAuthorizationUrl(
  provider: AuthProviderRow,
  tenantId: string,
  state: string,
  nonce: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<BuildAuthorizationUrlResult> {
  const discovery = await discoverOidcConfiguration(
    tenantId,
    provider.provider_key,
    provider.issuer_url,
    env
  );

  if (!discovery.ok) {
    return { ok: false, code: "SSO_PROVIDER_UNAVAILABLE" };
  }

  const url = new URL(discovery.document.authorization_endpoint);
  url.searchParams.set("client_id", provider.client_id);
  url.searchParams.set(
    "redirect_uri",
    resolveSsoRedirectUri(provider.provider_key, env)
  );
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", provider.scopes);
  url.searchParams.set("state", buildOAuthStateParam(tenantId, state));
  url.searchParams.set("nonce", nonce);

  return { ok: true, authorizationUrl: url.toString() };
}

export type VerifyIdTokenResult =
  | { ok: true; subject: string; email: string | null; emailVerified: boolean }
  | { ok: false; code: "SSO_ID_TOKEN_INVALID" | "SSO_PROVIDER_UNAVAILABLE" };

/** Full ID token verification pipeline against a tenant-configured provider — same cryptographic approach as `google-oidc.ts`'s `verifyGoogleIdToken` (RS256 via WebCrypto, then issuer/audience/expiry/nonce claim validation), except the JWKS URI/issuer come from `discoverOidcConfiguration` rather than a hardcoded constant. */
export async function verifyTenantOidcIdToken(
  tenantId: string,
  provider: AuthProviderRow,
  idToken: string,
  expectedNonce: string,
  nowSec: number,
  env: NodeJS.ProcessEnv = process.env
): Promise<VerifyIdTokenResult> {
  const discovery = await discoverOidcConfiguration(
    tenantId,
    provider.provider_key,
    provider.issuer_url,
    env
  );

  if (!discovery.ok) {
    return { ok: false, code: "SSO_PROVIDER_UNAVAILABLE" };
  }

  let parsed;

  try {
    parsed = parseJwt(idToken);
  } catch {
    return { ok: false, code: "SSO_ID_TOKEN_INVALID" };
  }

  if (parsed.header.alg !== "RS256" || !parsed.header.kid) {
    return { ok: false, code: "SSO_ID_TOKEN_INVALID" };
  }

  const jwksResult = await fetchProviderJwks(
    tenantId,
    provider.provider_key,
    discovery.document.jwks_uri,
    env
  );

  if (!jwksResult.ok) {
    return { ok: false, code: "SSO_PROVIDER_UNAVAILABLE" };
  }

  const jwk = findJwk(jwksResult.jwks as { keys: never[] }, parsed.header.kid);

  if (!jwk) {
    return { ok: false, code: "SSO_ID_TOKEN_INVALID" };
  }

  const signatureValid = await verifyJwtRs256(
    parsed.signingInput,
    parsed.signature,
    jwk
  );

  if (!signatureValid) {
    return { ok: false, code: "SSO_ID_TOKEN_INVALID" };
  }

  const claimsValidation = validateIdTokenClaims(
    parsed.payload as IdTokenClaims,
    {
      expectedIssuers: [discovery.document.issuer],
      expectedAudience: provider.client_id,
      expectedNonce,
      nowSec
    }
  );

  if (claimsValidation.outcome === "invalid") {
    return { ok: false, code: "SSO_ID_TOKEN_INVALID" };
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

export async function findIdentityByProviderSubject(
  tx: Bun.SQL,
  tenantId: string,
  providerKey: string,
  subject: string
): Promise<string | null> {
  const rows = (await tx`
    SELECT identity_id FROM awcms_mini_identity_provider_accounts
    WHERE tenant_id = ${tenantId} AND provider = ${providerKey} AND provider_subject = ${subject}
  `) as { identity_id: string }[];

  return rows[0]?.identity_id ?? null;
}

export type AutoLinkResult = { ok: true; identityId: string } | { ok: false };

/** Auto-link-by-email for a tenant-configured provider — `isAutoLinkAllowedForProvider` (domain layer) combines the tenant policy's master switch/domain list with this specific provider's own domain list, both fail-closed. */
export async function autoLinkByEmailForProvider(
  tx: Bun.SQL,
  tenantId: string,
  providerKey: string,
  provider: AuthProviderRow,
  email: string,
  emailVerified: boolean,
  subject: string,
  now: Date
): Promise<AutoLinkResult> {
  const policy = await getTenantAuthPolicy(tx, tenantId);
  const providerAllowedDomains = Array.isArray(provider.allowed_email_domains)
    ? (provider.allowed_email_domains as string[])
    : [];
  const atIndex = email.lastIndexOf("@");
  const domain = atIndex === -1 ? null : email.slice(atIndex + 1).toLowerCase();
  const isProviderDomainAllowed =
    domain !== null && providerAllowedDomains.includes(domain);

  const allowed = isAutoLinkAllowedForProvider(
    policy.autoLinkVerifiedEmail,
    emailVerified,
    isProviderDomainAllowed,
    policy.allowedEmailDomains,
    domain
  );

  if (!allowed) {
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

  await tx`
    INSERT INTO awcms_mini_identity_provider_accounts
      (tenant_id, identity_id, provider, provider_subject, linked_at, created_at, updated_at)
    VALUES (${tenantId}, ${identity.id}, ${providerKey}, ${subject}, ${now}, ${now}, ${now})
  `;

  return { ok: true, identityId: identity.id };
}

export type LinkProviderAccountResult =
  { ok: true } | { ok: false; code: "SSO_ALREADY_LINKED" };

export async function linkProviderAccount(
  tx: Bun.SQL,
  tenantId: string,
  providerKey: string,
  identityId: string,
  subject: string,
  now: Date
): Promise<LinkProviderAccountResult> {
  const existingRows = (await tx`
    SELECT identity_id FROM awcms_mini_identity_provider_accounts
    WHERE tenant_id = ${tenantId} AND provider = ${providerKey}
      AND (identity_id = ${identityId} OR provider_subject = ${subject})
  `) as { identity_id: string }[];

  if (existingRows.length > 0) {
    return { ok: false, code: "SSO_ALREADY_LINKED" };
  }

  await tx`
    INSERT INTO awcms_mini_identity_provider_accounts
      (tenant_id, identity_id, provider, provider_subject, linked_at, created_at, updated_at)
    VALUES (${tenantId}, ${identityId}, ${providerKey}, ${subject}, ${now}, ${now}, ${now})
  `;

  return { ok: true };
}

export type UnlinkProviderAccountResult =
  { ok: true } | { ok: false; code: "SSO_NOT_LINKED" };

export async function unlinkProviderAccount(
  tx: Bun.SQL,
  tenantId: string,
  providerKey: string,
  identityId: string
): Promise<UnlinkProviderAccountResult> {
  const deletedRows = (await tx`
    DELETE FROM awcms_mini_identity_provider_accounts
    WHERE tenant_id = ${tenantId} AND identity_id = ${identityId} AND provider = ${providerKey}
    RETURNING id
  `) as { id: string }[];

  if (deletedRows.length === 0) {
    return { ok: false, code: "SSO_NOT_LINKED" };
  }

  return { ok: true };
}

export type SsoOAuthErrorCode =
  | "SSO_OAUTH_STATE_INVALID"
  | "SSO_TOKEN_EXCHANGE_FAILED"
  | "SSO_ID_TOKEN_INVALID"
  | "SSO_ACCOUNT_NOT_LINKED"
  | "SSO_ALREADY_LINKED"
  | "SSO_PROVIDER_DISABLED"
  | "SSO_PROVIDER_UNAVAILABLE"
  | "ACCESS_DENIED";

export type CompleteSsoOAuthResult =
  | { outcome: "session_ready"; tenantId: string; identityId: string }
  | {
      outcome: "mfa_required";
      tenantId: string;
      identityId: string;
      challengeToken: string;
      challengeExpiresAt: Date;
    }
  | { outcome: "linked"; tenantId: string; identityId: string }
  | { outcome: "error"; code: SsoOAuthErrorCode };

/**
 * The single orchestrator `callback.ts` calls — same "spans multiple
 * transactions with external HTTP calls in between, never inside a single
 * DB transaction (ADR-0006)" shape as `google-oidc.ts`'s
 * `completeGoogleOAuthCallback`. Re-checks `provider.enabled` here (not just
 * at `start` time) — an admin may have disabled the provider between the
 * user starting the flow and completing it at the external provider.
 */
export async function completeTenantSsoCallback(
  sql: Bun.SQL,
  providerKey: string,
  rawStateParam: string,
  code: string | null,
  env: NodeJS.ProcessEnv,
  now: Date
): Promise<CompleteSsoOAuthResult> {
  const parsedState = parseOAuthStateParam(rawStateParam);

  if (!parsedState) {
    return { outcome: "error", code: "SSO_OAUTH_STATE_INVALID" };
  }

  const { tenantId, token } = parsedState;

  const consumeResult = await withTenant(sql, tenantId, (tx) =>
    consumeSsoOAuthRequest(tx, tenantId, providerKey, token, now)
  );

  if (!consumeResult.ok) {
    return { outcome: "error", code: "SSO_OAUTH_STATE_INVALID" };
  }

  if (!code) {
    return { outcome: "error", code: "SSO_OAUTH_STATE_INVALID" };
  }

  const provider = await withTenant(sql, tenantId, (tx) =>
    fetchAuthProviderRowByKey(tx, tenantId, providerKey)
  );

  if (!provider || !provider.enabled) {
    return { outcome: "error", code: "SSO_PROVIDER_DISABLED" };
  }

  const clientSecret = resolveProviderClientSecret(provider, env);

  if (!clientSecret) {
    return { outcome: "error", code: "SSO_PROVIDER_UNAVAILABLE" };
  }

  const discovery = await discoverOidcConfiguration(
    tenantId,
    providerKey,
    provider.issuer_url,
    env
  );

  if (!discovery.ok) {
    return { outcome: "error", code: "SSO_PROVIDER_UNAVAILABLE" };
  }

  const exchangeResult = await exchangeAuthorizationCode({
    tenantId,
    providerKey,
    tokenEndpoint: discovery.document.token_endpoint,
    code,
    clientId: provider.client_id,
    clientSecret,
    redirectUri: resolveSsoRedirectUri(providerKey, env),
    timeoutMs: resolveSsoDiscoveryTimeoutMs(env)
  });

  if (!exchangeResult.ok) {
    return { outcome: "error", code: "SSO_TOKEN_EXCHANGE_FAILED" };
  }

  const verifyResult = await verifyTenantOidcIdToken(
    tenantId,
    provider,
    exchangeResult.idToken,
    consumeResult.nonce,
    Math.floor(now.getTime() / 1000),
    env
  );

  if (!verifyResult.ok) {
    return { outcome: "error", code: verifyResult.code };
  }

  return withTenant(sql, tenantId, async (tx) => {
    if (consumeResult.purpose === "link") {
      const linkIdentityId = consumeResult.identityId;

      if (!linkIdentityId) {
        return { outcome: "error", code: "SSO_OAUTH_STATE_INVALID" };
      }

      const linkResult = await linkProviderAccount(
        tx,
        tenantId,
        providerKey,
        linkIdentityId,
        verifyResult.subject,
        now
      );

      if (!linkResult.ok) {
        return { outcome: "error", code: linkResult.code };
      }

      return { outcome: "linked", tenantId, identityId: linkIdentityId };
    }

    let identityId = await findIdentityByProviderSubject(
      tx,
      tenantId,
      providerKey,
      verifyResult.subject
    );

    if (!identityId) {
      const autoLink = await autoLinkByEmailForProvider(
        tx,
        tenantId,
        providerKey,
        provider,
        verifyResult.email ?? "",
        verifyResult.emailVerified,
        verifyResult.subject,
        now
      );

      if (!autoLink.ok) {
        return { outcome: "error", code: "SSO_ACCOUNT_NOT_LINKED" };
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
