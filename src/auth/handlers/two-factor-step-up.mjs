import { createTwoFactorService, TwoFactorChallengeError } from "../../services/security/two-factor.mjs";

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

  try {
    if (recoveryCode) {
      await service.verifyRecoveryCodeChallenge({ user_id: sessionUser.id, code: recoveryCode });
    } else {
      await service.verifyChallenge({ user_id: sessionUser.id, code });
    }
  } catch (error) {
    if (error instanceof TwoFactorChallengeError) {
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
