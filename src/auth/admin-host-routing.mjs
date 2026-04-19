import { getRuntimeConfig } from "../config/runtime.mjs";

function buildSameOriginRedirect(url, pathname) {
  const location = new URL(pathname, url);
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${location.pathname}${location.search}`,
    },
  });
}

export function redirectAdminEntryAlias(requestUrl) {
  if (requestUrl.pathname !== "/_emdash/") {
    return null;
  }

  return buildSameOriginRedirect(requestUrl, "/_emdash/admin");
}

export function redirectAdminHostEntry(requestUrl, runtimeConfig = getRuntimeConfig()) {
  if (!runtimeConfig.adminHostRouting?.enabled || !runtimeConfig.adminSiteUrl) {
    return null;
  }

  let adminUrl;

  try {
    adminUrl = new URL(runtimeConfig.adminSiteUrl);
  } catch {
    return null;
  }

  if (requestUrl.hostname !== adminUrl.hostname) {
    return null;
  }

  if (requestUrl.pathname !== "/") {
    return null;
  }

  return buildSameOriginRedirect(requestUrl, runtimeConfig.adminHostRouting.adminEntryPath);
}
