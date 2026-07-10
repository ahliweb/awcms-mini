/**
 * Visitor telemetry collector (Issue #620, epic: visitor analytics
 * #617-#624). The only writer of `awcms_mini_visitor_sessions`/
 * `awcms_mini_visit_events` — `src/middleware.ts` is the sole caller,
 * invoked after `next()` so the real response (including its status
 * code) is already known.
 *
 * BINDING (fail-open, acceptance criterion): `collectVisitorTelemetry`
 * never throws — every failure is caught, logged as a `warning` with
 * `correlationId` and no sensitive data, and the request's real response
 * is always returned regardless. Analytics must never become a critical
 * availability dependency (security note, `withTenant`'s own
 * `workClass: "background_sync"` reinforces this — the lowest-priority
 * DB work class, doc 16, so a saturated pool queues real interactive/
 * reporting work ahead of telemetry writes, never the reverse).
 *
 * BINDING (Issue #618 security-audit follow-up, recorded in
 * `.claude/skills/awcms-mini-visitor-analytics/SKILL.md`): `identityId`
 * must always be the caller's own server-derived authenticated identity
 * (`ssrContext.identityId` for `/admin/*`, `null` for every public
 * request) — never a client-supplied value — and `visitor_session_id` is
 * always resolved from a session row this function itself just found or
 * created inside its own tenant-scoped transaction, never from a raw
 * client-supplied UUID. Neither FK is ever fed a client-controlled value
 * directly, closing the cross-tenant existence-oracle risk that audit
 * flagged ahead of time.
 */
import { withTenant } from "../../../lib/database/tenant-context";
import { log } from "../../../lib/logging/logger";
import { isTrackablePath, sanitizePath } from "../domain/path-sanitizer";
import { extractReferrerDomain } from "../domain/referrer";
import { determineArea, type RequestArea } from "../domain/request-area";
import {
  classifyHumanStatus,
  classifySessionHumanity
} from "../domain/human-classifier";
import { parseUserAgent, type ParsedUserAgent } from "../domain/user-agent";
import {
  hashIpAddress,
  hashUserAgent,
  hashVisitorKey
} from "../domain/visitor-key";
import type { VisitorAnalyticsConfig } from "../domain/visitor-analytics-config";

/**
 * A session row already updated within this many seconds is left alone —
 * `last_seen_at` still reflects "recently active" for realtime-presence
 * purposes without a write on every single request from the same
 * visitor (issue's own "Recommended write-throttle behavior"). Not
 * env-tunable — a small, fixed constant, same convention as the
 * work-class concurrency limits (`lib/database/work-class.ts`).
 */
const SESSION_UPDATE_THROTTLE_MS = 30_000;

/**
 * Gates whether the collector should do anything at all for this
 * request — pure, so it's independently unit-testable without a
 * database. `pathname` must be the RAW (unsanitized) path; static/
 * internal/health/spec paths are excluded regardless of every other
 * flag (an operator cannot "opt back in" to counting `/_astro/*` as a
 * pageview).
 */
export function shouldCollectRequest(input: {
  pathname: string;
  area: RequestArea;
  config: VisitorAnalyticsConfig;
}): boolean {
  const { pathname, area, config } = input;

  if (!config.enabled) return false;
  if (!isTrackablePath(pathname)) return false;
  if (area === "admin") return config.collectAdmin;
  if (pathname.startsWith("/api")) return config.collectApi;

  return config.collectPublic;
}

export type CollectVisitorTelemetryInput = {
  sql: Bun.SQL;
  tenantId: string;
  correlationId: string;
  config: VisitorAnalyticsConfig;
  method: string;
  /** Raw path (with query string), NOT yet sanitized — this function sanitizes it. */
  rawPath: string;
  statusCode: number | null;
  /** Resolved by the caller from the visitor cookie (`resolveVisitorKey`). */
  visitorKey: string;
  ipAddress: string | null;
  userAgent: string | null;
  referrerHeader: string | null;
  isAuthenticated: boolean;
  /** Server-derived from the caller's own authenticated session — see file header note. */
  identityId: string | null;
};

type SessionRow = { id: string; last_seen_at: string };

