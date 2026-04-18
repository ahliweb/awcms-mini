import { getDatabase, withTransaction } from "../../db/index.mjs";
import { createSecurityEventRepository } from "../../db/repositories/security-events.mjs";
import { createPasswordResetTokenRepository } from "../../db/repositories/password-reset-tokens.mjs";
import { createUserRepository } from "../../db/repositories/users.mjs";
import { hashPassword, verifyPassword } from "../../auth/passwords.mjs";
import { createAuditService } from "../audit/service.mjs";
import { createLockoutService } from "./lockout.mjs";
import { createSessionService } from "../sessions/service.mjs";

const PASSWORD_RESET_TTL_MS = 1000 * 60 * 60;

export class PasswordResetError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PasswordResetError";
    this.code = code;
  }
}

function createPasswordResetServiceDependencies(executor) {
  return {
    users: createUserRepository(executor),
    passwordResetTokens: createPasswordResetTokenRepository(executor),
    sessions: createSessionService({ database: executor }),
    lockout: createLockoutService({ database: executor }),
    audit: createAuditService({ database: executor }),
    securityEvents: createSecurityEventRepository(executor),
  };
}

function createResetTokenValue() {
  const id = crypto.randomUUID();
  const secret = crypto.randomUUID();
  return { id, secret, value: `${id}.${secret}` };
}

