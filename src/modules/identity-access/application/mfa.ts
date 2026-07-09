/**
 * MFA/TOTP application logic (Issue #589, epic: full-online auth hardening).
 * Reuses the same crypto/token primitives `password-reset.ts` established
 * for this module: `mfa-challenge-token.ts` mirrors `password-reset-token.ts`,
 * `mfa-recovery-code.ts` is a distinct one-way hash (never the reversible
 * TOTP secret encryption `mfa-secret-crypto.ts` uses).
 *
 * Every function here is fail-closed on a missing/invalid
 * `AUTH_MFA_SECRET_ENCRYPTION_KEY` (`resolveMfaEncryptionKey` returning
 * `null`) — treated as `MFA_MISCONFIGURED`, never as "skip verification."
 */
import {
  base32Encode,
  buildOtpauthUri,
  generateTotpSecret,
  verifyTotpCode
} from "../../../lib/auth/totp";
import {
  decryptMfaSecret,
  encryptMfaSecret,
  resolveMfaEncryptionKey
} from "../../../lib/auth/mfa-secret-crypto";
import {
  resolveTotpDigits,
  resolveTotpPeriodSec,
  resolveTotpIssuer
} from "../../../lib/auth/mfa-config";
import {
  generateRecoveryCode,
  hashRecoveryCode
} from "../../../lib/auth/mfa-recovery-code";
import {
  generateChallengeToken,
  hashChallengeToken
} from "../../../lib/auth/mfa-challenge-token";
import {
  evaluateMfaChallenge,
  type MfaChallengeDenyReason
} from "../domain/mfa-policy";

const RECOVERY_CODE_COUNT = 10;

async function insertRecoveryCodes(
  tx: Bun.SQL,
  tenantId: string,
  identityId: string,
  factorId: string
): Promise<string[]> {
  const rawCodes: string[] = [];

  for (let i = 0; i < RECOVERY_CODE_COUNT; i += 1) {
    const rawCode = generateRecoveryCode();
    rawCodes.push(rawCode);

    await tx`
      INSERT INTO awcms_mini_identity_mfa_recovery_codes
        (tenant_id, identity_id, factor_id, code_hash)
      VALUES (${tenantId}, ${identityId}, ${factorId}, ${hashRecoveryCode(rawCode)})
    `;
  }

  return rawCodes;
}

export type MfaStatus = {
  enabled: boolean;
  factorType?: "totp";
  activatedAt?: string;
};

export async function getMfaStatus(
  tx: Bun.SQL,
  tenantId: string,
  identityId: string
): Promise<MfaStatus> {
  const rows = (await tx`
    SELECT factor_type, activated_at
    FROM awcms_mini_identity_mfa_factors
    WHERE tenant_id = ${tenantId} AND identity_id = ${identityId} AND status = 'active'
  `) as { factor_type: "totp"; activated_at: Date }[];
  const row = rows[0];

  if (!row) {
    return { enabled: false };
  }

  return {
    enabled: true,
    factorType: row.factor_type,
    activatedAt: new Date(row.activated_at).toISOString()
  };
}

export type StartEnrollmentResult =
  | { ok: true; secretBase32: string; otpauthUri: string }
  | { ok: false; code: "MFA_ALREADY_ACTIVE" | "MFA_MISCONFIGURED" };

/**
 * Generates a fresh secret and stores it as a `pending` factor — unusable
 * for login until confirmed via `verifyTotpEnrollment`. Re-starting
 * enrollment (calling this again before verifying) discards any prior
 * pending secret, so only the most recently displayed QR/secret is ever
 * valid to confirm.
 */
