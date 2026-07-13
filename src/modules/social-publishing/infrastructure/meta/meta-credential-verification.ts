/**
 * Shared `verifyCredentials` implementation for both Meta adapters (Issue
 * #644) — Facebook Page and Instagram connections both authenticate via a
 * Page access token, so both verify it the same way: Meta's `debug_token`
 * endpoint (developers.facebook.com/docs/graph-api/reference/debug_token),
 * called with an APP access token (`{appId}|{appSecret}`), never the
 * inspected token itself as the caller credential — followed by a live
 * `GET /{providerAccountId}?fields=id` call USING the inspected token, to
 * confirm it can actually reach the SPECIFIC connected Page/Instagram
 * Business account (Issue #646's shared interface change: a bearer
 * credential can be generally valid yet still lack access to this named
 * target — checking scopes/token validity alone is not sufficient, see
 * `domain/social-provider-adapter.ts`'s `verifyCredentials` docstring).
 *
 * Deliberately does NOT trust the account row's own stored `scopes_json`
 * as the source of truth for "does this token still have the required
 * scopes" — `debug_token`'s response is the LIVE, provider-authoritative
 * view (a scope can be revoked on Meta's side without this repo ever
 * hearing about it). `scopesJson` stays part of the `verifyCredentials`
 * interface for providers that have no live introspection endpoint of
 * their own; Meta simply doesn't need it. On success, returns
 * `details.permissions` (the live scope list) — the shared verify route
 * (`pages/api/v1/social-publishing/accounts/[id]/verify.ts`) uses this to
 * refresh the account's stored `scopes_json` from the authoritative
 * source, same as Telegram's own adapter does with its discovered
 * permission flags.
 */
import type { SocialProviderCredentialCheck } from "../../domain/social-provider-adapter";
import { loadMetaProviderConfig } from "../../domain/meta-provider-config";
import type { MetaGraphClient } from "./meta-graph-client";
import { resolveMetaTokenReference } from "./meta-token-reference-resolver";

type DebugTokenData = {
  isValid: boolean;
  expiresAt: number | null;
  scopes: string[];
};

function extractDebugTokenData(body: unknown): DebugTokenData | null {
  if (!body || typeof body !== "object") {
    return null;
  }

  const data = (body as Record<string, unknown>).data;

  if (!data || typeof data !== "object") {
    return null;
  }

  const record = data as Record<string, unknown>;
  const isValid = record.is_valid === true;
  const expiresAtRaw = record.expires_at;
  const expiresAt =
    typeof expiresAtRaw === "number" && expiresAtRaw > 0 ? expiresAtRaw : null;
  const scopesRaw = record.scopes;
  const scopes = Array.isArray(scopesRaw)
    ? scopesRaw.filter((scope): scope is string => typeof scope === "string")
    : [];

  return { isValid, expiresAt, scopes };
}

export async function verifyMetaCredentials(
  tokenReference: string,
  providerAccountId: string,
  _scopesJson: unknown,
  env: NodeJS.ProcessEnv,
  graphClientFactory: (graphApiVersion: string) => MetaGraphClient
): Promise<SocialProviderCredentialCheck> {
  const config = loadMetaProviderConfig(env);

  if (!config) {
    return { valid: false, reason: "meta_provider_not_configured" };
  }

  const credential = resolveMetaTokenReference(tokenReference, env);

  if (!credential) {
    return { valid: false, reason: "token_reference_unresolved" };
  }

  const appSecretCredential = resolveMetaTokenReference(
    config.appSecretReference,
    env
  );

  if (!appSecretCredential) {
    return { valid: false, reason: "app_secret_reference_unresolved" };
  }

  const client = graphClientFactory(config.graphApiVersion);
  const appAccessToken = `${config.appId}|${appSecretCredential.value}`;

  let response: Awaited<ReturnType<MetaGraphClient["call"]>>;

  try {
    response = await client.call({
      path: "/debug_token",
      method: "GET",
      params: {
        input_token: credential.value,
        access_token: appAccessToken
      }
    });
  } catch {
    return { valid: false, reason: "verification_call_failed" };
  }

  if (response.httpStatus < 200 || response.httpStatus >= 300) {
    return { valid: false, reason: "debug_token_call_failed" };
  }

  const data = extractDebugTokenData(response.body);

  if (!data) {
    return { valid: false, reason: "debug_token_unexpected_response" };
  }

  if (!data.isValid) {
    return { valid: false, reason: "token_invalid" };
  }

  if (data.expiresAt !== null && data.expiresAt * 1000 < Date.now()) {
    return { valid: false, reason: "token_expired" };
  }

  const missingScopes = config.requiredScopes.filter(
    (scope) => !data.scopes.includes(scope)
  );

  if (missingScopes.length > 0) {
    return {
      valid: false,
      reason: `missing_scopes:${missingScopes.join(",")}`
    };
  }

  let targetResponse: Awaited<ReturnType<MetaGraphClient["call"]>>;

  try {
    targetResponse = await client.call({
      path: `/${providerAccountId}`,
      method: "GET",
      params: {
        fields: "id",
        access_token: credential.value
      }
    });
  } catch {
    return { valid: false, reason: "target_verification_call_failed" };
  }

  if (targetResponse.httpStatus < 200 || targetResponse.httpStatus >= 300) {
    return { valid: false, reason: "target_not_accessible" };
  }

  return { valid: true, details: { permissions: data.scopes } };
}
