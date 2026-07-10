/**
 * Pure client-side view-model helpers for the `/admin/analytics` dashboard
 * (Issue #622, epic: visitor analytics #617-#624). No DOM, no `fetch`, no
 * `process.env` here — these functions are imported both by
 * `src/pages/admin/analytics.astro`'s client `<script>` (Vite bundles a
 * plain `import` from a page's script the same as anywhere else in the
 * app, see `src/lib/ui/admin-form-client.ts`'s own doc comment) AND by
 * this file's own unit tests, so the dashboard's loading/empty/error-state
 * decisions and raw-detail-null formatting are testable without a browser
 * or a live server (`tests/unit/visitor-analytics-dashboard-view.test.ts`).
 *
 * **Never a second authorization gate.** `visitor_analytics.raw_detail.read`
 * is checked exactly once, server-side, in
 * `domain/analytics-response-shaping.ts`'s `shapeVisitorSession`/
 * `shapeVisitEvent` (Issue #621) — a caller without that permission always
 * receives `null` for `ipAddress`/`ipHash`/`userAgentHash`/
 * `loginIdentifierSnapshot`, regardless of anything this file does.
 * `buildSessionRowCells`'s `showRawDetailColumns` option below only
 * decides whether the dashboard bothers to render four columns that would
 * otherwise be a wall of placeholder dashes for a caller who will never
 * see a real value in them — a presentation nicety, not a security
 * decision. It can never cause a leak: whatever ends up on screen for
 * those four fields always passes through `displayOrPlaceholder` on
 * whatever the API actually returned, never a value this file invents or
 * gates on its own.
 */

export const DASHBOARD_VALUE_PLACEHOLDER = "—"; // em dash — never render the literal "null"/"undefined".

/**
 * Renders a possibly-null/blank field as-is, or the shared placeholder.
 * The one place every raw-detail column (and every other nullable display
 * field) funnels through, so a `null` the API sent back (caller lacks
 * `raw_detail.read`, or the value was simply never collected — e.g. raw IP
 * collection is off) always renders as a harmless dash, never the string
 * `"null"` a naive `String(value)` would produce.
 */
export function displayOrPlaceholder(value: string | null | undefined): string {
  if (value === null || value === undefined) return DASHBOARD_VALUE_PLACEHOLDER;
  const trimmed = value.trim();
  return trimmed.length === 0 ? DASHBOARD_VALUE_PLACEHOLDER : value;
}

export type NamedCountLike = { name: string; count: number };

/** A "top N" list section (top pages/browsers/devices/countries/bot reasons) is empty when there is nothing to show, or every count is zero. */
export function isNamedCountListEmpty(list: NamedCountLike[]): boolean {
  return list.length === 0 || list.every((item) => item.count === 0);
}

export type RealtimeStatsLike = {
  onlineHumanCount: number;
  onlineAdminCount: number;
  onlinePublicCount: number;
  onlineApiCount: number;
};

export function isRealtimeAllZero(stats: RealtimeStatsLike): boolean {
  return (
    stats.onlineHumanCount === 0 &&
    stats.onlineAdminCount === 0 &&
    stats.onlinePublicCount === 0 &&
    stats.onlineApiCount === 0
  );
}

export type SummaryLike = {
  humanUniqueVisitors: number;
  humanPageviews: number;
  botPageviews: number;
};

export function isSummaryEmpty(summary: SummaryLike): boolean {
  return (
    summary.humanUniqueVisitors === 0 &&
    summary.humanPageviews === 0 &&
    summary.botPageviews === 0
  );
}

export type SecurityViewLike = { botPageviews: number };

export function isSecurityViewEmpty(view: SecurityViewLike): boolean {
  return view.botPageviews === 0;
}

/**
 * The four states doc 14 §State pattern mandates for any data widget
 * (loading/empty/error/ready — `.claude/skills/awcms-mini-ui-screen`
 * checklist item 3). `resolveSectionState` is the single place a section
 * turns "did the fetch succeed, and is the payload empty" into one of
 * those four — the caller supplies `"loading"` directly (no fetch attempt
 * made yet) and never calls this function for that state.
 */
export type SectionState = "empty" | "error" | "ready";

/**
 * `fetchOk` false, or `data` `null`, always resolves to `"error"` — never
 * silently falls through to `"empty"` (a real fetch failure must never be
 * presented to the operator as "no data exists yet", doc 10 guardrail:
 * denial/failure is never indistinguishable from an empty result).
 */
