import { defineMiddleware } from "astro:middleware";

import { getDatabase } from "../db/index.mjs";
import { handleAuthLogin } from "./handlers/login.mjs";
import { handleAuthMe } from "./handlers/me.mjs";
import { handleAuthLogout } from "./handlers/logout.mjs";
import { createSessionService } from "../services/sessions/service.mjs";

export const onRequest = defineMiddleware(async (context, next) => {
  if (context.url.pathname === "/_emdash/api/auth/login" && context.request.method === "POST") {
    return handleAuthLogin({
      request: context.request,
      session: context.session,
      db: getDatabase(),
    });
  }

  if (context.url.pathname === "/_emdash/api/auth/logout" && context.request.method === "POST") {
    return handleAuthLogout({
      request: context.request,
      session: context.session,
      url: context.url,
      db: getDatabase(),
    });
  }

  if (context.url.pathname === "/_emdash/api/auth/me" && context.request.method === "GET") {
    return handleAuthMe({
      session: context.session,
      db: getDatabase(),
    });
  }

  const response = await next();

  try {
    const sessionRecord = await context.session?.get("identitySession");
    if (!sessionRecord?.id) {
      return response;
    }

    const sessions = createSessionService({ database: getDatabase() });
    await sessions.refreshSession(sessionRecord.id, new Date().toISOString());
  } catch {
    // Do not block responses on best-effort session refresh.
  }

  return response;
});
