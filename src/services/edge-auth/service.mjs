import { randomBytes } from "node:crypto";

import { SignJWT, jwtVerify } from "jose";

import { hashPassword, verifyPassword } from "../../auth/passwords.mjs";
import { getRuntimeConfig } from "../../config/runtime.mjs";
import { getDatabase, withTransaction } from "../../db/index.mjs";
import { createEdgeApiRefreshTokenRepository } from "../../db/repositories/edge-api-refresh-tokens.mjs";
import { createLoginSecurityEventRepository } from "../../db/repositories/login-security-events.mjs";
import { createUserRepository } from "../../db/repositories/users.mjs";
import { resolveTrustedClientIp } from "../../security/client-ip.mjs";
import { createTwoFactorService, TwoFactorChallengeError } from "../security/two-factor.mjs";
import { createLockoutService } from "../security/lockout.mjs";
import { createSessionService } from "../sessions/service.mjs";

const EDGE_API_JWT_ALGORITHM = "HS256";
const EDGE_API_JWT_ALGORITHMS = [EDGE_API_JWT_ALGORITHM];
const encoder = new TextEncoder();

function buildJwtKey(runtimeConfig) {
  return encoder.encode(runtimeConfig.edgeApi.jwt.secret);
}

function isExpired(value, now = new Date()) {
  if (!value) {
    return false;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= now.getTime();
}

function buildInvalidCredentialError() {
  return new EdgeAuthError("INVALID_CREDENTIALS", "Invalid email or password.", 401);
}

function assertActiveUser(user) {
  if (!user) {
    throw buildInvalidCredentialError();
  }

  if (user.deleted_at || user.status === "deleted") {
    throw new EdgeAuthError("ACCOUNT_DELETED", "Account deleted.", 403);
  }

  if (user.status !== "active") {
    const code = ["disabled", "locked"].includes(user.status) ? "ACCOUNT_DISABLED" : "ACCOUNT_NOT_ACTIVE";
    throw new EdgeAuthError(code, "Account is not available.", 403);
  }

  if (user.must_reset_password) {
    throw new EdgeAuthError("PASSWORD_RESET_REQUIRED", "Password reset is required before continuing.", 403);
  }
}

function parseRefreshToken(value) {
  const token = String(value ?? "").trim();
  const [id, secret] = token.split(".");

  if (!id || !secret) {
    throw new EdgeAuthError("INVALID_REFRESH_TOKEN", "Refresh token is invalid.", 401);
  }

  return { id, secret };
}

function createRefreshTokenMaterial() {
  const id = crypto.randomUUID();
  const secret = randomBytes(32).toString("base64url");

  return {
    id,
    secret,
    token: `${id}.${secret}`,
  };
}

async function signAccessToken({ runtimeConfig, user, session, now, sessionStrength, twoFactorSatisfied }) {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const expiresAt = issuedAt + runtimeConfig.edgeApi.jwt.accessTokenTtlSeconds;

  const token = await new SignJWT({
    sid: session.id,
    email: user.email,
    session_strength: sessionStrength,
    two_factor_satisfied: twoFactorSatisfied,
  })
    .setProtectedHeader({ alg: EDGE_API_JWT_ALGORITHM, typ: "JWT" })
    .setIssuer(runtimeConfig.edgeApi.jwt.issuer)
    .setAudience(runtimeConfig.edgeApi.jwt.audience)
    .setSubject(user.id)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(buildJwtKey(runtimeConfig));

  return {
    token,
    expiresIn: runtimeConfig.edgeApi.jwt.accessTokenTtlSeconds,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  };
}

export class EdgeAuthError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "EdgeAuthError";
    this.code = code;
    this.status = status;
  }
}

