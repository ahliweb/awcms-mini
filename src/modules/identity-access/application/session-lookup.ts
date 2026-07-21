export type ActiveSession = {
  id: string;
  tenant_id: string;
  identity_id: string;
  /**
   * Issue #879 — the session's strong-assurance timestamp (sql/098 adds the
   * column, DEFAULT now() at insert). Used by the step-up chokepoint. Older
   * sessions predating the column are backfilled to their creation instant by
   * the migration, so this is always present.
   */
  assurance_at: Date;
};

export async function resolveActiveSession(
  tx: Bun.SQL,
  tenantId: string,
  tokenHash: string,
  now: Date
): Promise<ActiveSession | null> {
  const rows = await tx`
    SELECT id, tenant_id, identity_id, expires_at, revoked_at, assurance_at
    FROM awcms_mini_sessions
    WHERE tenant_id = ${tenantId} AND token_hash = ${tokenHash}
  `;
  const session = rows[0] as
    | {
        id: string;
        tenant_id: string;
        identity_id: string;
        expires_at: Date;
        revoked_at: Date | null;
        assurance_at: Date;
      }
    | undefined;

  if (!session) {
    return null;
  }

  if (session.revoked_at) {
    return null;
  }

  if (new Date(session.expires_at).getTime() <= now.getTime()) {
    return null;
  }

  return {
    id: session.id,
    tenant_id: session.tenant_id,
    identity_id: session.identity_id,
    assurance_at: session.assurance_at
  };
}

export function extractBearerToken(
  authorizationHeader: string | null
): string | null {
  if (!authorizationHeader) {
    return null;
  }

  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());

  return match?.[1] ?? null;
}
