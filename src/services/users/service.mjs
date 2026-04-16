import { getDatabase, withTransaction } from "../../db/index.mjs";
import { createLoginSecurityEventRepository } from "../../db/repositories/login-security-events.mjs";
import { createSessionRepository } from "../../db/repositories/sessions.mjs";
import { createUserInviteTokenRepository } from "../../db/repositories/user-invite-tokens.mjs";
import { createUserRepository } from "../../db/repositories/users.mjs";
import { createAuditService } from "../audit/service.mjs";
import { hashPassword, verifyPassword } from "../../auth/passwords.mjs";

const INVITE_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 7;

function createUserServiceDependencies(executor) {
  return {
    users: createUserRepository(executor),
    sessions: createSessionRepository(executor),
    loginSecurityEvents: createLoginSecurityEventRepository(executor),
    inviteTokens: createUserInviteTokenRepository(executor),
    audit: createAuditService({ database: executor }),
  };
}

async function appendUserAudit(deps, input) {
  await deps.audit.append({
    actor_user_id: input.actor_user_id ?? null,
    action: input.action,
    entity_type: input.entity_type ?? "user",
    entity_id: input.entity_id ?? null,
    target_user_id: input.target_user_id ?? null,
    summary: input.summary,
    before_payload: input.before_payload ?? null,
    after_payload: input.after_payload ?? null,
    metadata: input.metadata ?? {},
    occurred_at: input.occurred_at ?? undefined,
  });
}

function createInviteTokenValue() {
  const id = crypto.randomUUID();
  const secret = crypto.randomUUID();

  return {
    id,
    secret,
    value: `${id}.${secret}`,
  };
}

function parseInviteToken(token) {
  if (typeof token !== "string") {
    return null;
  }

  const trimmed = token.trim();
  const separator = trimmed.indexOf(".");

  if (separator <= 0 || separator === trimmed.length - 1) {
    return null;
  }

  return {
    id: trimmed.slice(0, separator),
    secret: trimmed.slice(separator + 1),
    value: trimmed,
  };
}

function isExpired(timestamp, now = Date.now()) {
  return Date.parse(timestamp) <= now;
}

async function resolveInviteActivation(deps, token) {
  const parsedToken = parseInviteToken(token);

  if (!parsedToken) {
    throw new UserInviteError("INVALID_TOKEN", "Activation token is invalid.");
  }

  const inviteToken = await deps.inviteTokens.getInviteTokenById(parsedToken.id);

  if (!inviteToken || inviteToken.revoked_at || inviteToken.consumed_at) {
    throw new UserInviteError("INVALID_TOKEN", "Activation token is invalid.");
  }

  if (isExpired(inviteToken.expires_at)) {
    throw new UserInviteError("EXPIRED_TOKEN", "Activation token has expired.");
  }

  if (!verifyPassword(parsedToken.secret, inviteToken.token_hash)) {
    throw new UserInviteError("INVALID_TOKEN", "Activation token is invalid.");
  }

  const user = await deps.users.getUserById(inviteToken.user_id, { includeDeleted: true });

  if (!user || user.deleted_at || user.status === "deleted") {
    throw new UserInviteError("INVALID_USER", "Invited account is not available.");
  }

  if (user.status !== "invited") {
    throw new UserInviteError("ALREADY_ACTIVE", "Account is no longer awaiting activation.");
  }

  return {
    parsedToken,
    expires_at: inviteToken.expires_at,
    inviteToken,
    user,
  };
}

export class UserInviteError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "UserInviteError";
    this.code = code;
  }
}

