import { sql } from "kysely";

import { getDatabase } from "../index.mjs";

const PASSWORD_RESET_TOKEN_COLUMNS = [
  "id",
  "user_id",
  "token_hash",
  "expires_at",
  "used_at",
  "issued_by_user_id",
  "created_at",
];

function basePasswordResetTokenQuery(executor) {
  return executor.selectFrom("password_reset_tokens").select(PASSWORD_RESET_TOKEN_COLUMNS);
}

export function createPasswordResetTokenRepository(executor = getDatabase()) {
  return {
    async createPasswordResetToken(input) {
      await executor.insertInto("password_reset_tokens").values({
        id: input.id,
        user_id: input.user_id,
        token_hash: input.token_hash,
        expires_at: input.expires_at,
        used_at: input.used_at ?? null,
        issued_by_user_id: input.issued_by_user_id ?? null,
      }).execute();

      return this.getPasswordResetTokenById(input.id);
    },

    async getPasswordResetTokenById(id) {
      return basePasswordResetTokenQuery(executor).where("id", "=", id).executeTakeFirst();
    },

    async listPasswordResetTokensByUserId(userId) {
      return basePasswordResetTokenQuery(executor)
        .where("user_id", "=", userId)
        .orderBy("created_at", "desc")
        .orderBy("id", "asc")
        .execute();
    },

    async markPasswordResetTokenUsed(id, usedAt = sql`CURRENT_TIMESTAMP`) {
      await executor
        .updateTable("password_reset_tokens")
        .set({ used_at: usedAt })
        .where("id", "=", id)
        .where("used_at", "is", null)
        .execute();

      return this.getPasswordResetTokenById(id);
    },
  };
}

export { PASSWORD_RESET_TOKEN_COLUMNS };
