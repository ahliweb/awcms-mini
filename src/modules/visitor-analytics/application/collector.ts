/**
 * Visitor telemetry collector (Issue #620, epic: visitor analytics
 * #617-#624). The only writer of `awcms_mini_visitor_sessions`/
 * `awcms_mini_visit_events` — `src/middleware.ts` is the sole caller,
 * invoked after `next()` so the real response (including its status
 * code) is already known.
 *
 * BINDING (fail-open, acceptance criterion): the collector never throws —
 * every failure is caught, logged as a `warning` with `correlationId` and
 * no sensitive data, and the request's real response is always returned
 * regardless. Analytics must never become a critical availability
 * dependency (security note, `withTenant`'s own
 * `workClass: "background_sync"` reinforces this — the lowest-priority
 * DB work class, doc 16, so a saturated pool queues real interactive/
 * reporting work ahead of telemetry writes, never the reverse).
 *
 * BINDING (Issue #618 security-audit follow-up, recorded in
 * `.claude/skills/awcms-mini-visitor-analytics/SKILL.md`): `identityId`
 * must always be the caller's own server-derived authenticated identity
 * (`ssrContext.identityId` for `/admin/*`, `null` for every public
 * request) — never a client-supplied value — and `visitor_session_id` is
 * always resolved from a session row this module itself just found or
 * created inside its own tenant-scoped transaction, never from a raw
 * client-supplied UUID. Neither FK is ever fed a client-controlled value
 * directly, closing the cross-tenant existence-oracle risk that audit
 * flagged ahead of time.
 *
 * ## Shape: pure derivation, then one batched write (Issue #846)
 *
 * This module is split in two:
 *
 * - `buildVisitEventRecord` — **pure**. Turns request-scoped inputs into a
 *   self-contained `VisitEventRecord` of plain values (hashes, parsed UA,
 *   sanitized path, `occurredAt`). No database, no `APIContext`, so it is
 *   safe to hold in a queue and unit-testable without Postgres.
 * - `writeVisitEventBatch` — the **single** write path. Takes N records for
 *   ONE tenant and persists them in ONE transaction.
 *
 * `collectVisitorTelemetry` is retained as a batch-of-one convenience so
 * that a caller wanting an immediate, awaited write (the integration
 * suite) and the production batcher share the exact same writer — there is
 * deliberately no second, "simple" single-row SQL path that could drift
 * away from the batched one.
 *
 * ### Why batching, and why NOT just the INSERT (measured, Issue #846)
 *
 * Issue #846 proposed batching the per-event `visit_event` INSERT. Measured
 * against a real Postgres through a round-trip-counting TCP proxy, the
 * per-event cost decomposed as **5.2 round trips**:
 *
 * | round trip            | count | share |
 * | --------------------- | ----- | ----- |
 * | BEGIN                 | 1     | 19%   |
 * | SET LOCAL tenant      | 1     | 19%   |
 * | SELECT session        | 1     | 19%   |
 * | INSERT visit_event    | 1     | 19%   |
 * | COMMIT                | 1     | 19%   |
 * | UPDATE session (amortized by the 30s throttle) | 0.2 | 4% |
 *
 * So the INSERT the issue named was never the dominant cost — it is one
 * round trip in five. The transaction scaffolding around it (BEGIN + SET
 * LOCAL + COMMIT) is ~58%, and it exists *per event*. Batching only the
 * INSERT would have removed at most ~19% and is in any case impossible in
 * isolation: the INSERT needs `visitor_session_id`, which the SELECT in the
 * same transaction produces.
 *
 * The unit that actually had to be batched is therefore the **transaction**,
 * not the INSERT: N events for one tenant now cost ~5-7 round trips in
 * total instead of 5.2 *each*, because the session lookup, the session
 * writes, and the event insert are each expressed once, set-at-a-time, for
 * the whole batch.
 *
 * This only shows up under real network latency. On loopback the baseline
 * measured 1.43ms/event; with 2ms/hop injected it measured 28.9ms/event —
 * a 20x difference that is pure round-trip cost, i.e. exactly the cost a
 * loopback benchmark hides and batching removes.
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
import type { GeoEnrichment } from "../domain/geo-enrichment";
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
  /** Resolved by the caller from trusted headers only (Issue #623's `resolveGeoEnrichment`) — always all-null when geo enrichment is disabled/untrusted. */
  geo: GeoEnrichment;
};

