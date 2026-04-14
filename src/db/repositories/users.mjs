import { sql } from "kysely";

import { getDatabase } from "../index.mjs";

const USER_COLUMNS = [
  "id",
  "email",
  "username",
  "display_name",
  "password_hash",
  "status",
  "last_login_at",
  "must_reset_password",
  "is_protected",
  "created_at",
  "updated_at",
];

const MUTABLE_USER_FIELDS = new Set([
  "email",
  "username",
  "display_name",
  "password_hash",
  "last_login_at",
  "must_reset_password",
  "is_protected",
]);

function normalizeBoolean(value) {
  if (value === null || value === undefined) {
    return value;
  }

  return Boolean(value);
}

function normalizeUser(row) {
  if (!row) {
    return undefined;
  }

  return {
    ...row,
    must_reset_password: normalizeBoolean(row.must_reset_password),
    is_protected: normalizeBoolean(row.is_protected),
  };
}

function buildUserPatch(patch) {
  const values = {};

  for (const [key, value] of Object.entries(patch)) {
    if (MUTABLE_USER_FIELDS.has(key) && value !== undefined) {
      values[key] = value;
    }
  }

  if (Object.keys(values).length === 0) {
    return undefined;
  }

  values.updated_at = sql`CURRENT_TIMESTAMP`;

  return values;
}

function baseUserQuery(executor) {
  return executor.selectFrom("users").select(USER_COLUMNS);
}

export function createUserRepository(executor = getDatabase()) {
  return {
    async createUser(input) {
      await executor
        .insertInto("users")
        .values({
          id: input.id,
          email: input.email,
          username: input.username ?? null,
          display_name: input.display_name ?? null,
          password_hash: input.password_hash ?? null,
          status: input.status ?? "invited",
          last_login_at: input.last_login_at ?? null,
          must_reset_password: input.must_reset_password ?? false,
          is_protected: input.is_protected ?? false,
        })
        .execute();

      return this.getUserById(input.id);
    },

    async getUserById(id) {
      const row = await baseUserQuery(executor).where("id", "=", id).executeTakeFirst();
      return normalizeUser(row);
    },

    async getUserByEmail(email) {
      const row = await baseUserQuery(executor).where("email", "=", email).executeTakeFirst();
      return normalizeUser(row);
    },

    async listUsers(options = {}) {
      let query = baseUserQuery(executor).orderBy("created_at", "desc").orderBy("email", "asc");

      if (options.status) {
        query = query.where("status", "=", options.status);
      }

      if (options.limit !== undefined) {
        query = query.limit(options.limit);
      }

      if (options.offset !== undefined) {
        query = query.offset(options.offset);
      }

      const rows = await query.execute();
      return rows.map(normalizeUser);
    },

    async updateUser(id, patch) {
      const values = buildUserPatch(patch);

      if (!values) {
        return this.getUserById(id);
      }

      await executor.updateTable("users").set(values).where("id", "=", id).execute();
      return this.getUserById(id);
    },

    async changeUserStatus(id, status) {
      await executor
        .updateTable("users")
        .set({
          status,
          updated_at: sql`CURRENT_TIMESTAMP`,
        })
        .where("id", "=", id)
        .execute();

      return this.getUserById(id);
    },
  };
}

export { USER_COLUMNS, buildUserPatch, normalizeUser };
