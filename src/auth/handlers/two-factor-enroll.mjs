import { createTwoFactorService, TwoFactorEnrollmentError } from "../../services/security/two-factor.mjs";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleAuthTwoFactorEnroll({ session, db }) {
  const sessionUser = await session?.get("user");

  if (!sessionUser?.id) {
    return json({ error: { code: "NOT_AUTHENTICATED", message: "Not authenticated" } }, 401);
  }

  const service = createTwoFactorService({ database: db });
  const enrollment = await service.beginEnrollment({ user_id: sessionUser.id });

  return json({
    credentialId: enrollment.credentialId,
    manualKey: enrollment.manualKey,
    otpauthUrl: enrollment.otpauthUrl,
    verified: enrollment.verified,
  });
}

export async function handleAuthTwoFactorVerify({ request, session, db }) {
  const sessionUser = await session?.get("user");

  if (!sessionUser?.id) {
    return json({ error: { code: "NOT_AUTHENTICATED", message: "Not authenticated" } }, 401);
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
    const verified = await service.verifyEnrollment({ user_id: sessionUser.id, code });

    return json({
      success: true,
      verifiedAt: verified.credential.verified_at,
      recoveryCodes: verified.recoveryCodes,
    });
  } catch (error) {
    if (error instanceof TwoFactorEnrollmentError) {
      return json({ error: { code: error.code, message: error.message } }, 400);
    }

    throw error;
  }
}
