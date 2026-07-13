import { recordAuditEvent } from "../../logging/application/audit-log";
import type {
  CreateSocialAccountInput,
  SocialAccountType
} from "../domain/social-account-validation";

/**
 * Read/write query module for `awcms_mini_social_accounts` (Issue #643).
 * `token_reference` is NEVER selected back out by any function whose result
 * can reach an HTTP response or admin UI — same "write-only, deliberately
 * never selected" precedent `tenant-domain-directory.ts` set for
 * `verification_token_hash` (see that file's own header comment). API
 * responses/admin UI must never see it, even though it is only a reference
 * (not the real secret) — the reference string itself is still treated as
 * sensitive-shaped by convention, so a bug elsewhere that stores something
 * more sensitive there does not automatically leak. There are now TWO
 * exceptions, both INTERNAL — a caller must resolve the reference to real
 * credentials and pass it to an adapter, but must never let the value itself
 * flow into a returned/serialized HTTP response body:
 *
 *   - `fetchSocialAccountTokenReferenceForDispatch` — used by
 *     `social-publish-dispatch.ts` (an internal worker) for bulk unattended
 *     publish attempts.
 *   - `fetchSocialAccountCredentialsForVerification` (Issue #646) — used by
 *     `pages/api/v1/social-publishing/accounts/[id]/verify.ts` for a single,
 *     human-triggered "verify this account" admin action. This IS an HTTP
 *     route, but the route only ever passes the resolved value into
 *     `adapter.verifyCredentials(...)` and returns `{valid, reason}` —
 *     `tokenReference` itself is never included in that response.
 *
 * The column list is repeated literally at each query site (not factored
 * into a shared fragment) — same convention every other directory module in
 * this repo uses (e.g. `ad-placement-directory.ts`).
 */
