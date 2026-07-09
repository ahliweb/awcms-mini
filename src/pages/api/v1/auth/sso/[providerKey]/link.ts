import type { APIRoute } from "astro";
import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../lib/database/client";
import { withTenant } from "../../../../../../lib/database/tenant-context";
import { hashSessionToken } from "../../../../../../lib/auth/session-token";
import {
  SESSION_COOKIE_NAME,
  TENANT_COOKIE_NAME
} from "../../../../../../lib/auth/ssr-session";
import {
  extractBearerToken,
  resolveActiveSession
} from "../../../../../../modules/identity-access/application/session-lookup";
import { isSsoRequired } from "../../../../../../lib/auth/sso-config";
import {
  buildSsoAuthorizationUrl,
  createSsoOAuthRequest
} from "../../../../../../modules/identity-access/application/tenant-sso";
import { fetchAuthProviderRowByKey } from "../../../../../../modules/identity-access/application/auth-provider-directory";

const OAUTH_REQUEST_TTL_SEC = 600;

/**
 * `POST /api/v1/auth/sso/{providerKey}/link` (Issue #591) — authenticated,
 * same shape as Issue #590's `providers/google/link.ts`: starts a
 * `link`-purpose OAuth request for the CALLER's own identity (captured
 * server-side, never trusted from the eventual callback) and returns the
 * provider's authorization URL as JSON.
 */
export const POST: APIRoute = async ({ request, cookies, params }) => {
  if (!isSsoRequired()) {
    return fail(
      403,
      "SSO_DISABLED",
      "Tenant OIDC SSO is not enabled for this deployment."
    );
  }

  const providerKey = params.providerKey;

  if (!providerKey) {
    return fail(400, "VALIDATION_ERROR", "providerKey is required.");
  }

  const tenantId =
    request.headers.get("x-awcms-mini-tenant-id") ??
    cookies.get(TENANT_COOKIE_NAME)?.value ??
    null;

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  const token =
    extractBearerToken(request.headers.get("authorization")) ??
    cookies.get(SESSION_COOKIE_NAME)?.value ??
    null;

  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
  }

  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const now = new Date();

  return withTenant(sql, tenantId, async (tx) => {
    const session = await resolveActiveSession(tx, tenantId, tokenHash, now);

    if (!session) {
      return fail(401, "AUTH_REQUIRED", "Session is invalid or expired.");
    }

    const provider = await fetchAuthProviderRowByKey(tx, tenantId, providerKey);

    if (!provider || !provider.enabled) {
      return fail(
        404,
        "SSO_PROVIDER_NOT_FOUND",
        "No enabled SSO provider matches this key."
      );
    }

    const { state, nonce } = await createSsoOAuthRequest(
      tx,
      tenantId,
      providerKey,
      "link",
      session.identity_id,
      OAUTH_REQUEST_TTL_SEC,
      now
    );

    const authorizationResult = await buildSsoAuthorizationUrl(
      provider,
      tenantId,
      state,
      nonce
    );

    if (!authorizationResult.ok) {
      return fail(
        502,
        authorizationResult.code,
        "The SSO provider could not be reached. Try again later."
      );
    }

    return ok({ authorizationUrl: authorizationResult.authorizationUrl });
  });
};