export async function startTotpEnrollment(
  tx: Bun.SQL,
  tenantId: string,
  identityId: string,
  loginIdentifier: string,
  env: NodeJS.ProcessEnv,
  now: Date
): Promise<StartEnrollmentResult> {
  const key = resolveMfaEncryptionKey(env);

  if (!key) {
    return { ok: false, code: "MFA_MISCONFIGURED" };
  }

  const activeRows = await tx`
    SELECT id FROM awcms_mini_identity_mfa_factors
    WHERE tenant_id = ${tenantId} AND identity_id = ${identityId} AND status = 'active'
  `;

  if (activeRows.length > 0) {
    return { ok: false, code: "MFA_ALREADY_ACTIVE" };
  }

  await tx`
    DELETE FROM awcms_mini_identity_mfa_factors
    WHERE tenant_id = ${tenantId} AND identity_id = ${identityId} AND status = 'pending'
  `;

  const secret = generateTotpSecret();
  const ciphertext = encryptMfaSecret(secret, key);
  const digits = resolveTotpDigits(env);
  const periodSec = resolveTotpPeriodSec(env);
  const issuer = resolveTotpIssuer(env);

  await tx`
    INSERT INTO awcms_mini_identity_mfa_factors
      (tenant_id, identity_id, factor_type, secret_ciphertext, status, created_at, updated_at)
    VALUES (${tenantId}, ${identityId}, 'totp', ${ciphertext}, 'pending', ${now}, ${now})
  `;

  return {
    ok: true,
    secretBase32: base32Encode(secret),
    otpauthUri: buildOtpauthUri({
      secret,
      issuer,
      accountName: loginIdentifier,
      digits,
      periodSec
    })
  };
}

export type VerifyEnrollmentResult =
  | { ok: true; recoveryCodes: string[] }
  | {
      ok: false;
      code:
        "MFA_ENROLLMENT_NOT_FOUND" | "MFA_INVALID_CODE" | "MFA_MISCONFIGURED";
    };

export async function verifyTotpEnrollment(
  tx: Bun.SQL,
  tenantId: string,
  identityId: string,
  code: string,
  env: NodeJS.ProcessEnv,
  now: Date
): Promise<VerifyEnrollmentResult> {
  const key = resolveMfaEncryptionKey(env);

  if (!key) {
    return { ok: false, code: "MFA_MISCONFIGURED" };
  }

  const rows = (await tx`
    SELECT id, secret_ciphertext
    FROM awcms_mini_identity_mfa_factors
    WHERE tenant_id = ${tenantId} AND identity_id = ${identityId} AND status = 'pending'
  `) as { id: string; secret_ciphertext: string }[];
  const row = rows[0];

  if (!row) {
    return { ok: false, code: "MFA_ENROLLMENT_NOT_FOUND" };
  }

  let matchedStep: number | null;

  try {
    const secret = decryptMfaSecret(row.secret_ciphertext, key);
    matchedStep = verifyTotpCode(secret, code, now.getTime(), {
      periodSec: resolveTotpPeriodSec(env),
      digits: resolveTotpDigits(env)
    });
  } catch {
    matchedStep = null;
  }

  if (matchedStep === null) {
    return { ok: false, code: "MFA_INVALID_CODE" };
  }

  await tx`
    UPDATE awcms_mini_identity_mfa_factors
    SET status = 'active', activated_at = ${now}, updated_at = ${now},
        last_used_step = ${matchedStep}
    WHERE id = ${row.id}
  `;

  const recoveryCodes = await insertRecoveryCodes(
    tx,
    tenantId,
    identityId,
    row.id
  );

  return { ok: true, recoveryCodes };
}

export type DisableMfaResult =
  { ok: true } | { ok: false; code: "MFA_NOT_ACTIVE" };

export async function disableMfa(
  tx: Bun.SQL,
  tenantId: string,
  identityId: string,
  now: Date
): Promise<DisableMfaResult> {
  const rows = await tx`
    SELECT id FROM awcms_mini_identity_mfa_factors
    WHERE tenant_id = ${tenantId} AND identity_id = ${identityId} AND status IN ('active', 'pending')
  `;

  if (rows.length === 0) {
    return { ok: false, code: "MFA_NOT_ACTIVE" };
  }

  await tx`
    UPDATE awcms_mini_identity_mfa_factors
    SET status = 'disabled', disabled_at = ${now}, updated_at = ${now}
    WHERE tenant_id = ${tenantId} AND identity_id = ${identityId} AND status IN ('active', 'pending')
  `;

  await tx`
    DELETE FROM awcms_mini_identity_mfa_recovery_codes
    WHERE tenant_id = ${tenantId} AND identity_id = ${identityId}
  `;

  return { ok: true };
}

export type RegenerateRecoveryCodesResult =
  { ok: true; recoveryCodes: string[] } | { ok: false; code: "MFA_NOT_ACTIVE" };

