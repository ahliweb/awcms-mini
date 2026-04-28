import { defineMiddleware } from "astro:middleware";
import { runWithContext } from "emdash";

import { getDatabase } from "../db/index.mjs";
import { handleAuthLogin } from "./handlers/login.mjs";
import { handleAuthMe } from "./handlers/me.mjs";
import { handleAuthLogout } from "./handlers/logout.mjs";
import { handleAuthTwoFactorChallengeVerify } from "./handlers/two-factor-challenge.mjs";
import { handleAuthTwoFactorEnroll, handleAuthTwoFactorVerify } from "./handlers/two-factor-enroll.mjs";
import { handleAuthTwoFactorStepUpVerify } from "./handlers/two-factor-step-up.mjs";
import { isMiniAdminLoginPath, isMiniAdminShellPath, isMiniSetupShellPath } from "./middleware-paths.mjs";
import { createSessionService } from "../services/sessions/service.mjs";
import { redirectAdminEntryAlias, redirectAdminHostEntry } from "./admin-host-routing.mjs";

function redirectToPath(url, pathname) {
  const location = new URL(pathname, url);

  return new Response(null, {
    status: 302,
    headers: {
      Location: `${location.pathname}${location.search}`,
    },
  });
}

async function handleMiniAuthRequest(context, next) {
  const adminEntryAliasRedirect = redirectAdminEntryAlias(context.url);
  const isSetupShellRoute = isMiniSetupShellPath(context.url.pathname);
  const isAdminShellRoute = isMiniAdminShellPath(context.url.pathname);
  const isLoginShellRoute = isMiniAdminLoginPath(context.url.pathname);

  if (adminEntryAliasRedirect) {
    return adminEntryAliasRedirect;
  }

  const hostRedirect = redirectAdminHostEntry(context.url);

  if (hostRedirect) {
    return hostRedirect;
  }

  if (isAdminShellRoute && !isSetupShellRoute && !isLoginShellRoute) {
    const sessionUser = await context.session?.get("user");
    const identitySession = await context.session?.get("identitySession");

    if (!sessionUser?.id || !identitySession?.id) {
      return redirectToPath(context.url, "/_emdash/admin/login");
    }
  }

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

  if (context.url.pathname === "/_emdash/api/auth/2fa/enroll" && context.request.method === "POST") {
    return handleAuthTwoFactorEnroll({
      session: context.session,
      db: getDatabase(),
    });
  }

  if (context.url.pathname === "/_emdash/api/auth/2fa/verify" && context.request.method === "POST") {
    return handleAuthTwoFactorVerify({
      request: context.request,
      session: context.session,
      db: getDatabase(),
    });
  }

  if (context.url.pathname === "/_emdash/api/auth/2fa/challenge/verify" && context.request.method === "POST") {
    return handleAuthTwoFactorChallengeVerify({
      request: context.request,
      session: context.session,
      db: getDatabase(),
    });
  }

  if (context.url.pathname === "/_emdash/api/auth/2fa/step-up/verify" && context.request.method === "POST") {
    return handleAuthTwoFactorStepUpVerify({
      request: context.request,
      session: context.session,
      db: getDatabase(),
    });
  }

  const response = await next();

  if (isSetupShellRoute) {
    return response;
  }

  try {
    const sessionRecord = await context.session?.get("identitySession");
    if (!sessionRecord?.id) {
      return response;
    }

    const sessions = createSessionService({ database: getDatabase() });
    const refreshed = await sessions.refreshSession(sessionRecord.id, new Date().toISOString());

    if (!refreshed) {
      context.session?.destroy?.();
    }
  } catch {
    // Do not block responses on best-effort session refresh.
  }

  return response;
}

export const onRequest = defineMiddleware(async (context, next) => {
  return runWithContext({ editMode: false }, () => handleMiniAuthRequest(context, next));
});
