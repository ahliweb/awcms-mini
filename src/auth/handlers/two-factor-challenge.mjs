import { createTwoFactorService, TwoFactorChallengeError } from "../../services/security/two-factor.mjs";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleAuthTwoFactorChallengeVerify({ request, session, db }) {
  const pendingTwoFactor = await session?.get("pendingTwoFactor");

  if (!pendingTwoFactor?.userId || !pendingTwoFactor?.sessionId) {
    return json({ error: { code: "TWO_FACTOR_NOT_PENDING", message: "No pending two-factor challenge found" } }, 400);
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return json({ error: { code: "INVALID_BODY", message: "Expected JSON body" } }, 400);
  }

  const code = typeof body?.code === "string" ? body.code.trim() : "";

  if (!code) {
    return json({ error: { code: "INVALID_CODE", message: "TOTP code is required" } }, 400);
  }

  const service = createTwoFactorService({ database: db });

  try {
    await service.verifyChallenge({ user_id: pendingTwoFactor.userId, code });
  } catch (error) {
    if (error instanceof TwoFactorChallengeError) {
      return json({ error: { code: error.code, message: error.message } }, 400);
    }

    throw error;
  }

  session?.set("user", { id: pendingTwoFactor.userId });
  session?.set("identitySession", {
    id: pendingTwoFactor.sessionId,
    sessionStrength: "two_factor",
    twoFactorSatisfied: true,
  });
  session?.set("pendingTwoFactor", null);

  return json({
    success: true,
    session: {
      id: pendingTwoFactor.sessionId,
      sessionStrength: "two_factor",
      twoFactorSatisfied: true,
    },
  });
}
