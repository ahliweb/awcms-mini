import { getDatabase, withTransaction } from "../../db/index.mjs";
import { createLoginSecurityEventRepository } from "../../db/repositories/login-security-events.mjs";
import { createSessionRepository } from "../../db/repositories/sessions.mjs";
import { createUserRepository } from "../../db/repositories/users.mjs";

function createUserServiceDependencies(executor) {
  return {
    users: createUserRepository(executor),
    sessions: createSessionRepository(executor),
    loginSecurityEvents: createLoginSecurityEventRepository(executor),
  };
}

export function createUserService(options = {}) {
  const database = options.database ?? getDatabase();

  return {
    async createUser(input) {
      return withTransaction(database, async (trx) => {
        const deps = createUserServiceDependencies(trx);

        return deps.users.createUser({
          ...input,
          status: input.status ?? "active",
          must_reset_password: input.must_reset_password ?? false,
          is_protected: input.is_protected ?? false,
          email_verified: input.email_verified ?? true,
        });
      });
    },

    async inviteUser(input) {
      return withTransaction(database, async (trx) => {
        const deps = createUserServiceDependencies(trx);

        return deps.users.createUser({
          ...input,
          status: "invited",
          must_reset_password: input.must_reset_password ?? true,
          is_protected: input.is_protected ?? false,
          email_verified: false,
        });
      });
    },

    async activateUser(userId) {
      return withTransaction(database, async (trx) => {
        const deps = createUserServiceDependencies(trx);
        return deps.users.changeUserStatus(userId, "active");
      });
    },

    async disableUser(userId, options = {}) {
      return withTransaction(database, async (trx) => {
        const deps = createUserServiceDependencies(trx);

        const user = await deps.users.changeUserStatus(userId, "disabled");

        if (options.revokeSessions !== false) {
          await deps.sessions.revokeAllSessionsForUser(userId);
        }

        return user;
      });
    },

    async lockUser(userId, options = {}) {
      return withTransaction(database, async (trx) => {
        const deps = createUserServiceDependencies(trx);

        const user = await deps.users.changeUserStatus(userId, "locked");

        if (options.revokeSessions !== false) {
          await deps.sessions.revokeAllSessionsForUser(userId);
        }

        return user;
      });
    },

    async updateProfile(userId, profileInput) {
      return withTransaction(database, async (trx) => {
        const deps = createUserServiceDependencies(trx);

        return deps.users.updateUser(userId, {
          display_name: profileInput.display_name,
        });
      });
    },

    async softDeleteUser(userId, options = {}) {
      return withTransaction(database, async (trx) => {
        const deps = createUserServiceDependencies(trx);

        const user = await deps.users.softDeleteUser(userId, {
          deleted_by_user_id: options.deleted_by_user_id,
          delete_reason: options.delete_reason,
          deleted_at: options.deleted_at,
        });

        if (options.revokeSessions !== false) {
          await deps.sessions.revokeAllSessionsForUser(userId);
        }

        return user;
      });
    },

    async restoreUser(userId, options = {}) {
      return withTransaction(database, async (trx) => {
        const deps = createUserServiceDependencies(trx);
        return deps.users.restoreUser(userId, { status: options.status });
      });
    },
  };
}