async function upsertVisitorSession(
  tx: Bun.SQL,
  input: {
    tenantId: string;
    area: RequestArea;
    visitorKeyHash: string;
    pathSanitized: string;
    ipHash: string | null;
    rawIpAddress: string | null;
    userAgentHash: string | null;
    parsedUserAgent: ParsedUserAgent;
    isHuman: boolean;
    botReason: string | null;
    isAuthenticated: boolean;
    identityId: string | null;
    onlineWindowSeconds: number;
  }
): Promise<string> {
  const existingRows = (await tx`
    SELECT id, last_seen_at FROM awcms_mini_visitor_sessions
    WHERE tenant_id = ${input.tenantId}
      AND visitor_key_hash = ${input.visitorKeyHash}
      AND area = ${input.area}
    ORDER BY last_seen_at DESC
    LIMIT 1
  `) as SessionRow[];

  const existing = existingRows[0];
  const nowMs = Date.now();
  const lastSeenMs = existing
    ? new Date(existing.last_seen_at).getTime()
    : null;
  const withinSameSession =
    lastSeenMs !== null &&
    nowMs - lastSeenMs <= input.onlineWindowSeconds * 1000;

  if (existing && withinSameSession) {
    const dueForWrite =
      lastSeenMs === null || nowMs - lastSeenMs >= SESSION_UPDATE_THROTTLE_MS;

    if (dueForWrite) {
      await tx`
        UPDATE awcms_mini_visitor_sessions
        SET last_seen_at = now(),
            current_path = ${input.pathSanitized},
            is_human = ${input.isHuman},
            bot_reason = ${input.botReason},
            browser_name = ${input.parsedUserAgent.browserName},
            browser_version_major = ${input.parsedUserAgent.browserVersionMajor},
            os_name = ${input.parsedUserAgent.osName},
            device_type = ${input.parsedUserAgent.deviceType},
            updated_at = now()
        WHERE id = ${existing.id}
      `;
    }

    return existing.id;
  }

  // No recent session for this visitor+area — start a new one.
  // login_identifier_snapshot is deliberately always null here (see
  // README §Domain helpers/§Not yet available): it's a nullable display
  // convenience, not a functional requirement, and populating it would
  // need an extra identities lookup on every new session — deferred
  // rather than added speculatively (never populated for anonymous
  // visitors either way, satisfying the binding privacy rule either way).
  const insertedRows = (await tx`
    INSERT INTO awcms_mini_visitor_sessions
      (tenant_id, visitor_key_hash, identity_id, login_identifier_snapshot,
       is_authenticated, area, current_path, ip_hash, ip_address,
       user_agent_hash, browser_name, browser_version_major, os_name,
       device_type, is_human, bot_reason)
    VALUES (
      ${input.tenantId}, ${input.visitorKeyHash}, ${input.identityId}, null,
      ${input.isAuthenticated}, ${input.area}, ${input.pathSanitized},
      ${input.ipHash}, ${input.rawIpAddress}, ${input.userAgentHash},
      ${input.parsedUserAgent.browserName}, ${input.parsedUserAgent.browserVersionMajor},
      ${input.parsedUserAgent.osName}, ${input.parsedUserAgent.deviceType},
      ${input.isHuman}, ${input.botReason}
    )
    RETURNING id
  `) as { id: string }[];

  return insertedRows[0]!.id;
}

/**
 * Writes one `awcms_mini_visit_events` row and creates/refreshes the
 * matching `awcms_mini_visitor_sessions` row. Never throws — see the
 * file header's fail-open note. Callers should still check
 * `shouldCollectRequest` first (cheap, no DB) to avoid the function-call
 * overhead for requests that will be skipped anyway, but this function
 * re-checks `isTrackablePath` itself as defense in depth.
 */
export async function collectVisitorTelemetry(
  input: CollectVisitorTelemetryInput
): Promise<void> {
  const {
    sql,
    tenantId,
    correlationId,
    config,
    method,
    rawPath,
    statusCode,
    visitorKey,
    ipAddress,
    userAgent,
    referrerHeader,
    isAuthenticated,
    identityId
  } = input;

  try {
    if (!isTrackablePath(rawPath)) return;

    const area = determineArea(rawPath.split("?")[0] ?? rawPath);
    const pathSanitized = sanitizePath(rawPath);
    const parsedUserAgent = parseUserAgent(userAgent);
    const humanStatus = classifyHumanStatus({
      isAuthenticated,
      parsedUserAgent
    });
    const sessionHumanity = classifySessionHumanity({
      isAuthenticated,
      parsedUserAgent
    });
    const visitorKeyHash = hashVisitorKey(visitorKey, config.hashSalt);
    const ipHash = ipAddress ? hashIpAddress(ipAddress, config.hashSalt) : null;
    const userAgentHash = userAgent
      ? hashUserAgent(userAgent, config.hashSalt)
      : null;
    const rawIpAddress = config.rawIpEnabled ? ipAddress : null;
    const referrerDomain = extractReferrerDomain(referrerHeader);

    await withTenant(
      sql,
      tenantId,
      async (tx) => {
        const sessionId = await upsertVisitorSession(tx, {
          tenantId,
          area,
          visitorKeyHash,
          pathSanitized,
          ipHash,
          rawIpAddress,
          userAgentHash,
          parsedUserAgent,
          isHuman: sessionHumanity.isHuman,
          botReason: sessionHumanity.botReason,
          isAuthenticated,
          identityId,
          onlineWindowSeconds: config.onlineWindowSeconds
        });

        const userAgentParsed = JSON.stringify({
          browserName: parsedUserAgent.browserName,
          browserVersionMajor: parsedUserAgent.browserVersionMajor,
          osName: parsedUserAgent.osName,
          deviceType: parsedUserAgent.deviceType
        });

        await tx`
          INSERT INTO awcms_mini_visit_events
            (tenant_id, visitor_session_id, identity_id, method, status_code,
             area, path_sanitized, referrer_domain, ip_hash, user_agent_hash,
             user_agent_parsed, geo, human_status, correlation_id)
          VALUES (
            ${tenantId}, ${sessionId}, ${identityId}, ${method}, ${statusCode},
            ${area}, ${pathSanitized}, ${referrerDomain}, ${ipHash}, ${userAgentHash},
            ${userAgentParsed}::jsonb, '{}'::jsonb, ${humanStatus}, ${correlationId}
          )
        `;
      },
      { workClass: "background_sync" }
    );
  } catch (error) {
    log("warning", "visitor_analytics.collector.failed", {
      correlationId,
      tenantId,
      moduleKey: "visitor_analytics",
      error: error instanceof Error ? error.message : "unknown error"
    });
  }
}
