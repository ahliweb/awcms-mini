import { defineMiddleware } from "astro:middleware";
import { runWithContext } from "emdash";

import { redirectAdminEntryAlias, redirectAdminHostEntry } from "./admin-host-routing.mjs";

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
  return runWithContext({ editMode: false }, () => handleMiniAuthRequest(context, next));
});
