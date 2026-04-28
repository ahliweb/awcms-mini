export function isMiniSetupShellPath(pathname) {
  return pathname.startsWith("/_emdash/admin/setup");
}

export function isMiniAdminShellPath(pathname) {
  return pathname === "/_emdash/admin" || pathname.startsWith("/_emdash/admin/");
}

export function isMiniAdminLoginPath(pathname) {
  return pathname === "/_emdash/admin/login" || pathname.startsWith("/_emdash/admin/login/");
}
