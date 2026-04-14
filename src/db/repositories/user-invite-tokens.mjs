import { sql } from "kysely";

import { getDatabase } from "../index.mjs";

const USER_INVITE_TOKEN_COLUMNS = [
  "id",
  "user_id",
  "token_hash",
  "created_by_user_id",
  "expires_at",
  "consumed_at",
  "revoked_at",
  "created_at",
];

function normalizeInviteToken(row) {
  if (!row) {
    return undefined;
  }

  return row;
}

function baseInviteTokenQuery(executor) {
  return executor.selectFrom("user_invite_tokens").select(USER_INVITE_TOKEN_COLUMNS);
}

export function createUserInviteTokenRepository(executor = getDatabase()) {
  return {
    async createInviteToken(input) {
      await executor
        .insertInto("user_invite_tokens")
        .values({
          id: input.id,
          user_id: input.user_id,
          token_hash: input.token_hash,
          created_by_user_id: input.created_by_user_id ?? null,
          expires_at: input.expires_at,
          consumed_at: input.consumed_at ?? null,
          revoked_at: input.revoked_at ?? null,
        })
        .execute();

      return this.getInviteTokenById(input.id);
    },

    async getInviteTokenById(id) {
      const row = await baseInviteTokenQuery(executor).where("id", "=", id).executeTakeFirst();
      return normalizeInviteToken(row);
    },

    async revokeActiveTokensForUser(userId, revokedAt = sql`CURRENT_TIMESTAMP`) {
      await executor
        .updateTable("user_invite_tokens")
        .set({
          revoked_at: revokedAt,
        })
        .where("user_id", "=", userId)
        .where("consumed_at", "is", null)
        .where("revoked_at", "is", null)
        .execute();

      return this.listInviteTokensByUserId(userId);
    },

    async consumeInviteToken(id, consumedAt = sql`CURRENT_TIMESTAMP`) {
      await executor
        .updateTable("user_invite_tokens")
        .set({
          consumed_at: consumedAt,
        })
        .where("id", "=", id)
        .where("consumed_at", "is", null)
        .where("revoked_at", "is", null)
        .execute();

      return this.getInviteTokenById(id);
    },

    async listInviteTokensByUserId(userId) {
      const rows = await baseInviteTokenQuery(executor)
        .where("user_id", "=", userId)
        .orderBy("created_at", "desc")
        .orderBy("id", "asc")
        .execute();

      return rows.map(normalizeInviteToken);
    },
  };
}

export { USER_INVITE_TOKEN_COLUMNS, normalizeInviteToken };