export type SocialAccountView = {
  id: string;
  tenantId: string;
  providerKey: string;
  providerAccountId: string;
  providerAccountName: string;
  providerAccountType: SocialAccountType;
  connectionStatus: string;
  scopes: string[];
  expiresAt: Date | null;
  lastVerifiedAt: Date | null;
  autoPublishEnabled: boolean;
  connectedAt: Date | null;
  disconnectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type SocialAccountRow = {
  id: string;
  tenant_id: string;
  provider_key: string;
  provider_account_id: string;
  provider_account_name: string;
  provider_account_type: SocialAccountType;
  connection_status: string;
  scopes_json: unknown;
  expires_at: Date | null;
  last_verified_at: Date | null;
  auto_publish_enabled: boolean;
  connected_at: Date | null;
  disconnected_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

function toView(row: SocialAccountRow): SocialAccountView {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    providerKey: row.provider_key,
    providerAccountId: row.provider_account_id,
    providerAccountName: row.provider_account_name,
    providerAccountType: row.provider_account_type,
    connectionStatus: row.connection_status,
    scopes: Array.isArray(row.scopes_json) ? (row.scopes_json as string[]) : [],
    expiresAt: row.expires_at,
    lastVerifiedAt: row.last_verified_at,
    autoPublishEnabled: row.auto_publish_enabled,
    connectedAt: row.connected_at,
    disconnectedAt: row.disconnected_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const AUDIT_MODULE_KEY = "social_publishing";
const AUDIT_RESOURCE_TYPE = "social_account";

/**
 * Connects (or reconnects/reauthorizes) an account — upsert on the natural
 * `(tenant_id, provider_key, provider_account_id)` identity
 * (`awcms_mini_social_accounts_identity_key`). Reconnecting an
 * already-known account (e.g. after `needs_reauth`) always resets
 * `connection_status` back to `'connected'` and replaces
 * `token_reference`/`scopes_json`/`expires_at` — this IS the
 * reauthorization flow the issue's acceptance criteria asks for, there is
 * no separate "reauthorize" endpoint.
 *
 * `last_verified_at` is left/reset to `NULL` on both INSERT and UPDATE
 * (Issue #646, corrected from #643's original `now()` default) —
 * connecting/reconnecting only proves the tenant admin SUBMITTED a
 * credential, not that a provider adapter has actually confirmed it can
 * post to the target. Since Issue #646 gives this column real teeth (`POST
 * /accounts/{id}/verify` -> `adapter.verifyCredentials`,
 * `checkTelegramProviderReadiness`'s "never verified" signal), stamping it
 * at connect time would make every account look "verified" the instant
 * it's connected — defeating the entire "verify bot can post to channel
 * before enabling auto posting" acceptance criterion. A reconnect with
 * fresh credentials must also require re-verification, hence resetting to
 * `NULL` on the `ON CONFLICT` path too, not just leaving it untouched.
 */
export async function connectSocialAccount(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: CreateSocialAccountInput,
  correlationId?: string
): Promise<SocialAccountView> {
  const rows = (await tx`
    INSERT INTO awcms_mini_social_accounts
      (tenant_id, provider_key, provider_account_id, provider_account_name,
       provider_account_type, connection_status, token_reference, scopes_json,
       expires_at, last_verified_at, auto_publish_enabled, connected_by, connected_at,
       disconnected_by, disconnected_at, disconnect_reason)
    VALUES (
      ${tenantId}, ${input.providerKey}, ${input.providerAccountId}, ${input.providerAccountName},
      ${input.providerAccountType}, 'connected', ${input.tokenReference}, ${input.scopes}::jsonb,
      ${input.expiresAt}, NULL, ${input.autoPublishEnabled}, ${actorTenantUserId}, now(),
      NULL, NULL, NULL
    )
    ON CONFLICT (tenant_id, provider_key, provider_account_id) DO UPDATE SET
      provider_account_name = EXCLUDED.provider_account_name,
      provider_account_type = EXCLUDED.provider_account_type,
      connection_status = 'connected',
      token_reference = EXCLUDED.token_reference,
      scopes_json = EXCLUDED.scopes_json,
      expires_at = EXCLUDED.expires_at,
      last_verified_at = NULL,
      auto_publish_enabled = EXCLUDED.auto_publish_enabled,
      connected_by = ${actorTenantUserId},
      connected_at = now(),
      disconnected_by = NULL,
      disconnected_at = NULL,
      disconnect_reason = NULL,
      updated_at = now()
    RETURNING id, tenant_id, provider_key, provider_account_id, provider_account_name,
      provider_account_type, connection_status, scopes_json, expires_at,
      last_verified_at, auto_publish_enabled, connected_at, disconnected_at,
      created_at, updated_at
  `) as SocialAccountRow[];

  const account = toView(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "social_publishing.account.connected",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: account.id,
    severity: "info",
    message: `Social account connected: ${account.providerKey}/${account.providerAccountName}.`,
    attributes: {
      providerKey: account.providerKey,
      providerAccountType: account.providerAccountType
    },
    correlationId
  });

  return account;
}

export async function fetchSocialAccountById(
  tx: Bun.SQL,
  tenantId: string,
  id: string
): Promise<SocialAccountView | null> {
  const rows = (await tx`
    SELECT id, tenant_id, provider_key, provider_account_id, provider_account_name,
      provider_account_type, connection_status, scopes_json, expires_at,
      last_verified_at, auto_publish_enabled, connected_at, disconnected_at,
      created_at, updated_at
    FROM awcms_mini_social_accounts
    WHERE tenant_id = ${tenantId} AND id = ${id}
  `) as SocialAccountRow[];

  const row = rows[0];
  return row ? toView(row) : null;
}

export async function listSocialAccounts(
  tx: Bun.SQL,
  tenantId: string
): Promise<SocialAccountView[]> {
  const rows = (await tx`
    SELECT id, tenant_id, provider_key, provider_account_id, provider_account_name,
      provider_account_type, connection_status, scopes_json, expires_at,
      last_verified_at, auto_publish_enabled, connected_at, disconnected_at,
      created_at, updated_at
    FROM awcms_mini_social_accounts
    WHERE tenant_id = ${tenantId}
    ORDER BY created_at DESC
    LIMIT 500
  `) as SocialAccountRow[];

  return rows.map(toView);
}

/** Only accounts eligible for auto-publishing — connected, per-account switch on. Used by `create-social-publish-jobs.ts`, never exposed as its own API response shape. */
export async function listConnectedAutoPublishAccountsForTenant(
  tx: Bun.SQL,
  tenantId: string
): Promise<SocialAccountView[]> {
  const rows = (await tx`
    SELECT id, tenant_id, provider_key, provider_account_id, provider_account_name,
      provider_account_type, connection_status, scopes_json, expires_at,
      last_verified_at, auto_publish_enabled, connected_at, disconnected_at,
      created_at, updated_at
    FROM awcms_mini_social_accounts
    WHERE tenant_id = ${tenantId} AND connection_status = 'connected'
      AND auto_publish_enabled = true
  `) as SocialAccountRow[];

  return rows.map(toView);
}

export async function updateSocialAccountAutoPublish(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  id: string,
  autoPublishEnabled: boolean,
  correlationId?: string
): Promise<SocialAccountView | null> {
  const rows = (await tx`
    UPDATE awcms_mini_social_accounts
    SET auto_publish_enabled = ${autoPublishEnabled}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${id}
    RETURNING id, tenant_id, provider_key, provider_account_id, provider_account_name,
      provider_account_type, connection_status, scopes_json, expires_at,
      last_verified_at, auto_publish_enabled, connected_at, disconnected_at,
      created_at, updated_at
  `) as SocialAccountRow[];

  const row = rows[0];
  if (!row) return null;

  const updated = toView(row);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "social_publishing.account.auto_publish_updated",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: id,
    severity: "info",
    message: `Social account auto-publish set to ${autoPublishEnabled}: ${updated.providerKey}/${updated.providerAccountName}.`,
    correlationId
  });

  return updated;
}

