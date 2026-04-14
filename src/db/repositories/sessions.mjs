import { sql } from "kysely";

import { getDatabase } from "../index.mjs";

const SESSION_COLUMNS = [
  "id",
  "user_id",
  "session_token_hash",
  "ip_address",
  "user_agent",
  "trusted_device",
  "last_seen_at",
  "expires_at",
  "revoked_at",
  "created_at",
];

function normalizeBoolean(value) {
  if (value === null || value === undefined) {
    return value;
  }

  return Boolean(value);
}

function normalizeSession(row) {
  if (!row) {
    return undefined;
  }

  return {
    ...row,
    trusted_device: normalizeBoolean(row.trusted_device),
  };
}

function baseSessionQuery(executor) {
  return executor.selectFrom("sessions").select(SESSION_COLUMNS);
}

export function createSessionRepository(executor = getDatabase()) {
  return {
    async createSession(input) {
      await executor
        .insertInto("sessions")
        .values({
          id: input.id,
          user_id: input.user_id,
          session_token_hash: input.session_token_hash,
          ip_address: input.ip_address ?? null,
          user_agent: input.user_agent ?? null,
          trusted_device: input.trusted_device ?? false,
          last_seen_at: input.last_seen_at ?? null,
          expires_at: input.expires_at,
          revoked_at: input.revoked_at ?? null,
        })
        .execute();

      return this.getSessionById(input.id);
    },

    async getSessionById(id) {
      const row = await baseSessionQuery(executor).where("id", "=", id).executeTakeFirst();
      return normalizeSession(row);
    },

    async getSessionByTokenHash(sessionTokenHash) {
      const row = await baseSessionQuery(executor)
        .where("session_token_hash", "=", sessionTokenHash)
        .executeTakeFirst();

      return normalizeSession(row);
    },

    async listSessionsByUserId(userId, options = {}) {
      let query = baseSessionQuery(executor)
        .where("user_id", "=", userId)
        .orderBy("created_at", "desc")
        .orderBy("id", "asc");

      if (options.includeRevoked !== true) {
        query = query.where("revoked_at", "is", null);
      }

      if (options.limit !== undefined) {
        query = query.limit(options.limit);
      }

      if (options.offset !== undefined) {
        query = query.offset(options.offset);
      }

      const rows = await query.execute();
      return rows.map(normalizeSession);
    },

    async updateSessionLastSeen(id, lastSeenAt) {
      await executor
        .updateTable("sessions")
        .set({
          last_seen_at: lastSeenAt,
        })
        .where("id", "=", id)
        .execute();

      return this.getSessionById(id);
    },

    async revokeSession(id, revokedAt = sql`CURRENT_TIMESTAMP`) {
      await executor
        .updateTable("sessions")
        .set({
          revoked_at: revokedAt,
        })
        .where("id", "=", id)
        .execute();

      return this.getSessionById(id);
    },

    async revokeAllSessionsForUser(userId, revokedAt = sql`CURRENT_TIMESTAMP`) {
      await executor
        .updateTable("sessions")
        .set({
          revoked_at: revokedAt,
        })
        .where("user_id", "=", userId)
        .where("revoked_at", "is", null)
        .execute();

      return this.listSessionsByUserId(userId, { includeRevoked: true });
    },
  };
}

export { SESSION_COLUMNS, normalizeSession };