export function resolveSectionState<T>(
  fetchOk: boolean,
  data: T | null,
  isEmpty: (data: T) => boolean
): SectionState {
  if (!fetchOk || data === null) return "error";
  return isEmpty(data) ? "empty" : "ready";
}

export const ANALYTICS_AREA_FILTERS = [
  "all",
  "admin",
  "public",
  "api"
] as const;
export type AnalyticsAreaFilter = (typeof ANALYTICS_AREA_FILTERS)[number];

export const ANALYTICS_VISITOR_TYPE_FILTERS = ["all", "human", "bot"] as const;
export type AnalyticsVisitorTypeFilter =
  (typeof ANALYTICS_VISITOR_TYPE_FILTERS)[number];

/**
 * Client-side row filter for the active-sessions table (Issue #622's
 * "Area"/"Visitor type" filters). This is a display filter over rows the
 * caller is ALREADY authorized to see in full (the `GET
 * /api/v1/analytics/sessions` page already fetched) — never a substitute
 * for, or a second copy of, the server's own ABAC/raw-detail gating.
 *
 * Scope note: none of the aggregate endpoints (`/summary`, `/pages`,
 * `/devices`, `/locations`, `/security`) accept an `area` or visitor-type
 * query parameter (Issue #621 as shipped) — adding one is an API change,
 * out of scope for this UI-only issue. The Area/Visitor-type filters
 * therefore only ever narrow the active-sessions table's already-fetched
 * rows; the range-scoped aggregate cards above it are filtered by `range`
 * alone (a parameter the API genuinely supports). See
 * `src/pages/admin/analytics.astro`'s own doc comment for the same note.
 */
export function matchesAreaFilter(
  area: string,
  filter: AnalyticsAreaFilter
): boolean {
  if (filter === "all") return true;
  if (filter === "api")
    return area === "api" || area === "auth" || area === "setup";
  return area === filter;
}

export function matchesVisitorTypeFilter(
  isHuman: boolean,
  filter: AnalyticsVisitorTypeFilter
): boolean {
  if (filter === "all") return true;
  return filter === "human" ? isHuman : !isHuman;
}

/** Structural subset of `domain/analytics-response-shaping.ts`'s `VisitorSessionDto` this file actually reads — a local shape instead of importing the application-facing DTO type keeps this domain module free of a cross-layer dependency (this module's own convention: domain files never import from `application/`). */
export type SessionRowLike = {
  area: string;
  currentPath: string | null;
  browserName: string | null;
  osName: string | null;
  deviceType: string | null;
  isHuman: boolean;
  countryCode: string | null;
  ipAddress: string | null;
  ipHash: string | null;
  userAgentHash: string | null;
  loginIdentifierSnapshot: string | null;
};

export type SessionRowCells = {
  area: string;
  currentPath: string;
  browser: string;
  os: string;
  device: string;
  visitorType: string;
  country: string;
  raw: {
    ipAddress: string;
    ipHash: string;
    userAgentHash: string;
    loginIdentifier: string;
  } | null;
};

/**
 * Turns one already-shaped session row into display-ready strings for the
 * active-sessions table. `raw` is `null` when `showRawDetailColumns` is
 * `false` (caller lacks `visitor_analytics.raw_detail.read` — see this
 * file's own header comment for why that is presentation-only, not a
 * second gate); when non-null, every one of its four fields still goes
 * through `displayOrPlaceholder`, so a permitted caller who happens to
 * view a session where the API itself returned `null` (e.g. raw IP
 * collection was off for that request) still sees a placeholder, never
 * the literal string `"null"`.
 */
export function buildSessionRowCells(
  session: SessionRowLike,
  options: {
    showRawDetailColumns: boolean;
    humanLabel: string;
    botLabel: string;
  }
): SessionRowCells {
  return {
    area: session.area,
    currentPath: displayOrPlaceholder(session.currentPath),
    browser: displayOrPlaceholder(session.browserName),
    os: displayOrPlaceholder(session.osName),
    device: displayOrPlaceholder(session.deviceType),
    visitorType: session.isHuman ? options.humanLabel : options.botLabel,
    country: displayOrPlaceholder(session.countryCode),
    raw: options.showRawDetailColumns
      ? {
          ipAddress: displayOrPlaceholder(session.ipAddress),
          ipHash: displayOrPlaceholder(session.ipHash),
          userAgentHash: displayOrPlaceholder(session.userAgentHash),
          loginIdentifier: displayOrPlaceholder(session.loginIdentifierSnapshot)
        }
      : null
  };
}
