import { createTwoFactorService, TwoFactorChallengeError } from "../../services/security/two-factor.mjs";
import { createSecurityEventRepository } from "../../db/repositories/security-events.mjs";
import { createAuditService } from "../../services/audit/service.mjs";
import { resolveTrustedClientIp } from "../../security/client-ip.mjs";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleAuthTwoFactorStepUpVerify({ request, session, db, now = () => new Date().toISOString() }) {
  const sessionUser = await session?.get("user");
  const identitySession = await session?.get("identitySession");

  if (!sessionUser?.id || !identitySession?.id) {
    return json({ error: { code: "NOT_AUTHENTICATED", message: "Not authenticated" } }, 401);
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return json({ error: { code: "INVALID_BODY", message: "Expected JSON body" } }, 400);
  }

  const code = typeof body?.code === "string" ? body.code.trim() : "";
  const recoveryCode = typeof body?.recoveryCode === "string" ? body.recoveryCode.trim() : "";

  if (!code && !recoveryCode) {
    return json({ error: { code: "INVALID_CODE", message: "TOTP code or recovery code is required" } }, 400);
  }

  const service = createTwoFactorService({ database: db });
  const securityEvents = createSecurityEventRepository(db);
  const audit = createAuditService({ database: db });
  const ipAddress = resolveTrustedClientIp(request);
  const userAgent = request.headers.get("user-agent");
  const challengeType = recoveryCode ? "recovery_code" : "totp";

  try {
    if (recoveryCode) {
      await service.verifyRecoveryCodeChallenge({ user_id: sessionUser.id, code: recoveryCode });
    } else {
      await service.verifyChallenge({ user_id: sessionUser.id, code });
    }
  } catch (error) {
    if (error instanceof TwoFactorChallengeError) {
      const occurredAt = now();

      await audit.append({
        actor_user_id: sessionUser.id,
        action: "auth.step_up.failure",
        entity_type: "session",
        entity_id: identitySession.id,
        target_user_id: sessionUser.id,
        ip_address: ipAddress,
        user_agent: userAgent,
        summary: "Rejected step-up authentication attempt.",
        metadata: {
          challenge_type: challengeType,
          error_code: error.code,
        },
        occurred_at: occurredAt,
      });

      await securityEvents.appendEvent({
        id: crypto.randomUUID(),
        user_id: sessionUser.id,
        event_type: "auth.step_up.failure",
        severity: "warning",
        details_json: {
          session_id: identitySession.id,
          challenge_type: challengeType,
          error_code: error.code,
        },
        ip_address: ipAddress,
        user_agent: userAgent,
        occurred_at: occurredAt,
      });

      return json({ error: { code: error.code, message: error.message } }, 400);
    }

    throw error;
  }

  const stepUpAt = now();
  session?.set("identitySession", {
    ...identitySession,
    sessionStrength: "step_up",
    twoFactorSatisfied: true,
    stepUpAuthenticated: true,
    stepUpAt,
  });

  return json({
    success: true,
    session: {
      id: identitySession.id,
      sessionStrength: "step_up",
      twoFactorSatisfied: true,
      stepUpAuthenticated: true,
      stepUpAt,
    },
  });
}