/**
 * One request's telemetry, fully derived and independent of any
 * request-scoped object. Everything here is a plain value, so a record may
 * be held in a queue and written long after the response was sent.
 *
 * `occurredAt` is captured at BUILD time, not at write time, and is
 * INSERTed explicitly rather than left to the column's `now()` default.
 * Under batching the write can land a few hundred milliseconds after the
 * request; letting `now()` win would silently smear every event's timestamp
 * to its flush instant and quietly corrupt the analytics this module
 * exists to produce.
 */
export type VisitEventRecord = {
  occurredAt: Date;
  correlationId: string;
  method: string;
  statusCode: number | null;
  area: RequestArea;
  pathSanitized: string;
  referrerDomain: string | null;
  visitorKeyHash: string;
  ipHash: string | null;
  rawIpAddress: string | null;
  userAgentHash: string | null;
  parsedUserAgent: ParsedUserAgent;
  humanStatus: string;
  sessionIsHuman: boolean;
  sessionBotReason: string | null;
  isAuthenticated: boolean;
  identityId: string | null;
  onlineWindowSeconds: number;
  geo: GeoEnrichment;
};

/**
 * Pure: derives everything the write needs from one request's inputs.
 * Returns `null` when the path is not trackable (defense in depth — callers
 * should already have consulted `shouldCollectRequest`).
 */
export function buildVisitEventRecord(
  input: Omit<CollectVisitorTelemetryInput, "sql" | "tenantId">,
  occurredAt: Date = new Date()
): VisitEventRecord | null {
  if (!isTrackablePath(input.rawPath)) return null;

  const area = determineArea(input.rawPath.split("?")[0] ?? input.rawPath);
  const parsedUserAgent = parseUserAgent(input.userAgent);
  const humanStatus = classifyHumanStatus({
    isAuthenticated: input.isAuthenticated,
    parsedUserAgent
  });
  const sessionHumanity = classifySessionHumanity({
    isAuthenticated: input.isAuthenticated,
    parsedUserAgent
  });

  return {
    occurredAt,
    correlationId: input.correlationId,
    method: input.method,
    statusCode: input.statusCode,
    area,
    pathSanitized: sanitizePath(input.rawPath),
    referrerDomain: extractReferrerDomain(input.referrerHeader),
    visitorKeyHash: hashVisitorKey(input.visitorKey, input.config.hashSalt),
    ipHash: input.ipAddress
      ? hashIpAddress(input.ipAddress, input.config.hashSalt)
      : null,
    rawIpAddress: input.config.rawIpEnabled ? input.ipAddress : null,
    userAgentHash: input.userAgent
      ? hashUserAgent(input.userAgent, input.config.hashSalt)
      : null,
    parsedUserAgent,
    humanStatus,
    sessionIsHuman: sessionHumanity.isHuman,
    sessionBotReason: sessionHumanity.botReason,
    isAuthenticated: input.isAuthenticated,
    identityId: input.identityId,
    onlineWindowSeconds: input.config.onlineWindowSeconds,
    geo: input.geo
  };
}

type SessionRow = {
  id: string;
  visitor_key_hash: string;
  area: string;
  last_seen_at: string;
};

/** Identifies one visitor session: a (visitor_key_hash, area) pair. */
function sessionKeyOf(record: VisitEventRecord): string {
  return `${record.visitorKeyHash} ${record.area}`;
}

/**
 * Groups a batch by session key, preserving the two records that carry
 * different meaning:
 *
 * - `earliest` decides session CONTINUATION (is this still the same visit,
 *   per `onlineWindowSeconds`?) — that is the decision the first of these
 *   requests would have made had it been written per-event.
 * - `latest` supplies the session's STATE (current_path, humanity, UA, geo)
 *   — matching the per-event behavior where the last write wins.
 */