function parseResetToken(token) {
  if (typeof token !== "string") return null;
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

async function resolveResetToken(deps, token) {
  const parsed = parseResetToken(token);

  if (!parsed) {
    throw new PasswordResetError("INVALID_TOKEN", "Password reset token is invalid.");
  }

  const resetToken = await deps.passwordResetTokens.getPasswordResetTokenById(parsed.id);

  if (!resetToken || resetToken.used_at) {
    throw new PasswordResetError("INVALID_TOKEN", "Password reset token is invalid.");
  }

  if (isExpired(resetToken.expires_at)) {
    throw new PasswordResetError("EXPIRED_TOKEN", "Password reset token has expired.");
  }

  if (!verifyPassword(parsed.secret, resetToken.token_hash)) {
    throw new PasswordResetError("INVALID_TOKEN", "Password reset token is invalid.");
  }

  const user = await deps.users.getUserById(resetToken.user_id, { includeDeleted: true });

  if (!user || user.deleted_at || user.status === "deleted") {
    throw new PasswordResetError("INVALID_USER", "Password reset user is not available.");
  }

  return { parsed, resetToken, user };
}

async function appendPasswordResetAudit(deps, input) {
  await deps.audit.append({
    actor_user_id: input.actor_user_id ?? null,
    action: input.action,
    entity_type: input.entity_type ?? "password_reset",
    entity_id: input.entity_id ?? null,
    target_user_id: input.target_user_id ?? null,
    summary: input.summary,
    before_payload: input.before_payload ?? null,
    after_payload: input.after_payload ?? null,
    metadata: input.metadata ?? {},
  });
}

async function appendPasswordResetSecurityEvent(deps, input) {
  await deps.securityEvents.appendEvent({
    id: input.id ?? crypto.randomUUID(),
    user_id: input.user_id ?? null,
    event_type: input.event_type,
    severity: input.severity ?? "info",
    details_json: input.details_json ?? {},
    ip_address: input.ip_address ?? null,
    user_agent: input.user_agent ?? null,
    occurred_at: input.occurred_at ?? undefined,
  });
}

export function createPasswordResetService(options = {}) {
  const database = options.database ?? getDatabase();
  const now = options.now ?? (() => new Date().toISOString());

  return {
    async requestPasswordReset(input) {
      return withTransaction(database, async (trx) => {
        const deps = createPasswordResetServiceDependencies(trx);
        const user = input.user_id
          ? await deps.users.getUserById(input.user_id, { includeDeleted: true })
          : await deps.users.getUserByEmail(String(input.email ?? "").trim().toLowerCase(), { includeDeleted: true });

        if (!user || user.deleted_at || user.status === "deleted") {
          throw new PasswordResetError("INVALID_USER", "Password reset user is not available.");
        }

        const token = createResetTokenValue();
        const expiresAt = new Date(Date.now() + (input.ttlMs ?? PASSWORD_RESET_TTL_MS)).toISOString();
        await deps.passwordResetTokens.createPasswordResetToken({
          id: token.id,
          user_id: user.id,
          token_hash: hashPassword(token.secret),
          expires_at: expiresAt,
          issued_by_user_id: input.issued_by_user_id ?? null,
        });

        await appendPasswordResetAudit(deps, {
          actor_user_id: input.issued_by_user_id ?? null,
          action: input.issued_by_user_id ? "password_reset.force_issue" : "password_reset.request",
          entity_id: token.id,
          target_user_id: user.id,
          summary: input.issued_by_user_id ? "Issued forced password reset token." : "Issued password reset token.",
          after_payload: { expires_at: expiresAt },
        });

        if (input.issued_by_user_id) {
          await appendPasswordResetSecurityEvent(deps, {
            user_id: user.id,
            event_type: "password_reset.force_issue",
            severity: "warning",
            details_json: {
              actor_user_id: input.issued_by_user_id,
              token_id: token.id,
              expires_at: expiresAt,
            },
          });
        }

        return {
          user,
          token: token.value,
          expires_at: expiresAt,
        };
      });
    },

    async getPasswordReset(token) {
      return withTransaction(database, async (trx) => {
        const deps = createPasswordResetServiceDependencies(trx);
        const resolved = await resolveResetToken(deps, token);
        return {
          token: resolved.parsed.value,
          expires_at: resolved.resetToken.expires_at,
          user: resolved.user,
        };
      });
    },

    async consumePasswordReset(input) {
      return withTransaction(database, async (trx) => {
        const deps = createPasswordResetServiceDependencies(trx);
        const resolved = await resolveResetToken(deps, input.token);
        const password = typeof input.password === "string" ? input.password : "";

        if (password.length < 8) {
          throw new PasswordResetError("INVALID_PASSWORD", "Password must be at least 8 characters.");
        }

        const before = await deps.users.getUserById(resolved.user.id, { includeDeleted: true });
        const user = await deps.users.updateUser(resolved.user.id, {
          password_hash: hashPassword(password),
          must_reset_password: false,
        });
        await deps.passwordResetTokens.markPasswordResetTokenUsed(resolved.resetToken.id, now());
        await deps.sessions.revokeAllSessionsForUser(resolved.user.id, now());
        await deps.lockout.resetAccountCounters(resolved.user.email);

        await appendPasswordResetAudit(deps, {
          action: "password_reset.consume",
          entity_id: resolved.resetToken.id,
          target_user_id: user.id,
          summary: "Consumed password reset token and updated password.",
          before_payload: { must_reset_password: before?.must_reset_password ?? null },
          after_payload: { must_reset_password: user.must_reset_password },
        });

        await appendPasswordResetSecurityEvent(deps, {
          user_id: user.id,
          event_type: "password_reset.consume",
          severity: "info",
          details_json: {
            token_id: resolved.resetToken.id,
            must_reset_password_before: before?.must_reset_password ?? null,
            must_reset_password_after: user.must_reset_password,
          },
        });

        return user;
      });
    },

    async forcePasswordReset(userId, options = {}) {
      return withTransaction(database, async (trx) => {
        const deps = createPasswordResetServiceDependencies(trx);
        const before = await deps.users.getUserById(userId, { includeDeleted: true });

        if (!before || before.deleted_at || before.status === "deleted") {
          throw new PasswordResetError("INVALID_USER", "Password reset user is not available.");
        }

        const user = await deps.users.updateUser(userId, { must_reset_password: true });
        await deps.sessions.revokeAllSessionsForUser(userId, now());
        const issued = await this.requestPasswordReset({ user_id: userId, issued_by_user_id: options.issued_by_user_id, ttlMs: options.ttlMs });

        await appendPasswordResetAudit(deps, {
          actor_user_id: options.issued_by_user_id ?? null,
          action: "password_reset.force_require",
          entity_id: issued.token.split(".")[0],
          target_user_id: userId,
          summary: "Forced password reset requirement for user.",
          before_payload: { must_reset_password: before.must_reset_password },
          after_payload: { must_reset_password: user.must_reset_password },
        });

        await appendPasswordResetSecurityEvent(deps, {
          user_id: userId,
          event_type: "password_reset.force_require",
          severity: "warning",
          details_json: {
            actor_user_id: options.issued_by_user_id ?? null,
            token_id: issued.token.split(".")[0],
            must_reset_password_before: before.must_reset_password,
            must_reset_password_after: user.must_reset_password,
          },
        });

        return issued;
      });
    },
  };
}

export { PASSWORD_RESET_TTL_MS, createResetTokenValue, parseResetToken };