/**
 * Disconnects an account — status transition, not a delete (there is no
 * `accounts.delete` permission in this issue's suggested list). Clears
 * `token_reference` (the reference is treated as revoked; a real
 * reconnection must supply a fresh one via `connectSocialAccount`).
 */
export async function disconnectSocialAccount(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  id: string,
  reason: string,
  correlationId?: string
): Promise<SocialAccountView | null> {
  const rows = (await tx`
    UPDATE awcms_mini_social_accounts
    SET connection_status = 'disconnected', token_reference = NULL,
        auto_publish_enabled = false, disconnected_by = ${actorTenantUserId},
        disconnected_at = now(), disconnect_reason = ${reason}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${id} AND connection_status <> 'disconnected'
    RETURNING id, tenant_id, provider_key, provider_account_id, provider_account_name,
      provider_account_type, connection_status, scopes_json, expires_at,
      last_verified_at, auto_publish_enabled, connected_at, disconnected_at,
      created_at, updated_at
  `) as SocialAccountRow[];

  const row = rows[0];
  if (!row) return null;

  const updated = toView(row);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "social_publishing.account.disconnected",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: id,
    severity: "warning",
    message: `Social account disconnected: ${updated.providerKey}/${updated.providerAccountName}.`,
    attributes: { reason },
    correlationId
  });

  return updated;
}

/** Marks an account as needing reauthorization — called by the dispatcher when a provider reports `needs_reauth` (never by an HTTP endpoint directly). */
export async function markSocialAccountNeedsReauth(
  tx: Bun.SQL,
  tenantId: string,
  id: string,
  correlationId?: string
): Promise<void> {
  const rows = (await tx`
    UPDATE awcms_mini_social_accounts
    SET connection_status = 'needs_reauth', updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${id} AND connection_status = 'connected'
    RETURNING id, provider_key, provider_account_name
  `) as { id: string; provider_key: string; provider_account_name: string }[];

  const row = rows[0];
  if (!row) return;

  await recordAuditEvent(tx, {
    tenantId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "social_publishing.account.needs_reauth",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: row.id,
    severity: "warning",
    message: `Social account requires reauthorization: ${row.provider_key}/${row.provider_account_name}.`,
    correlationId
  });
}

/**
 * INTERNAL ONLY — `social-publish-dispatch.ts` calls this to obtain the
 * `token_reference` it must pass to a provider adapter's `publish()`. No
 * HTTP route/API response DTO may call this. Returns `null` when the
 * account has none set (e.g. disconnected) — the caller must not attempt a
 * publish in that case.
 */