function groupBySession(
  records: VisitEventRecord[]
): Map<string, { earliest: VisitEventRecord; latest: VisitEventRecord }> {
  const groups = new Map<
    string,
    { earliest: VisitEventRecord; latest: VisitEventRecord }
  >();

  for (const record of records) {
    const key = sessionKeyOf(record);
    const existing = groups.get(key);

    if (!existing) {
      groups.set(key, { earliest: record, latest: record });
      continue;
    }

    if (record.occurredAt.getTime() < existing.earliest.occurredAt.getTime()) {
      existing.earliest = record;
    }

    if (record.occurredAt.getTime() >= existing.latest.occurredAt.getTime()) {
      existing.latest = record;
    }
  }

  return groups;
}

/**
 * Resolves one session id per distinct (visitor_key_hash, area) in the
 * batch, creating and refreshing rows set-at-a-time.
 *
 * Round trips: 1 SELECT + at most 1 INSERT + at most 1 UPDATE, for the
 * WHOLE batch — replacing the per-event SELECT + UPDATE/INSERT.
 *
 * Known, benign limitation (unchanged from the per-event version, noted in
 * PR #628's review): two concurrent writers that both observe "no session
 * yet" can each INSERT a row — session-count fragmentation, not a
 * correctness/security bug (tenant isolation and RLS are unaffected,
 * `visit_events` FK integrity holds either way). Batching narrows this in
 * practice, since events that used to race each other one-by-one now
 * resolve a single shared session id inside one transaction.
 */
