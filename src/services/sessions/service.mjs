import { getDatabase, withTransaction } from "../../db/index.mjs";
import { createSessionRepository } from "../../db/repositories/sessions.mjs";
import { createAuditService } from "../audit/service.mjs";

function createSessionServiceDependencies(executor) {
  return {
    sessions: createSessionRepository(executor),
    audit: createAuditService({ database: executor }),
  };
}

async function appendSessionAudit(deps, input) {
  await deps.audit.append({
    actor_user_id: input.actor_user_id ?? null,
    action: input.action,
    entity_type: "session",
    entity_id: input.entity_id ?? null,
    target_user_id: input.target_user_id ?? null,
    summary: input.summary,
    before_payload: input.before_payload ?? null,
    after_payload: input.after_payload ?? null,
    metadata: input.metadata ?? {},
  });
}

export function createSessionService(options = {}) {
  const database = options.database ?? getDatabase();

  return {
    async issueSession(input) {
      return withTransaction(database, async (trx) => {
        const deps = createSessionServiceDependencies(trx);

        const session = await deps.sessions.createSession({
          ...input,
          trusted_device: input.trusted_device ?? false,
          last_seen_at: input.last_seen_at ?? null,
          revoked_at: input.revoked_at ?? null,
        });

        await appendSessionAudit(deps, {
          actor_user_id: session.user_id,
          action: "session.issue",
          entity_id: session.id,
          target_user_id: session.user_id,
          summary: "Issued session.",
          after_payload: { trusted_device: session.trusted_device, expires_at: session.expires_at },
        });

        return session;
      });
    },

    async refreshSession(sessionId, lastSeenAt) {
      return withTransaction(database, async (trx) => {
        const deps = createSessionServiceDependencies(trx);
        const session = await deps.sessions.getSessionById(sessionId);

        if (!session || session.revoked_at) {
          return undefined;
        }

        return deps.sessions.updateSessionLastSeen(sessionId, lastSeenAt);
      });
    },

    async getSession(sessionId) {
      return withTransaction(database, async (trx) => {
        const deps = createSessionServiceDependencies(trx);
        return deps.sessions.getSessionById(sessionId);
      });
    },

    async revokeSession(sessionId, revokedAt) {
      return withTransaction(database, async (trx) => {
        const deps = createSessionServiceDependencies(trx);
        const before = await deps.sessions.getSessionById(sessionId);
        const session = await deps.sessions.revokeSession(sessionId, revokedAt);

        if (session) {
          await appendSessionAudit(deps, {
            actor_user_id: session.user_id,
            action: "session.revoke",
            entity_id: session.id,
            target_user_id: session.user_id,
            summary: "Revoked session.",
            before_payload: { revoked_at: before?.revoked_at ?? null },
            after_payload: { revoked_at: session.revoked_at ?? null },
          });
        }

        return session;
      });
    },

    async revokeAllSessionsForUser(userId, revokedAt) {
      return withTransaction(database, async (trx) => {
        const deps = createSessionServiceDependencies(trx);
        const sessions = await deps.sessions.revokeAllSessionsForUser(userId, revokedAt);

        await appendSessionAudit(deps, {
          actor_user_id: userId,
          action: "session.revoke_all",
          entity_id: userId,
          target_user_id: userId,
          summary: "Revoked all sessions for user.",
          after_payload: { revoked_at: revokedAt ?? null, session_count: sessions.length },
        });

        return sessions;
      });
    },

    async listActiveSessions(userId, options = {}) {
      return withTransaction(database, async (trx) => {
        const deps = createSessionServiceDependencies(trx);
        return deps.sessions.listSessionsByUserId(userId, {
          includeRevoked: false,
          limit: options.limit,
          offset: options.offset,
        });
      });
    },
  };
}
