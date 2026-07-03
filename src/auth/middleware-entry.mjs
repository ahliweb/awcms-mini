import { defineMiddleware } from "astro:middleware";

import { runWithContext } from "../cms/context.mjs";
import { applyHyperdriveBindingFromEnv } from "../db/index.mjs";

import { redirectAdminEntryAlias, redirectAdminHostEntry } from "./admin-host-routing.mjs";

/**
 * Di runtime Cloudflare Worker, connection string Hyperdrive tersedia sebagai
 * binding `env.HYPERDRIVE.connectionString` (bukan process.env). Inject-kan
 * sebelum DB diakses agar transport "hyperdrive" memakainya. No-op di runtime
 * non-Worker (Node/Hono) — binding tidak ada, jadi config statis tetap dipakai.
 */
function injectHyperdriveBinding(context) {
  applyHyperdriveBindingFromEnv(context.locals?.runtime?.env);
}

async function handleMiniAuthRequest(context, next) {
  const adminEntryAliasRedirect = redirectAdminEntryAlias(context.url);

  if (adminEntryAliasRedirect) {
    return adminEntryAliasRedirect;
  }

  const hostRedirect = redirectAdminHostEntry(context.url);

  if (hostRedirect) {
    return hostRedirect;
  }

  return next();
}

export const onRequest = defineMiddleware(async (context, next) => {
  injectHyperdriveBinding(context);
  return runWithContext({ editMode: false }, () => handleMiniAuthRequest(context, next));
});