async function resolveSessionIds(
  tx: Bun.SQL,
  tenantId: string,
  groups: Map<string, { earliest: VisitEventRecord; latest: VisitEventRecord }>
): Promise<Map<string, string>> {
  const keys = [...groups.keys()];
  const hashes = keys.map((key) => groups.get(key)!.latest.visitorKeyHash);
  const areas = keys.map((key) => groups.get(key)!.latest.area);

  // `(a, b) IN (SELECT * FROM unnest($1, $2))` matches the pairs exactly —
  // a naive `a = ANY($1) AND b = ANY($2)` would form a cross product and
  // pull in sessions this batch never mentioned. Arrays MUST go through
  // `tx.array(values, "type")`; `${array}::text[]` does not bind in Bun.SQL.
  const existingRows = (await tx`
    SELECT DISTINCT ON (visitor_key_hash, area)
      id, visitor_key_hash, area, last_seen_at
    FROM awcms_mini_visitor_sessions
    WHERE tenant_id = ${tenantId}
      AND (visitor_key_hash, area) IN (
        SELECT * FROM unnest(
          ${tx.array(hashes, "text")},
          ${tx.array(areas, "text")}
        )
      )
    ORDER BY visitor_key_hash, area, last_seen_at DESC
  `) as SessionRow[];

  const existingByKey = new Map<string, SessionRow>();
  for (const row of existingRows) {
    existingByKey.set(`${row.visitor_key_hash} ${row.area}`, row);
  }

  const resolved = new Map<string, string>();
  const toInsert: Record<string, unknown>[] = [];
  const insertKeys: string[] = [];
  const updates: { id: string; latest: VisitEventRecord }[] = [];

  for (const [key, group] of groups) {
    const { earliest, latest } = group;
    const existing = existingByKey.get(key);
    const lastSeenMs = existing
      ? new Date(existing.last_seen_at).getTime()
      : null;
    const withinSameSession =
      lastSeenMs !== null &&
      earliest.occurredAt.getTime() - lastSeenMs <=
        earliest.onlineWindowSeconds * 1000;

    if (existing && withinSameSession) {
      resolved.set(key, existing.id);

      if (
        lastSeenMs === null ||
        latest.occurredAt.getTime() - lastSeenMs >= SESSION_UPDATE_THROTTLE_MS
      ) {
        updates.push({ id: existing.id, latest });
      }

      continue;
    }

    // No recent session for this visitor+area — start a new one.
    // login_identifier_snapshot is deliberately always null here (see
    // README §Domain helpers/§Not yet available): it's a nullable display
    // convenience, not a functional requirement, and populating it would
    // need an extra identities lookup on every new session — deferred
    // rather than added speculatively (never populated for anonymous
    // visitors either way, satisfying the binding privacy rule regardless).
    insertKeys.push(key);
    toInsert.push({
      tenant_id: tenantId,
      visitor_key_hash: latest.visitorKeyHash,
      identity_id: latest.identityId,
      login_identifier_snapshot: null,
      is_authenticated: latest.isAuthenticated,
      area: latest.area,
      current_path: latest.pathSanitized,
      first_seen_at: earliest.occurredAt,
      last_seen_at: latest.occurredAt,
      ip_hash: latest.ipHash,
      ip_address: latest.rawIpAddress,
      user_agent_hash: latest.userAgentHash,
      browser_name: latest.parsedUserAgent.browserName,
      browser_version_major: latest.parsedUserAgent.browserVersionMajor,
      os_name: latest.parsedUserAgent.osName,
      device_type: latest.parsedUserAgent.deviceType,
      is_human: latest.sessionIsHuman,
      bot_reason: latest.sessionBotReason,
      country_code: latest.geo.countryCode,
      region: latest.geo.region,
      city: latest.geo.city,
      timezone: latest.geo.timezone
    });
  }

  if (toInsert.length > 0) {
    // One multi-row INSERT ... RETURNING, then map ids back by pair. Bun.SQL
    // preserves input order in RETURNING for a values-list insert, but this
    // maps by (hash, area) rather than by position so it does not depend on
    // that.
    const inserted = (await tx`
      INSERT INTO awcms_mini_visitor_sessions ${tx(toInsert)}
      RETURNING id, visitor_key_hash, area
    `) as { id: string; visitor_key_hash: string; area: string }[];

    const insertedByKey = new Map<string, string>();
    for (const row of inserted) {
      insertedByKey.set(`${row.visitor_key_hash} ${row.area}`, row.id);
    }

    for (const key of insertKeys) {
      const id = insertedByKey.get(key);
      if (id) resolved.set(key, id);
    }
  }

  if (updates.length > 0) {
    // One set-at-a-time UPDATE joined against the batch's own values.
    await tx`
      UPDATE awcms_mini_visitor_sessions AS s
      SET last_seen_at = u.last_seen_at,
          current_path = u.current_path,
          is_human = u.is_human,
          bot_reason = u.bot_reason,
          browser_name = u.browser_name,
          browser_version_major = u.browser_version_major,
          os_name = u.os_name,
          device_type = u.device_type,
          country_code = u.country_code,
          region = u.region,
          city = u.city,
          timezone = u.timezone,
          updated_at = now()
      FROM unnest(
        ${tx.array(
          updates.map((u) => u.id),
          "uuid"
        )},
        ${tx.array(
          updates.map((u) => u.latest.occurredAt.toISOString()),
          "timestamptz"
        )},
        ${tx.array(
          updates.map((u) => u.latest.pathSanitized),
          "text"
        )},
        ${tx.array(
          updates.map((u) => u.latest.sessionIsHuman),
          "bool"
        )},
        ${tx.array(
          updates.map((u) => u.latest.sessionBotReason),
          "text"
        )},
        ${tx.array(
          updates.map((u) => u.latest.parsedUserAgent.browserName),
          "text"
        )},
        ${tx.array(
          updates.map((u) => u.latest.parsedUserAgent.browserVersionMajor),
          "text"
        )},
        ${tx.array(
          updates.map((u) => u.latest.parsedUserAgent.osName),
          "text"
        )},
        ${tx.array(
          updates.map((u) => u.latest.parsedUserAgent.deviceType),
          "text"
        )},
        ${tx.array(
          updates.map((u) => u.latest.geo.countryCode),
          "text"
        )},
        ${tx.array(
          updates.map((u) => u.latest.geo.region),
          "text"
        )},
        ${tx.array(
          updates.map((u) => u.latest.geo.city),
          "text"
        )},
        ${tx.array(
          updates.map((u) => u.latest.geo.timezone),
          "text"
        )}
      ) AS u(id, last_seen_at, current_path, is_human, bot_reason,
             browser_name, browser_version_major, os_name, device_type,
             country_code, region, city, timezone)
      WHERE s.id = u.id
    `;
  }

  return resolved;
}

/**
 * Persists a batch of records for ONE tenant in ONE transaction. Never
 * throws — see the file header's fail-open note.
 *
 * All statements run sequentially against the single `tx`. They must never
 * be wrapped in `Promise.all`: concurrent queries on one Bun.SQL
 * transaction handle deadlock the connection (a repeated, load-dependent
 * hang in this repo that the test suite does not reliably catch).
 */