export async function fetchSocialAccountTokenReferenceForDispatch(
  tx: Bun.SQL,
  tenantId: string,
  socialAccountId: string
): Promise<{
  providerAccountId: string;
  /**
   * Issue #644 review follow-up (blocking finding): the dispatcher needs
   * this to enforce `SocialProviderAdapter.supportedAccountTypes` right
   * before calling `adapter.publish()` — connect-time validation alone
   * (`validateCreateSocialAccountInput`) only checks the generic 5-value
   * enum, it never cross-checks against whichever adapter is registered
   * for the submitted `providerKey`, so an operator could otherwise
   * connect e.g. `meta_facebook_page`/`providerAccountType: "profile"`
   * and have it actually dispatch.
   */
  providerAccountType: SocialAccountType;
  tokenReference: string | null;
} | null> {
  const rows = (await tx`
    SELECT provider_account_id, provider_account_type, token_reference
    FROM awcms_mini_social_accounts
    WHERE tenant_id = ${tenantId} AND id = ${socialAccountId}
  `) as {
    provider_account_id: string;
    provider_account_type: SocialAccountType;
    token_reference: string | null;
  }[];

  const row = rows[0];

  return row
    ? {
        providerAccountId: row.provider_account_id,
        providerAccountType: row.provider_account_type,
        tokenReference: row.token_reference
      }
    : null;
}

/**
 * INTERNAL ONLY (Issue #646) — see this file's header comment. Used by the
 * admin "verify connection" route to obtain what it needs to call
 * `adapter.verifyCredentials(tokenReference, providerAccountId, ...)`.
 * Returns `null` when the account has no token reference on file (e.g.
 * disconnected) — the caller must not attempt a verification call in that
 * case.
 */
export async function fetchSocialAccountCredentialsForVerification(
  tx: Bun.SQL,
  tenantId: string,
  id: string
): Promise<{
  providerKey: string;
  providerAccountId: string;
  tokenReference: string | null;
  scopes: string[];
} | null> {
  const rows = (await tx`
    SELECT provider_key, provider_account_id, token_reference, scopes_json
    FROM awcms_mini_social_accounts
    WHERE tenant_id = ${tenantId} AND id = ${id}
  `) as {
    provider_key: string;
    provider_account_id: string;
    token_reference: string | null;
    scopes_json: unknown;
  }[];

  const row = rows[0];

  return row
    ? {
        providerKey: row.provider_key,
        providerAccountId: row.provider_account_id,
        tokenReference: row.token_reference,
        scopes: Array.isArray(row.scopes_json)
          ? (row.scopes_json as string[])
          : []
      }
    : null;
}

/**
 * Records the outcome of a "verify connection" admin action (Issue #646).
 * On success, bumps `last_verified_at` and (when the adapter returned
 * `details.permissions`, a `string[]`) replaces `scopes_json` with the
 * discovered permission list — Telegram has no OAuth scopes, so this
 * repurposes the existing generic `scopes_json` column to hold whatever
 * capability list the provider's own check discovered, consistent with the
 * provider-neutral interface's own "no field assumes OAuth vs bot-token
 * auth" design note (`social-provider-adapter.ts`). On failure, does NOT
 * change `connection_status`/`auto_publish_enabled` — a failed verification
 * is informational (surfaced to the admin so they can fix channel
 * permissions and retry), not itself a state transition; only the
 * dispatcher's own real publish attempts flip an account to
 * `needs_reauth` (Issue #643's existing, unrelated mechanism).
 */
export async function recordSocialAccountVerification(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  id: string,
  outcome: { valid: boolean; reason?: string; permissions?: string[] },
  correlationId?: string
): Promise<void> {
  if (outcome.valid) {
    if (outcome.permissions) {
      await tx`
        UPDATE awcms_mini_social_accounts
        SET last_verified_at = now(), scopes_json = ${outcome.permissions}::jsonb,
            updated_at = now()
        WHERE tenant_id = ${tenantId} AND id = ${id}
      `;
    } else {
      await tx`
        UPDATE awcms_mini_social_accounts
        SET last_verified_at = now(), updated_at = now()
        WHERE tenant_id = ${tenantId} AND id = ${id}
      `;
    }
  }

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: outcome.valid
      ? "social_publishing.account.verified"
      : "social_publishing.account.verification_failed",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: id,
    severity: outcome.valid ? "info" : "warning",
    message: outcome.valid
      ? "Social account verified — provider confirmed access to the target."
      : `Social account verification failed: ${outcome.reason ?? "unknown"}.`,
    attributes: outcome.reason ? { reason: outcome.reason } : undefined,
    correlationId
  });
}
