import { createPasswordResetService, PasswordResetError } from "../../services/security/password-reset.mjs";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handlePasswordResetRequest({ request, db }) {
  let body;

  try {
    body = await request.json();
  } catch {
    return json({ error: { code: "INVALID_BODY", message: "Expected JSON body" } }, 400);
  }

  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";

  if (!email) {
    return json({ error: { code: "INVALID_EMAIL", message: "Email is required" } }, 400);
  }

  const service = createPasswordResetService({ database: db });

  try {
    const issued = await service.requestPasswordReset({ email });
    return json({ success: true, expiresAt: issued.expires_at, token: issued.token });
  } catch (error) {
    if (error instanceof PasswordResetError) {
      return json({ error: { code: error.code, message: error.message } }, 400);
    }

    throw error;
  }
}

export async function handlePasswordResetConsume({ request, db }) {
  let body;

  try {
    body = await request.json();
  } catch {
    return json({ error: { code: "INVALID_BODY", message: "Expected JSON body" } }, 400);
  }

  const token = typeof body?.token === "string" ? body.token.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (!token || !password) {
    return json({ error: { code: "INVALID_REQUEST", message: "Token and password are required" } }, 400);
  }

  const service = createPasswordResetService({ database: db });

  try {
    const user = await service.consumePasswordReset({ token, password });
    return json({ success: true, userId: user.id });
  } catch (error) {
    if (error instanceof PasswordResetError) {
      return json({ error: { code: error.code, message: error.message } }, 400);
    }

    throw error;
  }
}