export async function regenerateRecoveryCodes(
  tx: Bun.SQL,
  tenantId: string,
  identityId: string
): Promise<RegenerateRecoveryCodesResult> {
  const rows = (await tx`
    SELECT id FROM awcms_mini_identity_mfa_factors
    WHERE tenant_id = ${tenantId} AND identity_id = ${identityId} AND status = 'active'
  `) as { id: string }[];
  const row = rows[0];

  if (!row) {
    return { ok: false, code: "MFA_NOT_ACTIVE" };
  }

  await tx`
    DELETE FROM awcms_mini_identity_mfa_recovery_codes
    WHERE tenant_id = ${tenantId} AND factor_id = ${row.id}
  `;

  const recoveryCodes = await insertRecoveryCodes(
    tx,
    tenantId,
    identityId,
    row.id
  );

  return { ok: true, recoveryCodes };
}

export type ActiveMfaFactor = { id: string };

/** Used by `login.ts` to decide whether a password-valid login must stop at a challenge instead of creating a session. */
export async function findActiveMfaFactor(
  tx: Bun.SQL,
  tenantId: string,
  identityId: string
): Promise<ActiveMfaFactor | null> {
  const rows = (await tx`
    SELECT id FROM awcms_mini_identity_mfa_factors
    WHERE tenant_id = ${tenantId} AND identity_id = ${identityId} AND status = 'active'
  `) as { id: string }[];

  return rows[0] ?? null;
}

export async function createMfaChallenge(
  tx: Bun.SQL,
  tenantId: string,
  identityId: string,
  ttlSec: number,
  now: Date
): Promise<{ token: string; expiresAt: Date }> {
  const rawToken = generateChallengeToken();
  const tokenHash = hashChallengeToken(rawToken);
  const expiresAt = new Date(now.getTime() + ttlSec * 1000);

  await tx`
    INSERT INTO awcms_mini_mfa_challenges (tenant_id, identity_id, challenge_token_hash, expires_at)
    VALUES (${tenantId}, ${identityId}, ${tokenHash}, ${expiresAt})
  `;

  return { token: rawToken, expiresAt };
}

export type MfaChallengeFailureCode =
  "MFA_CHALLENGE_INVALID" | "MFA_MISCONFIGURED";

export type VerifyMfaChallengeResult =
  | { ok: true; identityId: string }
  | { ok: false; code: MfaChallengeFailureCode };

/**
 * Verifies a challenge issued by `createMfaChallenge` against either a TOTP
 * `code` or a `recoveryCode` (exactly one should be provided by the caller).
 * Every deny path — challenge not found/expired/already used/too many
 * attempts, wrong code, factor no longer active — collapses to the same
 * generic `MFA_CHALLENGE_INVALID`, mirroring `completePasswordReset`'s
 * "response never distinguishes why" convention so this endpoint can't be
 * used to fingerprint challenge/account state. The specific
 * `MfaChallengeDenyReason` is only used internally (never returned) — a
 * future audit-log caller could log it, but this function itself has no DB
 * transaction ownership beyond the challenge/factor rows, so audit logging
 * stays the endpoint's responsibility (matches `completePasswordReset`).
 */
