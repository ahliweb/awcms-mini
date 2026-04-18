import { randomBytes } from "node:crypto";

import { createLoginSecurityEventRepository } from "../../db/repositories/login-security-events.mjs";
import { createUserRepository } from "../../db/repositories/users.mjs";
import { createLockoutService } from "../../services/security/lockout.mjs";
import { createTwoFactorService } from "../../services/security/two-factor.mjs";
import { createSessionService } from "../../services/sessions/service.mjs";
import { resolveTrustedClientIp } from "../../security/client-ip.mjs";
import { hashPassword, verifyPassword } from "../passwords.mjs";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleAuthLogin({ request, session, db }) {
  let body;

  try {
    body = await request.json();
  } catch {
    return json({ error: { code: "INVALID_BODY", message: "Expected JSON body" } }, 400);
  }

  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (!email || !password) {
    return json({ error: { code: "INVALID_CREDENTIALS", message: "Email and password are required" } }, 400);
  }

  const users = createUserRepository(db);
  const loginEvents = createLoginSecurityEventRepository(db);
  const sessions = createSessionService({ database: db });
  const lockout = createLockoutService({ database: db });
  const twoFactor = createTwoFactorService({ database: db });
  const ipAddress = resolveTrustedClientIp(request);
  const userAgent = request.headers.get("user-agent");

  const appendEvent = (input) =>
    loginEvents.appendEvent({
      id: crypto.randomUUID(),
      event_type: "login_attempt",
      email_attempted: email,
      ip_address: ipAddress,
      user_agent: userAgent,
      ...input,
    });

  const lock = await lockout.assertLoginAllowed({ email, ipAddress });

  if (lock) {
    await appendEvent({ outcome: "failure", reason: "lockout_active" });
    return json({ error: { code: lock.code, message: "Too many failed login attempts", lockedUntil: lock.lockedUntil } }, 429);
  }

  const user = await users.getUserByEmail(email, { includeDeleted: true });

  if (!user) {
    await lockout.registerLoginFailure({ email, ipAddress, userAgent, reason: "user_not_found" });
    await appendEvent({ outcome: "failure", reason: "user_not_found" });
    return json({ error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password" } }, 401);
  }

  if (user.deleted_at || user.status === "deleted") {
    await appendEvent({ user_id: user.id, outcome: "failure", reason: "user_deleted" });
    return json({ error: { code: "ACCOUNT_DELETED", message: "Account deleted" } }, 403);
  }

  if (user.status !== "active") {
    const code = ["disabled", "locked"].includes(user.status) ? "ACCOUNT_DISABLED" : "ACCOUNT_NOT_ACTIVE";
    await appendEvent({ user_id: user.id, outcome: "failure", reason: `user_${user.status}` });
    return json({ error: { code, message: "Account is not available" } }, 403);
  }

  if (user.must_reset_password) {
    await appendEvent({ user_id: user.id, outcome: "failure", reason: "password_reset_required" });
    return json({ error: { code: "PASSWORD_RESET_REQUIRED", message: "Password reset is required before continuing" } }, 403);
  }

  if (!verifyPassword(password, user.password_hash)) {
    await lockout.registerLoginFailure({ email, ipAddress, userId: user.id, userAgent, reason: "invalid_password" });
    await appendEvent({ user_id: user.id, outcome: "failure", reason: "invalid_password" });
    return json({ error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password" } }, 401);
  }

  await lockout.resetLoginCounters({ email, ipAddress });

  const issued = await sessions.issueSession({
    id: crypto.randomUUID(),
    user_id: user.id,
    session_token_hash: hashPassword(`${user.id}:${Date.now()}:${randomBytes(32).toString("base64url")}`),
    ip_address: ipAddress,
    user_agent: userAgent,
    trusted_device: false,
    last_seen_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString(),
  });

  const twoFactorStatus = await twoFactor.getEnrollmentStatus(user.id);

  if (twoFactorStatus.enrolled) {
    session?.set("pendingTwoFactor", {
      userId: user.id,
      sessionId: issued.id,
      sessionStrength: "password",
      twoFactorSatisfied: false,
    });

    await appendEvent({ user_id: user.id, outcome: "success", reason: "password_login_requires_2fa" });

    return json({
      success: false,
      requiresTwoFactor: true,
      challenge: {
        type: "totp",
      },
      session: {
        id: issued.id,
        trusted_device: issued.trusted_device,
        expires_at: issued.expires_at,
        sessionStrength: "password",
      },
    }, 202);
  }

  session?.set("user", { id: user.id });
  session?.set("identitySession", { id: issued.id, sessionStrength: "password", twoFactorSatisfied: false });

  await users.updateUser(user.id, { last_login_at: new Date().toISOString() });
  await appendEvent({ user_id: user.id, outcome: "success", reason: "password_login" });

  return json({
    success: true,
    user: {
      id: user.id,
      email: user.email,
      name: user.name ?? user.display_name ?? null,
      role: user.role,
    },
    session: {
      id: issued.id,
      trusted_device: issued.trusted_device,
      expires_at: issued.expires_at,
      sessionStrength: "password",
    },
  });
}
