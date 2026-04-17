import { getDatabase } from "../index.mjs";

const RECOVERY_CODE_COLUMNS = ["id", "user_id", "code_hash", "used_at", "created_at", "replaced_at"];

function baseRecoveryCodeQuery(executor) {
  return executor.selectFrom("recovery_codes").select(RECOVERY_CODE_COLUMNS);
}

export function createRecoveryCodeRepository(executor = getDatabase()) {
  return {
    async createRecoveryCodes(inputs) {
      await executor.insertInto("recovery_codes").values(inputs.map((input) => ({
        id: input.id,
        user_id: input.user_id,
        code_hash: input.code_hash,
        used_at: input.used_at ?? null,
        created_at: input.created_at ?? undefined,
        replaced_at: input.replaced_at ?? null,
      }))).execute();

      return this.listRecoveryCodesByUserId(inputs[0]?.user_id ?? "", { includeReplaced: true });
    },

    async listRecoveryCodesByUserId(userId, options = {}) {
      let query = baseRecoveryCodeQuery(executor).where("user_id", "=", userId).orderBy("created_at", "desc").orderBy("id", "asc");

      if (options.unusedOnly === true) {
        query = query.where("used_at", "is", null);
      }

      if (options.includeReplaced !== true) {
        query = query.where("replaced_at", "is", null);
      }

      return query.execute();
    },

    async replaceActiveRecoveryCodesForUser(userId, replacedAt) {
      await executor
        .updateTable("recovery_codes")
        .set({ replaced_at: replacedAt })
        .where("user_id", "=", userId)
        .where("replaced_at", "is", null)
        .execute();
    },
  };
}

export { RECOVERY_CODE_COLUMNS };