export async function verifyMfaChallenge(
  tx: Bun.SQL,
  tenantId: string,
  challengeToken: string,
  credentials: { code?: string; recoveryCode?: string },
  env: NodeJS.ProcessEnv,
  maxAttempts: number,
  now: Date
): Promise<VerifyMfaChallengeResult> {
  const tokenHash = hashChallengeToken(challengeToken);

  // `FOR UPDATE` locks this challenge row for the rest of the transaction —
  // essential, not optional: without it, N concurrent verification
  // requests for the SAME challenge would all read the same
  // `failed_attempts` value before any of them commits, all pass the
  // `>= maxAttempts` check, and all get to guess a code, silently
  // defeating the attempt limit this column exists to enforce (found in
  // PR #597 security review). Serializing on this row means the second
  // concurrent request only proceeds after the first's UPDATE below has
  // committed, so it always sees the up-to-date count.
  const challengeRows = (await tx`
    SELECT id, identity_id, expires_at, consumed_at, failed_attempts
    FROM awcms_mini_mfa_challenges
    WHERE tenant_id = ${tenantId} AND challenge_token_hash = ${tokenHash}
    FOR UPDATE
  `) as {
    id: string;
    identity_id: string;
    expires_at: Date;
    consumed_at: Date | null;
    failed_attempts: number;
  }[];
  const challenge = challengeRows[0];

  const evaluation = evaluateMfaChallenge(
    challenge
      ? {
          expiresAt: new Date(challenge.expires_at),
          consumedAt: challenge.consumed_at,
          failedAttempts: challenge.failed_attempts
        }
      : null,
    now,
    maxAttempts
  );

  if (evaluation.outcome === "invalid") {
    return { ok: false, code: "MFA_CHALLENGE_INVALID" };
  }

  const factorRows = (await tx`
    SELECT id, secret_ciphertext, last_used_step
    FROM awcms_mini_identity_mfa_factors
    WHERE tenant_id = ${tenantId} AND identity_id = ${challenge!.identity_id} AND status = 'active'
  `) as { id: string; secret_ciphertext: string; last_used_step: number }[];
  const factor = factorRows[0];

  if (!factor) {
    // MFA was disabled between login and challenge completion — burn the
    // challenge so it can't be retried once a factor exists again.
    await tx`
      UPDATE awcms_mini_mfa_challenges SET consumed_at = ${now} WHERE id = ${challenge!.id}
    `;
    return { ok: false, code: "MFA_CHALLENGE_INVALID" };
  }

  let matched = false;
  let deniedByMisconfiguration = false;

  if (credentials.code) {
    const key = resolveMfaEncryptionKey(env);

    if (!key) {
      deniedByMisconfiguration = true;
    } else {
      try {
        const secret = decryptMfaSecret(factor.secret_ciphertext, key);
        const matchedStep = verifyTotpCode(
          secret,
          credentials.code,
          now.getTime(),
          {
            periodSec: resolveTotpPeriodSec(env),
            digits: resolveTotpDigits(env)
          }
        );

        if (matchedStep !== null && matchedStep > factor.last_used_step) {
          // Compare-and-swap, not a blind SET: `last_used_step` is also
          // read by whichever OTHER challenge might be racing this one for
          // the same identity (a second login attempt can create a second
          // challenge row) — the `FOR UPDATE` lock above only serializes
          // requests against THIS challenge, not against the factor row
          // shared by every challenge for this identity. Re-asserting
          // `last_used_step < matchedStep` atomically in the WHERE clause
          // closes that gap: if another request already advanced the step
          // first, this UPDATE affects zero rows and the code is correctly
          // treated as replayed (found in PR #597 security review).
          const advancedRows = (await tx`
            UPDATE awcms_mini_identity_mfa_factors
            SET last_used_step = ${matchedStep}
            WHERE id = ${factor.id} AND last_used_step < ${matchedStep}
            RETURNING id
          `) as { id: string }[];
          matched = advancedRows.length > 0;
        }
      } catch {
        matched = false;
      }
    }
  } else if (credentials.recoveryCode) {
    const hash = hashRecoveryCode(credentials.recoveryCode);

    // Compare-and-swap: the `WHERE ... AND used_at IS NULL` is re-asserted
    // atomically in the same UPDATE that consumes the code, rather than
    // trusting a separate prior SELECT — otherwise two concurrent requests
    // with the same recovery code could both read "unused" before either
    // commits, and both would be accepted (same class of race as
    // `last_used_step` above).
    const consumedRows = (await tx`
      UPDATE awcms_mini_identity_mfa_recovery_codes
      SET used_at = ${now}
      WHERE tenant_id = ${tenantId} AND factor_id = ${factor.id}
        AND code_hash = ${hash} AND used_at IS NULL
      RETURNING id
    `) as { id: string }[];
    matched = consumedRows.length > 0;
  }

  if (deniedByMisconfiguration) {
    return { ok: false, code: "MFA_MISCONFIGURED" };
  }

  if (!matched) {
    await tx`
      UPDATE awcms_mini_mfa_challenges
      SET failed_attempts = failed_attempts + 1
      WHERE id = ${challenge!.id}
    `;
    return { ok: false, code: "MFA_CHALLENGE_INVALID" };
  }

  await tx`
    UPDATE awcms_mini_mfa_challenges SET consumed_at = ${now} WHERE id = ${challenge!.id}
  `;

  return { ok: true, identityId: challenge!.identity_id };
}

export type { MfaChallengeDenyReason };
