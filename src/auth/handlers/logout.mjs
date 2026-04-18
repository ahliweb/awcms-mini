import { createLoginSecurityEventRepository } from "../../db/repositories/login-security-events.mjs";
import { createSessionService } from "../../services/sessions/service.mjs";
import { resolveTrustedClientIp } from "../../security/client-ip.mjs";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleAuthLogout({ request, session, url, db }) {
  const sessionUser = await session?.get("user");
  const identitySession = await session?.get("identitySession");

  if (identitySession?.id) {
    const sessions = createSessionService({ database: db });
    await sessions.revokeSession(identitySession.id);
  }

  if (sessionUser?.id) {
    const loginEvents = createLoginSecurityEventRepository(db);
    await loginEvents.appendEvent({
      id: crypto.randomUUID(),
      user_id: sessionUser.id,
      event_type: "logout",
      outcome: "success",
      reason: "session_logout",
      ip_address: resolveTrustedClientIp(request),
      user_agent: request.headers.get("user-agent"),
    });
  }

  session?.destroy();

  const redirect = url.searchParams.get("redirect");
  if (redirect && redirect.startsWith("/")) {
    return new Response(null, { status: 302, headers: { Location: redirect } });
  }

  return json({ success: true, message: "Logged out successfully" });
}
