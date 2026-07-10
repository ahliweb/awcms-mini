/**
 * Raw-detail field omission for the `sessions`/`events` list endpoints
 * (Issue #621, epic: visitor analytics #617-#624). Pure — the caller
 * (route handler) decides `canSeeRawDetail` from whether the requester
 * holds `visitor_analytics.raw_detail.read`; this module only shapes the
 * response once that decision is made. Never the other way around —
 * these functions must never themselves make an authorization decision.
 */

export type VisitorSessionRow = {
  id: string;
  visitor_key_hash: string;
  identity_id: string | null;
  login_identifier_snapshot: string | null;
  is_authenticated: boolean;
  area: string;
  current_path: string | null;
  first_seen_at: Date;
  last_seen_at: Date;
  ip_hash: string | null;
  ip_address: string | null;
  user_agent_hash: string | null;
  browser_name: string | null;
  browser_version_major: string | null;
  os_name: string | null;
  device_type: string | null;
  is_human: boolean;
  bot_reason: string | null;
  country_code: string | null;
  region: string | null;
  city: string | null;
  timezone: string | null;
};

export type VisitorSessionDto = Omit<
  VisitorSessionRow,
  | "ip_hash"
  | "ip_address"
  | "user_agent_hash"
  | "login_identifier_snapshot"
  | "first_seen_at"
  | "last_seen_at"
> & {
  firstSeenAt: string;
  lastSeenAt: string;
  ipHash: string | null;
  ipAddress: string | null;
  userAgentHash: string | null;
  loginIdentifierSnapshot: string | null;
};

export function shapeVisitorSession(
  row: VisitorSessionRow,
  canSeeRawDetail: boolean
): VisitorSessionDto {
  return {
    id: row.id,
    visitor_key_hash: row.visitor_key_hash,
    identity_id: row.identity_id,
    is_authenticated: row.is_authenticated,
    area: row.area,
    current_path: row.current_path,
    firstSeenAt: row.first_seen_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    browser_name: row.browser_name,
    browser_version_major: row.browser_version_major,
    os_name: row.os_name,
    device_type: row.device_type,
    is_human: row.is_human,
    bot_reason: row.bot_reason,
    country_code: row.country_code,
    region: row.region,
    city: row.city,
    timezone: row.timezone,
    loginIdentifierSnapshot: canSeeRawDetail
      ? row.login_identifier_snapshot
      : null,
    ipHash: canSeeRawDetail ? row.ip_hash : null,
    ipAddress: canSeeRawDetail ? row.ip_address : null,
    userAgentHash: canSeeRawDetail ? row.user_agent_hash : null
  };
}

export type VisitEventRow = {
  id: string;
  visitor_session_id: string | null;
  identity_id: string | null;
  occurred_at: Date;
  method: string;
  status_code: number | null;
  area: string;
  route_pattern: string | null;
  path_sanitized: string;
  referrer_domain: string | null;
  duration_ms: number | null;
  ip_hash: string | null;
  user_agent_hash: string | null;
  user_agent_parsed: Record<string, unknown>;
  geo: Record<string, unknown>;
  human_status: string;
  correlation_id: string | null;
};

export type VisitEventDto = Omit<
  VisitEventRow,
  "ip_hash" | "user_agent_hash" | "occurred_at"
> & {
  occurredAt: string;
  ipHash: string | null;
  userAgentHash: string | null;
};

export function shapeVisitEvent(
  row: VisitEventRow,
  canSeeRawDetail: boolean
): VisitEventDto {
  return {
    id: row.id,
    visitor_session_id: row.visitor_session_id,
    identity_id: row.identity_id,
    occurredAt: row.occurred_at.toISOString(),
    method: row.method,
    status_code: row.status_code,
    area: row.area,
    route_pattern: row.route_pattern,
    path_sanitized: row.path_sanitized,
    referrer_domain: row.referrer_domain,
    duration_ms: row.duration_ms,
    user_agent_parsed: row.user_agent_parsed,
    geo: row.geo,
    human_status: row.human_status,
    correlation_id: row.correlation_id,
    ipHash: canSeeRawDetail ? row.ip_hash : null,
    userAgentHash: canSeeRawDetail ? row.user_agent_hash : null
  };
}
