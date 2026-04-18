import { sql } from "kysely";

import { getDatabase } from "../index.mjs";

const EDGE_API_REFRESH_TOKEN_COLUMNS = [
  "id",
  "session_id",
  "user_id",
  "token_hash",
  "session_strength",
  "two_factor_satisfied",
  "expires_at",
  "used_at",
  "revoked_at",
  "replaced_by_token_id",
  "created_at",
];

function baseEdgeApiRefreshTokenQuery(executor) {
  return executor.selectFrom("edge_api_refresh_tokens").select(EDGE_API_REFRESH_TOKEN_COLUMNS);
}

export function createEdgeApiRefreshTokenRepository(executor = getDatabase()) {
  return {
    async createRefreshToken(input) {
      await executor
        .insertInto("edge_api_refresh_tokens")
        .values({
          id: input.id,
          session_id: input.session_id,
          user_id: input.user_id,
          token_hash: input.token_hash,
          session_strength: input.session_strength,
          two_factor_satisfied: input.two_factor_satisfied ?? false,
          expires_at: input.expires_at,
          used_at: input.used_at ?? null,
          revoked_at: input.revoked_at ?? null,
          replaced_by_token_id: input.replaced_by_token_id ?? null,
        })
        .execute();

      return this.getRefreshTokenById(input.id);
    },

    async getRefreshTokenById(id) {
      return baseEdgeApiRefreshTokenQuery(executor).where("id", "=", id).executeTakeFirst();
    },

    async markRefreshTokenRotated(id, { usedAt = sql`CURRENT_TIMESTAMP`, replacedByTokenId = null } = {}) {
      await executor
        .updateTable("edge_api_refresh_tokens")
        .set({
          used_at: usedAt,
          replaced_by_token_id: replacedByTokenId,
        })
        .where("id", "=", id)
        .execute();

      return this.getRefreshTokenById(id);
    },

    async revokeRefreshTokensBySessionId(sessionId, revokedAt = sql`CURRENT_TIMESTAMP`) {
      await executor
        .updateTable("edge_api_refresh_tokens")
        .set({ revoked_at: revokedAt })
        .where("session_id", "=", sessionId)
        .where("revoked_at", "is", null)
        .execute();

      return this.listRefreshTokensBySessionId(sessionId);
    },

    async listRefreshTokensBySessionId(sessionId) {
      return baseEdgeApiRefreshTokenQuery(executor)
        .where("session_id", "=", sessionId)
        .orderBy("created_at", "desc")
        .orderBy("id", "asc")
        .execute();
    },
  };
}

export { EDGE_API_REFRESH_TOKEN_COLUMNS };
