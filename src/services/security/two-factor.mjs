import { randomBytes } from "node:crypto";

import { hashPassword } from "../../auth/passwords.mjs";
import { getDatabase, withTransaction } from "../../db/index.mjs";
import { createRecoveryCodeRepository } from "../../db/repositories/recovery-codes.mjs";
import { createTotpCredentialRepository } from "../../db/repositories/totp-credentials.mjs";
import { createUserRepository } from "../../db/repositories/users.mjs";
import {
  buildOtpAuthUrl,
  decryptTotpSecret,
  encryptTotpSecret,
  generateTotpCode,
  generateTotpSecret,
  verifyTotpCode,
} from "../../security/totp.mjs";

export class TwoFactorEnrollmentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TwoFactorEnrollmentError";
    this.code = code;
  }
}

function createTwoFactorServiceDependencies(executor) {
  return {
    users: createUserRepository(executor),
    totpCredentials: createTotpCredentialRepository(executor),
    recoveryCodes: createRecoveryCodeRepository(executor),
  };
}

function createRecoveryCodePlaintext() {
  return randomBytes(5).toString("hex").toUpperCase();
}

function resolveEncryptionKey(input) {
  const value = input ?? process.env.MINI_TOTP_ENCRYPTION_KEY ?? process.env.APP_SECRET;

  if (!value) {
    throw new TwoFactorEnrollmentError("TOTP_ENCRYPTION_KEY_MISSING", "TOTP encryption key is not configured.");
  }

  return Buffer.from(String(value).padEnd(32, "0").slice(0, 32));
}

export function createTwoFactorService(options = {}) {
  const database = options.database ?? getDatabase();
  const encryptionKey = resolveEncryptionKey(options.encryptionKey);
  const issuer = options.issuer ?? "AWCMS Mini";
  const now = options.now ?? (() => new Date().toISOString());

  return {
    async beginEnrollment(input) {
      return withTransaction(database, async (trx) => {
        const deps = createTwoFactorServiceDependencies(trx);
        const user = await deps.users.getUserById(input.user_id, { includeDeleted: true });

        if (!user || user.deleted_at || user.status === "deleted") {
          throw new TwoFactorEnrollmentError("USER_NOT_FOUND", "User is not available for TOTP enrollment.");
        }

        const activeCredential = await deps.totpCredentials.getActiveTotpCredentialByUserId(user.id);

        if (activeCredential?.verified_at) {
          throw new TwoFactorEnrollmentError("TOTP_ALREADY_ENROLLED", "User already has an active verified TOTP credential.");
        }

        const secret = activeCredential ? decryptTotpSecret(activeCredential.secret_encrypted, encryptionKey) : generateTotpSecret();
        const label = `${issuer}:${user.email}`;

        const credential = activeCredential
          ? activeCredential
          : await deps.totpCredentials.createTotpCredential({
              id: crypto.randomUUID(),
              user_id: user.id,
              secret_encrypted: encryptTotpSecret(secret, encryptionKey),
              issuer,
              label,
            });

        return {
          credentialId: credential.id,
          manualKey: secret,
          otpauthUrl: buildOtpAuthUrl({ secret, label, issuer }),
          verified: credential.verified_at !== null,
        };
      });
    },

    async verifyEnrollment(input) {
      return withTransaction(database, async (trx) => {
        const deps = createTwoFactorServiceDependencies(trx);
        const credential = await deps.totpCredentials.getActiveTotpCredentialByUserId(input.user_id);

        if (!credential) {
          throw new TwoFactorEnrollmentError("TOTP_ENROLLMENT_NOT_FOUND", "No active TOTP enrollment was found.");
        }

        const secret = decryptTotpSecret(credential.secret_encrypted, encryptionKey);

        if (!verifyTotpCode(secret, input.code, { timestamp: input.timestamp })) {
          throw new TwoFactorEnrollmentError("TOTP_CODE_INVALID", "The supplied TOTP code is invalid.");
        }

        const verifiedAt = now();
        const updatedCredential = await deps.totpCredentials.updateTotpCredential(credential.id, {
          verified_at: verifiedAt,
          last_used_at: verifiedAt,
        });

        await deps.recoveryCodes.replaceActiveRecoveryCodesForUser(input.user_id, verifiedAt);

        const recoveryCodePlaintexts = Array.from({ length: 8 }, () => createRecoveryCodePlaintext());
        await deps.recoveryCodes.createRecoveryCodes(
          recoveryCodePlaintexts.map((code) => ({
            id: crypto.randomUUID(),
            user_id: input.user_id,
            code_hash: hashPassword(code),
            created_at: verifiedAt,
          })),
        );

        return {
          credential: updatedCredential,
          recoveryCodes: recoveryCodePlaintexts,
        };
      });
    },

    async getEnrollmentStatus(userId) {
      return withTransaction(database, async (trx) => {
        const deps = createTwoFactorServiceDependencies(trx);
        const credential = await deps.totpCredentials.getActiveTotpCredentialByUserId(userId);
        const recoveryCodes = await deps.recoveryCodes.listRecoveryCodesByUserId(userId, { unusedOnly: true });

        return {
          enrolled: Boolean(credential?.verified_at),
          pending: Boolean(credential && !credential.verified_at),
          recoveryCodeCount: recoveryCodes.length,
          verifiedAt: credential?.verified_at ?? null,
        };
      });
    },

    generateCurrentCodeForTesting(secret, options = {}) {
      return generateTotpCode(secret, options);
    },
  };
}
