import { sql } from "kysely";

import { getDatabase } from "../index.mjs";

const TOTP_CREDENTIAL_COLUMNS = [
  "id",
  "user_id",
  "secret_encrypted",
  "issuer",
  "label",
  "verified_at",
  "last_used_at",
  "disabled_at",
  "created_at",
];

function baseTotpCredentialQuery(executor) {
  return executor.selectFrom("totp_credentials").select(TOTP_CREDENTIAL_COLUMNS);
}

export function createTotpCredentialRepository(executor = getDatabase()) {
  return {
    async createTotpCredential(input) {
      await executor.insertInto("totp_credentials").values({
        id: input.id,
        user_id: input.user_id,
        secret_encrypted: input.secret_encrypted,
        issuer: input.issuer,
        label: input.label,
        verified_at: input.verified_at ?? null,
        last_used_at: input.last_used_at ?? null,
        disabled_at: input.disabled_at ?? null,
      }).execute();

      return this.getTotpCredentialById(input.id);
    },

    async getTotpCredentialById(id) {
      return baseTotpCredentialQuery(executor).where("id", "=", id).executeTakeFirst();
    },

    async getActiveTotpCredentialByUserId(userId) {
      return baseTotpCredentialQuery(executor)
        .where("user_id", "=", userId)
        .where("disabled_at", "is", null)
        .executeTakeFirst();
    },

    async updateTotpCredential(id, patch) {
      const values = {};
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) {
          values[key] = value;
        }
      }

      if (Object.keys(values).length === 0) {
        return this.getTotpCredentialById(id);
      }

      await executor.updateTable("totp_credentials").set(values).where("id", "=", id).execute();
      return this.getTotpCredentialById(id);
    },

    async disableActiveTotpCredentialsForUser(userId, disabledAt) {
      await executor
        .updateTable("totp_credentials")
        .set({ disabled_at: disabledAt ?? sql`CURRENT_TIMESTAMP` })
        .where("user_id", "=", userId)
        .where("disabled_at", "is", null)
        .execute();
    },
  };
}

export { TOTP_CREDENTIAL_COLUMNS };
