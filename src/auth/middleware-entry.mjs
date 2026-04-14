import { defineMiddleware } from "astro:middleware";
import { runWithContext } from "emdash";

import { getDatabase } from "../db/index.mjs";
import { handleAuthLogin } from "./handlers/login.mjs";
import { handleAuthMe } from "./handlers/me.mjs";
import { handleAuthLogout } from "./handlers/logout.mjs";
import { createSessionService } from "../services/sessions/service.mjs";

async function handleMiniAuthRequest(context, next) {
  const database = getDatabase();

  if (context.url.pathname === "/_emdash/api/auth/login" && context.request.method === "POST") {
    return handleAuthLogin({
      request: context.request,
      session: context.session,
      db: database,
    });
  }

  if (context.url.pathname === "/_emdash/api/auth/logout" && context.request.method === "POST") {
    return handleAuthLogout({
      request: context.request,
      session: context.session,
      url: context.url,
      db: database,
    });
  }

  if (context.url.pathname === "/_emdash/api/auth/me" && context.request.method === "GET") {
    return handleAuthMe({
      session: context.session,
      db: database,
    });
  }

  const response = await next();

  try {
    const sessionRecord = await context.session?.get("identitySession");
    if (!sessionRecord?.id) {
      return response;
    }

    const sessions = createSessionService({ database });
    await sessions.refreshSession(sessionRecord.id, new Date().toISOString());
  } catch {
    // Do not block responses on best-effort session refresh.
  }

  return response;
}

export const onRequest = defineMiddleware(async (context, next) => {
  return runWithContext({ editMode: false, db: getDatabase() }, () => handleMiniAuthRequest(context, next));
});