export async function writeVisitEventBatch(
  sql: Bun.SQL,
  tenantId: string,
  records: VisitEventRecord[]
): Promise<void> {
  if (records.length === 0) return;

  try {
    await withTenant(
      sql,
      tenantId,
      async (tx) => {
        const groups = groupBySession(records);
        const sessionIds = await resolveSessionIds(tx, tenantId, groups);

        const eventRows = records.map((record) => ({
          tenant_id: tenantId,
          visitor_session_id: sessionIds.get(sessionKeyOf(record)) ?? null,
          identity_id: record.identityId,
          occurred_at: record.occurredAt,
          method: record.method,
          status_code: record.statusCode,
          area: record.area,
          path_sanitized: record.pathSanitized,
          referrer_domain: record.referrerDomain,
          ip_hash: record.ipHash,
          user_agent_hash: record.userAgentHash,
          // Post-review fix (Issue #623), and re-verified for the batched
          // shape (Issue #846): pass a plain JS object, never a
          // pre-`JSON.stringify`'d string. Bun.SQL only decodes a `jsonb`
          // column back into a parsed object on SELECT when the matching
          // INSERT parameter was itself passed as an object.
          // `${JSON.stringify(x)}::jsonb` stores the exact same bytes, but
          // every later SELECT then returns a raw JSON **string**, breaking
          // `VisitEventRow.user_agent_parsed`/`geo`'s `Record<string,
          // unknown>` type.
          //
          // This trap is LIVE in the batched shape and was measured: the
          // otherwise-natural bulk form `unnest(..., ${tx.array(rows.map(r
          // => JSON.stringify(r.geo)), "jsonb")})` reintroduces exactly the
          // #623 bug — verified empirically to read back as `string`. The
          // `tx(rows)` row-helper below reads back as `object`, which is why
          // the batch insert is expressed this way rather than via unnest
          // like the UPDATE above. Guarded by
          // `tests/integration/visitor-analytics-collector.integration.test.ts`.
          user_agent_parsed: {
            browserName: record.parsedUserAgent.browserName,
            browserVersionMajor: record.parsedUserAgent.browserVersionMajor,
            osName: record.parsedUserAgent.osName,
            deviceType: record.parsedUserAgent.deviceType
          },
          geo: {
            countryCode: record.geo.countryCode,
            region: record.geo.region,
            city: record.geo.city,
            timezone: record.geo.timezone
          },
          human_status: record.humanStatus,
          correlation_id: record.correlationId
        }));

        await tx`INSERT INTO awcms_mini_visit_events ${tx(eventRows)}`;
      },
      // `queueTimeoutMs` deliberately far below `withTenant`'s own 2000ms
      // default (post-review fix, PR #628). Retained at 200ms even though
      // Issue #832 moved this write off the response path: it is now the
      // batcher that waits, and a batch that cannot get a pool slot
      // promptly should fail open and let the next batch try rather than
      // pin a `background_sync` slot for two seconds while interactive work
      // queues behind it (the exact contention Issue #824 measured).
      { workClass: "background_sync", queueTimeoutMs: 200 }
    );
  } catch (error) {
    log("warning", "visitor_analytics.collector.failed", {
      correlationId: records[0]?.correlationId,
      tenantId,
      moduleKey: "visitor_analytics",
      batchSize: records.length,
      error: error instanceof Error ? error.message : "unknown error"
    });
  }
}

/**
 * Writes one request's telemetry immediately, awaited. A batch of one over
 * `writeVisitEventBatch` — deliberately NOT a separate single-row SQL path,
 * so the batched writer production uses is the same code this function's
 * tests exercise.
 *
 * Production (`src/middleware.ts`) does NOT call this: it builds a record
 * and hands it to `visit-event-batcher.ts`, so that concurrent visits share
 * one transaction. This entry point remains for callers that want a
 * synchronous, awaited write.
 */
export async function collectVisitorTelemetry(
  input: CollectVisitorTelemetryInput
): Promise<void> {
  try {
    const record = buildVisitEventRecord(input);

    if (!record) return;

    await writeVisitEventBatch(input.sql, input.tenantId, [record]);
  } catch (error) {
    log("warning", "visitor_analytics.collector.failed", {
      correlationId: input.correlationId,
      tenantId: input.tenantId,
      moduleKey: "visitor_analytics",
      error: error instanceof Error ? error.message : "unknown error"
    });
  }
}
