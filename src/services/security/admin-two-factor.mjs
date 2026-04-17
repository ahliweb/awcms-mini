import { getDatabase, withTransaction } from "../../db/index.mjs";
import { createRecoveryCodeRepository } from "../../db/repositories/recovery-codes.mjs";
import { createTotpCredentialRepository } from "../../db/repositories/totp-credentials.mjs";
import { createUserRepository } from "../../db/repositories/users.mjs";
import { createAuditService } from "../audit/service.mjs";
import { createSecurityEventRepository } from "../../db/repositories/security-events.mjs";

export class AdminTwoFactorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AdminTwoFactorError";
    this.code = code;
  }
}

function createAdminTwoFactorDependencies(executor) {
  return {
    users: createUserRepository(executor),
    totpCredentials: createTotpCredentialRepository(executor),
    recoveryCodes: createRecoveryCodeRepository(executor),
    audit: createAuditService({ database: executor }),
    securityEvents: createSecurityEventRepository(executor),
  };
}

export function createAdminTwoFactorService(options = {}) {
  const database = options.database ?? getDatabase();
  const now = options.now ?? (() => new Date().toISOString());

  return {
    async getUserTwoFactorStatus(userId) {
      return withTransaction(database, async (trx) => {
        const deps = createAdminTwoFactorDependencies(trx);
        const user = await deps.users.getUserById(userId, { includeDeleted: true });

        if (!user || user.deleted_at || user.status === "deleted") {
          throw new AdminTwoFactorError("USER_NOT_FOUND", "User is not available for 2FA inspection.");
        }

        const credential = await deps.totpCredentials.getActiveTotpCredentialByUserId(userId);
        const recoveryCodes = await deps.recoveryCodes.listRecoveryCodesByUserId(userId, { unusedOnly: true });

        return {
          userId,
          enrolled: Boolean(credential?.verified_at),
          pending: Boolean(credential && !credential.verified_at),
          verifiedAt: credential?.verified_at ?? null,
          lastUsedAt: credential?.last_used_at ?? null,
          recoveryCodeCount: recoveryCodes.length,
        };
      });
    },

    async resetUserTwoFactor(input) {
      return withTransaction(database, async (trx) => {
        const deps = createAdminTwoFactorDependencies(trx);
        const user = await deps.users.getUserById(input.user_id, { includeDeleted: true });

        if (!user || user.deleted_at || user.status === "deleted") {
          throw new AdminTwoFactorError("USER_NOT_FOUND", "User is not available for 2FA reset.");
        }

        const resetAt = now();
        await deps.totpCredentials.disableActiveTotpCredentialsForUser(user.id, resetAt);
        await deps.recoveryCodes.replaceActiveRecoveryCodesForUser(user.id, resetAt);

        await deps.audit.append({
          actor_user_id: input.actor_user_id ?? null,
          action: "security.2fa.reset",
          entity_type: "2fa",
          entity_id: user.id,
          target_user_id: user.id,
          summary: "Reset user two-factor authentication credentials.",
          after_payload: { reset_at: resetAt },
        });

        await deps.securityEvents.appendEvent({
          id: crypto.randomUUID(),
          user_id: user.id,
          event_type: "security.2fa.reset",
          severity: "warning",
          details_json: {
            actor_user_id: input.actor_user_id ?? null,
            reason: input.reason ?? null,
          },
          occurred_at: resetAt,
        });

        return this.getUserTwoFactorStatus(user.id);
      });
    },
  };
}
