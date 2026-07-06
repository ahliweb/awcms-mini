/**
 * Password reset application logic (Issue #496, epic #492) — the first
 * real caller that enqueues into `awcms_mini_email_messages` (`sql/020`).
 * Reuses identity/session/sensitive-data patterns rather than rebuilding
 * auth: `login.ts`'s tenant/identity/tenant_user active checks,
 * `session-token.ts`'s token shape (via `password-reset-token.ts`'s twin
 * `generateResetToken`/`hashResetToken`), and
 * `profile-identity/domain/identifier.ts`'s normalize/hash/mask pipeline
 * for the recipient address.
 *
 * Both functions are account-enumeration-safe by construction:
 * `requestPasswordReset` returns `{ enqueued: false }` for every ineligible
 * case (unknown identifier, inactive identity/tenant/tenant_user) with the
 * exact same shape as the eligible-but-not-yet-sent case — the caller
 * (the endpoint) always responds with the same generic message regardless
 * of this result, per issue #496 "response text and timing must not
 * reveal whether an email exists."
 */
import { hashPassword } from "../../../lib/auth/password";
import {
  generateResetToken,
  hashResetToken
} from "../../../lib/auth/password-reset-token";
import {
  hashIdentifier,
  maskIdentifier,
  normalizeIdentifier
} from "../../profile-identity/domain/identifier";
import {
  evaluatePasswordResetToken,
  type PasswordResetDenyReason
} from "../domain/password-reset-policy";
import { revokeAllSessionsForIdentity } from "./session-revocation";

export type RequestPasswordResetOptions = {
  tokenTtlMinutes: number;
  /** Base URL the raw token is appended to as `?token=<raw>`, e.g. `${APP_URL}/reset-password`. */
  resetUrlBase: string;
};

export type RequestPasswordResetResult = {
  enqueued: boolean;
  identityId?: string;
};

export async function requestPasswordReset(
  tx: Bun.SQL,
  tenantId: string,
  loginIdentifier: string,
  now: Date,
  options: RequestPasswordResetOptions
): Promise<RequestPasswordResetResult> {
  const tenantRows = await tx`
    SELECT status FROM awcms_mini_tenants WHERE id = ${tenantId}
  `;
  const tenantStatus = (tenantRows[0]?.status as string | undefined) ?? null;

  if (tenantStatus !== "active") {
    return { enqueued: false };
  }

  const identityRows = (await tx`
    SELECT i.id, i.status, p.display_name
    FROM awcms_mini_identities i
    JOIN awcms_mini_profiles p ON p.id = i.profile_id
    WHERE i.tenant_id = ${tenantId} AND i.login_identifier = ${loginIdentifier}
  `) as { id: string; status: string; display_name: string }[];
  const identity = identityRows[0];

  if (!identity || identity.status !== "active") {
    return { enqueued: false };
  }

  const tenantUserRows = (await tx`
    SELECT status FROM awcms_mini_tenant_users
    WHERE tenant_id = ${tenantId} AND identity_id = ${identity.id}
  `) as { status: string }[];

  if (tenantUserRows[0]?.status !== "active") {
    return { enqueued: false };
  }

  // Supersede any still-outstanding tokens — only the newest request's
  // link is ever valid, so a user who clicks "forgot password" twice
  // can't leave two simultaneously-live reset links.
  await tx`
    UPDATE awcms_mini_password_reset_tokens
    SET used_at = ${now}
    WHERE tenant_id = ${tenantId} AND identity_id = ${identity.id} AND used_at IS NULL
  `;

  const rawToken = generateResetToken();
  const tokenHash = hashResetToken(rawToken);
  const expiresAt = new Date(now.getTime() + options.tokenTtlMinutes * 60_000);

  await tx`
    INSERT INTO awcms_mini_password_reset_tokens (tenant_id, identity_id, token_hash, expires_at)
    VALUES (${tenantId}, ${identity.id}, ${tokenHash}, ${expiresAt})
  `;

  const normalizedEmail = normalizeIdentifier("email", loginIdentifier);
  const resetUrl = `${options.resetUrlBase}?token=${rawToken}`;

  await tx`
    INSERT INTO awcms_mini_email_messages
      (tenant_id, category, template_key, to_address, to_address_hash,
       to_address_masked, subject, variables, priority)
    VALUES (
      ${tenantId}, 'auth.password_reset', 'auth.password_reset',
      ${normalizedEmail}, ${hashIdentifier(normalizedEmail)},
      ${maskIdentifier("email", normalizedEmail)}, 'Reset your password',
      ${{
        userName: identity.display_name,
        resetUrl,
        expiresInMinutes: String(options.tokenTtlMinutes)
      }},
      'high'
    )
  `;

  return { enqueued: true, identityId: identity.id };
}

export type CompletePasswordResetResult =
  | { outcome: "success"; identityId: string }
  | { outcome: "invalid"; reason: PasswordResetDenyReason };

export async function completePasswordReset(
  tx: Bun.SQL,
  tenantId: string,
  rawToken: string,
  newPassword: string,
  now: Date
): Promise<CompletePasswordResetResult> {
  const tokenHash = hashResetToken(rawToken);

  const tokenRows = (await tx`
    SELECT id, identity_id, expires_at, used_at
    FROM awcms_mini_password_reset_tokens
    WHERE tenant_id = ${tenantId} AND token_hash = ${tokenHash}
  `) as {
    id: string;
    identity_id: string;
    expires_at: Date;
    used_at: Date | null;
  }[];
  const tokenRow = tokenRows[0];

  const evaluation = evaluatePasswordResetToken(
    tokenRow
      ? { expiresAt: new Date(tokenRow.expires_at), usedAt: tokenRow.used_at }
      : null,
    now
  );

  if (evaluation.outcome === "invalid") {
    return { outcome: "invalid", reason: evaluation.reason };
  }

  const identityRows = (await tx`
    SELECT id, status FROM awcms_mini_identities
    WHERE tenant_id = ${tenantId} AND id = ${tokenRow!.identity_id}
  `) as { id: string; status: string }[];
  const identity = identityRows[0];

  if (!identity || identity.status !== "active") {
    return { outcome: "invalid", reason: "not_found" };
  }

  const passwordHash = await hashPassword(newPassword);

  await tx`
    UPDATE awcms_mini_identities
    SET password_hash = ${passwordHash}, failed_login_count = 0,
        locked_until = NULL, updated_at = ${now}
    WHERE id = ${identity.id}
  `;

  await tx`
    UPDATE awcms_mini_password_reset_tokens
    SET used_at = ${now}
    WHERE id = ${tokenRow!.id}
  `;

  await revokeAllSessionsForIdentity(tx, tenantId, identity.id, now);

  return { outcome: "success", identityId: identity.id };
}
