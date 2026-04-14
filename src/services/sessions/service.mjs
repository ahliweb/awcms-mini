import { getDatabase, withTransaction } from "../../db/index.mjs";
import { createSessionRepository } from "../../db/repositories/sessions.mjs";

function createSessionServiceDependencies(executor) {
  return {
    sessions: createSessionRepository(executor),
  };
}

export function createSessionService(options = {}) {
  const database = options.database ?? getDatabase();

  return {
    async issueSession(input) {
      return withTransaction(database, async (trx) => {
        const deps = createSessionServiceDependencies(trx);

        return deps.sessions.createSession({
          ...input,
          trusted_device: input.trusted_device ?? false,
          last_seen_at: input.last_seen_at ?? null,
          revoked_at: input.revoked_at ?? null,
        });
      });
    },

    async refreshSession(sessionId, lastSeenAt) {
      return withTransaction(database, async (trx) => {
        const deps = createSessionServiceDependencies(trx);
        return deps.sessions.updateSessionLastSeen(sessionId, lastSeenAt);
      });
    },

    async revokeSession(sessionId, revokedAt) {
      return withTransaction(database, async (trx) => {
        const deps = createSessionServiceDependencies(trx);
        return deps.sessions.revokeSession(sessionId, revokedAt);
      });
    },

    async revokeAllSessionsForUser(userId, revokedAt) {
      return withTransaction(database, async (trx) => {
        const deps = createSessionServiceDependencies(trx);
        return deps.sessions.revokeAllSessionsForUser(userId, revokedAt);
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