export function createEdgeAuthService(options = {}) {
  const database = options.database ?? getDatabase();
  const runtimeConfig = options.runtimeConfig ?? getRuntimeConfig();
  const now = options.now ?? (() => new Date());
  const users = options.users ?? createUserRepository(database);
  const loginEvents = options.loginEvents ?? createLoginSecurityEventRepository(database);
  const refreshTokens = options.refreshTokens ?? createEdgeApiRefreshTokenRepository(database);
  const sessions = options.sessions ?? createSessionService({ database });
  const lockout = options.lockout ?? createLockoutService({ database });
  const twoFactor = options.twoFactor ?? createTwoFactorService({ database });

  function assertConfigured() {
    if (!runtimeConfig.edgeApi.jwt.enabled || !runtimeConfig.edgeApi.jwt.secret) {
      throw new EdgeAuthError("EDGE_API_TOKEN_UNAVAILABLE", "Edge API token issuance is not configured.", 503);
    }
  }

  async function buildTokenResponse({ user, session, sessionStrength, twoFactorSatisfied, refreshTokenRepository = refreshTokens }) {
    const issuedAt = now();
    const refreshTokenMaterial = createRefreshTokenMaterial();
    const refreshExpiresAt = new Date(issuedAt.getTime() + runtimeConfig.edgeApi.jwt.refreshTokenTtlSeconds * 1000).toISOString();
    const access = await signAccessToken({
      runtimeConfig,
      user,
      session,
      now: issuedAt,
      sessionStrength,
      twoFactorSatisfied,
    });

    const refreshToken = await refreshTokenRepository.createRefreshToken({
      id: refreshTokenMaterial.id,
      session_id: session.id,
      user_id: user.id,
      token_hash: hashPassword(refreshTokenMaterial.secret),
      session_strength: sessionStrength,
      two_factor_satisfied: twoFactorSatisfied,
      expires_at: refreshExpiresAt,
    });

    return {
      tokenType: "Bearer",
      accessToken: access.token,
      accessTokenExpiresIn: access.expiresIn,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: refreshTokenMaterial.token,
      refreshTokenExpiresIn: runtimeConfig.edgeApi.jwt.refreshTokenTtlSeconds,
      refreshTokenExpiresAt: refreshToken.expires_at,
      user: {
        id: user.id,
        email: user.email,
        name: user.name ?? user.display_name ?? null,
        avatarUrl: user.avatar_url ?? null,
      },
      session: {
        id: session.id,
        trustedDevice: session.trusted_device,
        expiresAt: session.expires_at,
        sessionStrength,
        twoFactorSatisfied,
      },
    };
  }

  return {
    async issueTokenPairFromPassword({ request, email, password, code, recoveryCode }) {
      assertConfigured();

      const normalizedEmail = String(email ?? "").trim().toLowerCase();
      const normalizedPassword = typeof password === "string" ? password : "";
      const normalizedCode = typeof code === "string" ? code.trim() : "";
      const normalizedRecoveryCode = typeof recoveryCode === "string" ? recoveryCode.trim() : "";
      const ipAddress = request ? resolveTrustedClientIp(request) : null;
      const userAgent = request?.headers.get("user-agent") ?? null;

      if (!normalizedEmail || !normalizedPassword) {
        throw new EdgeAuthError("INVALID_CREDENTIALS", "Email and password are required.", 400);
      }

      const appendEvent = (input) =>
        loginEvents.appendEvent({
          id: crypto.randomUUID(),
          event_type: "login_attempt",
          email_attempted: normalizedEmail,
          ip_address: ipAddress,
          user_agent: userAgent,
          ...input,
        });

      const activeLock = await lockout.assertLoginAllowed({ email: normalizedEmail, ipAddress });

      if (activeLock) {
        await appendEvent({ outcome: "failure", reason: "lockout_active" });
        throw new EdgeAuthError("AUTH_LOCKED", "Too many failed login attempts.", 429);
      }

      const user = await users.getUserByEmail(normalizedEmail, { includeDeleted: true });

      if (!user) {
        await lockout.registerLoginFailure({ email: normalizedEmail, ipAddress, userAgent, reason: "user_not_found" });
        await appendEvent({ outcome: "failure", reason: "user_not_found" });
        throw buildInvalidCredentialError();
      }

      try {
        assertActiveUser(user);
      } catch (error) {
        if (error instanceof EdgeAuthError) {
          await appendEvent({ user_id: user.id, outcome: "failure", reason: error.code.toLowerCase() });
        }
        throw error;
      }

      if (!verifyPassword(normalizedPassword, user.password_hash)) {
        await lockout.registerLoginFailure({ email: normalizedEmail, ipAddress, userId: user.id, userAgent, reason: "invalid_password" });
        await appendEvent({ user_id: user.id, outcome: "failure", reason: "invalid_password" });
        throw buildInvalidCredentialError();
      }

      const twoFactorStatus = await twoFactor.getEnrollmentStatus(user.id);
      let sessionStrength = "password";
      let twoFactorSatisfied = false;

      if (twoFactorStatus.enrolled) {
        if (!normalizedCode && !normalizedRecoveryCode) {
          await appendEvent({ user_id: user.id, outcome: "failure", reason: "two_factor_required" });
          throw new EdgeAuthError("TWO_FACTOR_REQUIRED", "Two-factor code is required.", 403);
        }

        try {
          if (normalizedRecoveryCode) {
            await twoFactor.verifyRecoveryCodeChallenge({ user_id: user.id, code: normalizedRecoveryCode });
          } else {
            await twoFactor.verifyChallenge({ user_id: user.id, code: normalizedCode });
          }
        } catch (error) {
          if (error instanceof TwoFactorChallengeError) {
            await appendEvent({ user_id: user.id, outcome: "failure", reason: error.code.toLowerCase() });
            throw new EdgeAuthError(error.code, error.message, 401);
          }

          throw error;
        }

        sessionStrength = "two_factor";
        twoFactorSatisfied = true;
      }

      await lockout.resetLoginCounters({ email: normalizedEmail, ipAddress });

      const result = await withTransaction(database, async (trx) => {
        const trxSessions = createSessionService({ database: trx });
        const trxUsers = createUserRepository(trx);
        const trxRefreshTokens = createEdgeApiRefreshTokenRepository(trx);

        const issuedSession = await trxSessions.issueSession({
          id: crypto.randomUUID(),
          user_id: user.id,
          session_token_hash: hashPassword(`${user.id}:${Date.now()}:${randomBytes(32).toString("base64url")}`),
          ip_address: ipAddress,
          user_agent: userAgent,
          trusted_device: false,
          last_seen_at: now().toISOString(),
          expires_at: new Date(now().getTime() + runtimeConfig.edgeApi.jwt.refreshTokenTtlSeconds * 1000).toISOString(),
        });

        await trxUsers.updateUser(user.id, { last_login_at: now().toISOString() });

        return buildTokenResponse({
          user,
          session: issuedSession,
          sessionStrength,
          twoFactorSatisfied,
          refreshTokenRepository: trxRefreshTokens,
        });
      });

      await appendEvent({ user_id: user.id, outcome: "success", reason: "edge_api_token_password" });

      return result;
    },

    async refreshTokenPair({ refreshToken, request }) {
      assertConfigured();

      const parsed = parseRefreshToken(refreshToken);
      const currentTime = now();
      const ipAddress = request ? resolveTrustedClientIp(request) : null;
      const userAgent = request?.headers.get("user-agent") ?? null;

      return withTransaction(database, async (trx) => {
        const trxRefreshTokens = createEdgeApiRefreshTokenRepository(trx);
        const trxSessions = createSessionService({ database: trx });
        const trxUsers = createUserRepository(trx);

        const storedToken = await trxRefreshTokens.getRefreshTokenById(parsed.id);

        if (!storedToken || !verifyPassword(parsed.secret, storedToken.token_hash)) {
          throw new EdgeAuthError("INVALID_REFRESH_TOKEN", "Refresh token is invalid.", 401);
        }

        if (storedToken.used_at || storedToken.revoked_at || storedToken.replaced_by_token_id || isExpired(storedToken.expires_at, currentTime)) {
          throw new EdgeAuthError("INVALID_REFRESH_TOKEN", "Refresh token is invalid.", 401);
        }

        const session = await trxSessions.getSession(storedToken.session_id);

        if (!session || session.revoked_at || isExpired(session.expires_at, currentTime)) {
          throw new EdgeAuthError("INVALID_REFRESH_TOKEN", "Refresh token is invalid.", 401);
        }

        const user = await trxUsers.getUserById(storedToken.user_id, { includeDeleted: true });
        assertActiveUser(user);

        const refreshedSession = await trxSessions.refreshSession(session.id, currentTime.toISOString());
        const nextRefreshToken = createRefreshTokenMaterial();
        const nextExpiresAt = new Date(currentTime.getTime() + runtimeConfig.edgeApi.jwt.refreshTokenTtlSeconds * 1000).toISOString();

        await trxRefreshTokens.createRefreshToken({
          id: nextRefreshToken.id,
          session_id: session.id,
          user_id: user.id,
          token_hash: hashPassword(nextRefreshToken.secret),
          session_strength: storedToken.session_strength,
          two_factor_satisfied: storedToken.two_factor_satisfied === true,
          expires_at: nextExpiresAt,
        });

        await trxRefreshTokens.markRefreshTokenRotated(storedToken.id, {
          usedAt: currentTime.toISOString(),
          replacedByTokenId: nextRefreshToken.id,
        });

        const access = await signAccessToken({
          runtimeConfig,
          user,
          session: refreshedSession ?? session,
          now: currentTime,
          sessionStrength: storedToken.session_strength,
          twoFactorSatisfied: storedToken.two_factor_satisfied === true,
        });

        return {
          tokenType: "Bearer",
          accessToken: access.token,
          accessTokenExpiresIn: access.expiresIn,
          accessTokenExpiresAt: access.expiresAt,
          refreshToken: nextRefreshToken.token,
          refreshTokenExpiresIn: runtimeConfig.edgeApi.jwt.refreshTokenTtlSeconds,
          refreshTokenExpiresAt: nextExpiresAt,
          user: {
            id: user.id,
            email: user.email,
            name: user.name ?? user.display_name ?? null,
            avatarUrl: user.avatar_url ?? null,
          },
          session: {
            id: session.id,
            trustedDevice: session.trusted_device,
            expiresAt: session.expires_at,
            sessionStrength: storedToken.session_strength,
            twoFactorSatisfied: storedToken.two_factor_satisfied === true,
          },
          metadata: {
            ipAddress,
            userAgent,
          },
        };
      });
    },

    async authenticateAccessToken(token) {
      assertConfigured();

      let payload;

      try {
        ({ payload } = await jwtVerify(token, buildJwtKey(runtimeConfig), {
          algorithms: EDGE_API_JWT_ALGORITHMS,
          issuer: runtimeConfig.edgeApi.jwt.issuer,
          audience: runtimeConfig.edgeApi.jwt.audience,
        }));
      } catch {
        throw new EdgeAuthError("NOT_AUTHENTICATED", "Not authenticated.", 401);
      }

      const userId = typeof payload.sub === "string" ? payload.sub : null;
      const sessionId = typeof payload.sid === "string" ? payload.sid : null;

      if (!userId || !sessionId) {
        throw new EdgeAuthError("NOT_AUTHENTICATED", "Not authenticated.", 401);
      }

      const session = await sessions.getSession(sessionId);

      if (!session || session.user_id !== userId || session.revoked_at || isExpired(session.expires_at, now())) {
        throw new EdgeAuthError("NOT_AUTHENTICATED", "Not authenticated.", 401);
      }

      const user = await users.getUserById(userId, { includeDeleted: true });
      assertActiveUser(user);

      return {
        user,
        activeSession: session,
        tokenClaims: payload,
      };
    },

    async revokeSessionTokens(sessionId, revokedAt = now().toISOString()) {
      return refreshTokens.revokeRefreshTokensBySessionId(sessionId, revokedAt);
    },
  };
}
