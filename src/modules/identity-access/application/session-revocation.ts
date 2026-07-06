/**
 * Bulk session revocation (Issue #496) — mirrors `logout.ts`'s single-session
 * `revoked_at` update, extended to every active session of one identity.
 * Used after a completed password reset ("invalidate relevant sessions
 * after password reset", issue #496 §Security requirements) so a stolen
 * session cannot outlive a credential change.
 */
export async function revokeAllSessionsForIdentity(
  tx: Bun.SQL,
  tenantId: string,
  identityId: string,
  now: Date
): Promise<void> {
  await tx`
    UPDATE awcms_mini_sessions
    SET revoked_at = ${now}
    WHERE tenant_id = ${tenantId} AND identity_id = ${identityId}
      AND revoked_at IS NULL
  `;
}