export function createUserService(options = {}) {
  const database = options.database ?? getDatabase();

  return {
    async createUser(input) {
      return withTransaction(database, async (trx) => {
        const deps = createUserServiceDependencies(trx);

        const user = await deps.users.createUser({
          ...input,
          status: input.status ?? "active",
          must_reset_password: input.must_reset_password ?? false,
          is_protected: input.is_protected ?? false,
          email_verified: input.email_verified ?? true,
        });

        await appendUserAudit(deps, {
          actor_user_id: input.created_by_user_id ?? null,
          action: "user.create",
          entity_id: user.id,
          target_user_id: user.id,
          summary: "Created user account.",
          after_payload: { status: user.status, email: user.email },
        });

        return user;
      });
    },

    async inviteUser(input) {
      return withTransaction(database, async (trx) => {
        const deps = createUserServiceDependencies(trx);

        const user = await deps.users.createUser({
          ...input,
          status: "invited",
          must_reset_password: input.must_reset_password ?? true,
          is_protected: input.is_protected ?? false,
          email_verified: false,
        });

        await appendUserAudit(deps, {
          actor_user_id: input.created_by_user_id ?? null,
          action: "user.invite.prepare",
          entity_id: user.id,
          target_user_id: user.id,
          summary: "Prepared invited user account.",
          after_payload: { status: user.status, email: user.email },
        });

        return user;
      });
    },

    async createInvite(input) {
      return withTransaction(database, async (trx) => {
        const deps = createUserServiceDependencies(trx);
        const userId = input.id ?? crypto.randomUUID();
        const inviteToken = createInviteTokenValue();
        const expiresAt = new Date(Date.now() + (input.ttlMs ?? INVITE_TOKEN_TTL_MS)).toISOString();

        const user = await deps.users.createUser({
          id: userId,
          email: input.email,
          username: input.username,
          display_name: input.display_name,
          name: input.display_name,
          status: "invited",
          password_hash: null,
          must_reset_password: true,
          is_protected: input.is_protected ?? false,
          email_verified: false,
          role: input.role,
          avatar_url: input.avatar_url,
          data: input.data,
        });

        await deps.inviteTokens.revokeActiveTokensForUser(user.id);

        await deps.inviteTokens.createInviteToken({
          id: inviteToken.id,
          user_id: user.id,
          token_hash: hashPassword(inviteToken.secret),
          created_by_user_id: input.created_by_user_id ?? null,
          expires_at: expiresAt,
        });

        const invite = {
          user,
          token: inviteToken.value,
          expires_at: expiresAt,
        };

        await appendUserAudit(deps, {
          actor_user_id: input.created_by_user_id ?? null,
          action: "user.invite.create",
          entity_id: user.id,
          target_user_id: user.id,
          summary: "Created activation invite.",
          after_payload: { status: user.status, expires_at: expiresAt },
        });

        return invite;
      });
    },

    async getInviteActivation(token) {
      return withTransaction(database, async (trx) => {
        const deps = createUserServiceDependencies(trx);
        const activation = await resolveInviteActivation(deps, token);

        return {
          token: activation.parsedToken.value,
          expires_at: activation.expires_at,
          user: activation.user,
        };
      });
    },

    async activateUser(userId) {
      return withTransaction(database, async (trx) => {
        const deps = createUserServiceDependencies(trx);
        const before = await deps.users.getUserById(userId, { includeDeleted: true });
        const user = await deps.users.changeUserStatus(userId, "active");

        await appendUserAudit(deps, {
          action: "user.activate",
          entity_id: user.id,
          target_user_id: user.id,
          summary: "Activated user account.",
          before_payload: { status: before?.status ?? null },
          after_payload: { status: user.status },
        });

        return user;
      });
    },

    async activateInvite(input) {
      return withTransaction(database, async (trx) => {
        const deps = createUserServiceDependencies(trx);
        const activation = await resolveInviteActivation(deps, input.token);

        const displayName = typeof input.display_name === "string" ? input.display_name.trim() : "";
        const password = typeof input.password === "string" ? input.password : "";

        if (password.length < 8) {
          throw new UserInviteError("INVALID_PASSWORD", "Password must be at least 8 characters.");
        }

        const updatedUser = await deps.users.updateUser(activation.user.id, {
          password_hash: hashPassword(password),
          display_name: displayName || activation.user.display_name,
          name: displayName || activation.user.name || activation.user.display_name,
          must_reset_password: false,
          email_verified: true,
        });

        const user = await deps.users.changeUserStatus(updatedUser.id, "active");

        const parsedToken = parseInviteToken(input.token);
        await deps.inviteTokens.consumeInviteToken(parsedToken.id);

        await appendUserAudit(deps, {
          action: "user.invite.activate",
          entity_id: user.id,
          target_user_id: user.id,
          summary: "Activated invited user account.",
          before_payload: { status: activation.user.status },
          after_payload: { status: user.status, email_verified: user.email_verified },
        });

        return user;
      });
    },

    async disableUser(userId, options = {}) {
      return withTransaction(database, async (trx) => {
        const deps = createUserServiceDependencies(trx);
        const before = await deps.users.getUserById(userId, { includeDeleted: true });

        const user = await deps.users.changeUserStatus(userId, "disabled");

        if (options.revokeSessions !== false) {
          await deps.sessions.revokeAllSessionsForUser(userId);
        }

        await appendUserAudit(deps, {
          actor_user_id: options.actor_user_id ?? null,
          action: "user.disable",
          entity_id: user.id,
          target_user_id: user.id,
          summary: "Disabled user account.",
          before_payload: { status: before?.status ?? null },
          after_payload: { status: user.status },
        });

        return user;
      });
    },

    async lockUser(userId, options = {}) {
      return withTransaction(database, async (trx) => {
        const deps = createUserServiceDependencies(trx);
        const before = await deps.users.getUserById(userId, { includeDeleted: true });

        const user = await deps.users.changeUserStatus(userId, "locked");

        if (options.revokeSessions !== false) {
          await deps.sessions.revokeAllSessionsForUser(userId);
        }

        await appendUserAudit(deps, {
          actor_user_id: options.actor_user_id ?? null,
          action: "user.lock",
          entity_id: user.id,
          target_user_id: user.id,
          summary: "Locked user account.",
          before_payload: { status: before?.status ?? null },
          after_payload: { status: user.status },
        });

        return user;
      });
    },

    async revokeUserSessions(userId, revokedAt) {
      return withTransaction(database, async (trx) => {
        const deps = createUserServiceDependencies(trx);
        await deps.sessions.revokeAllSessionsForUser(userId, revokedAt);
        const user = await deps.users.getUserById(userId, { includeDeleted: true });

        await appendUserAudit(deps, {
          action: "session.revoke_all_for_user",
          entity_type: "session",
          entity_id: userId,
          target_user_id: userId,
          summary: "Revoked all sessions for user.",
          after_payload: { revoked_at: revokedAt ?? null },
        });

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
        const before = await deps.users.getUserById(userId, { includeDeleted: true });

        const user = await deps.users.softDeleteUser(userId, {
          deleted_by_user_id: options.deleted_by_user_id,
          delete_reason: options.delete_reason,
          deleted_at: options.deleted_at,
        });

        if (options.revokeSessions !== false) {
          await deps.sessions.revokeAllSessionsForUser(userId);
        }

        await appendUserAudit(deps, {
          actor_user_id: options.deleted_by_user_id ?? null,
          action: "user.soft_delete",
          entity_id: user.id,
          target_user_id: user.id,
          summary: "Soft deleted user account.",
          before_payload: { status: before?.status ?? null, deleted_at: before?.deleted_at ?? null },
          after_payload: { status: user.status, deleted_at: user.deleted_at ?? null },
          metadata: { delete_reason: options.delete_reason ?? null },
        });

        return user;
      });
    },

    async restoreUser(userId, options = {}) {
      return withTransaction(database, async (trx) => {
        const deps = createUserServiceDependencies(trx);
        const before = await deps.users.getUserById(userId, { includeDeleted: true });
        const user = await deps.users.restoreUser(userId, { status: options.status });

        await appendUserAudit(deps, {
          action: "user.restore",
          entity_id: user.id,
          target_user_id: user.id,
          summary: "Restored soft deleted user account.",
          before_payload: { status: before?.status ?? null, deleted_at: before?.deleted_at ?? null },
          after_payload: { status: user.status, deleted_at: user.deleted_at ?? null },
        });

        return user;
      });
    },
  };
}

export { INVITE_TOKEN_TTL_MS };
