/**
 * Request area classification (Issue #620, epic: visitor analytics
 * #617-#624). Pure — matches `awcms_mini_visitor_sessions`/
 * `awcms_mini_visit_events`'s own `area` CHECK constraint
 * (`admin|public|api|auth|setup|unknown`, migration 039) exactly.
 *
 * `auth`/`setup` are sub-classifications of API space (`/api/v1/auth/*`,
 * `/api/v1/setup/*`), not page renders — a real page like `/login` is
 * `public`, same as any other rendered page, since it is gated by
 * `VISITOR_ANALYTICS_COLLECT_PUBLIC` (page-render volume), not
 * `VISITOR_ANALYTICS_COLLECT_API` (JSON-endpoint-call volume). This split
 * lets a future dashboard distinguish login/setup API traffic from
 * general API traffic without changing the collect-gate logic in
 * `application/collector.ts`.
 */
export type RequestArea =
  "admin" | "public" | "api" | "auth" | "setup" | "unknown";

export function determineArea(pathname: string): RequestArea {
  if (pathname.startsWith("/admin")) return "admin";
  if (pathname.startsWith("/api/v1/setup")) return "setup";
  if (pathname.startsWith("/api/v1/auth")) return "auth";
  if (pathname.startsWith("/api")) return "api";
  return "public";
}

/** True for every area gated by `VISITOR_ANALYTICS_COLLECT_API` (anything under `/api`). */
export function isApiArea(area: RequestArea): boolean {
  return area === "api" || area === "auth" || area === "setup";
}
