import { describe, expect, test } from "bun:test";

import {
  shapeVisitEvent,
  shapeVisitorSession,
  type VisitEventRow,
  type VisitorSessionRow
} from "../../src/modules/visitor-analytics/domain/analytics-response-shaping";

const SESSION_ROW: VisitorSessionRow = {
  id: "session-1",
  visitor_key_hash: "sha256:abc",
  identity_id: null,
  login_identifier_snapshot: "owner@example.com",
  is_authenticated: true,
  area: "admin",
  current_path: "/admin/dashboard",
  first_seen_at: new Date("2026-07-10T00:00:00.000Z"),
  last_seen_at: new Date("2026-07-10T00:05:00.000Z"),
  ip_hash: "sha256:iphash",
  ip_address: "203.0.113.10",
  user_agent_hash: "sha256:uahash",
  browser_name: "Chrome",
  browser_version_major: "126",
  os_name: "Windows",
  device_type: "desktop",
  is_human: true,
  bot_reason: null,
  country_code: null,
  region: null,
  city: null,
  timezone: null
};

const EVENT_ROW: VisitEventRow = {
  id: "event-1",
  visitor_session_id: "session-1",
  identity_id: null,
  occurred_at: new Date("2026-07-10T00:05:00.000Z"),
  method: "GET",
  status_code: 200,
  area: "admin",
  route_pattern: null,
  path_sanitized: "/admin/dashboard",
  referrer_domain: null,
  duration_ms: null,
  ip_hash: "sha256:iphash",
  user_agent_hash: "sha256:uahash",
  user_agent_parsed: { browserName: "Chrome" },
  geo: {},
  human_status: "human",
  correlation_id: "corr-1"
};

describe("shapeVisitorSession", () => {
  test("omits raw-detail fields when canSeeRawDetail is false", () => {
    const dto = shapeVisitorSession(SESSION_ROW, false);
    expect(dto.ipHash).toBeNull();
    expect(dto.ipAddress).toBeNull();
    expect(dto.userAgentHash).toBeNull();
    expect(dto.loginIdentifierSnapshot).toBeNull();
    expect(dto.browserName).toBe("Chrome");
    expect(dto.area).toBe("admin");
  });

  test("includes raw-detail fields when canSeeRawDetail is true", () => {
    const dto = shapeVisitorSession(SESSION_ROW, true);
    expect(dto.ipHash).toBe("sha256:iphash");
    expect(dto.ipAddress).toBe("203.0.113.10");
    expect(dto.userAgentHash).toBe("sha256:uahash");
    expect(dto.loginIdentifierSnapshot).toBe("owner@example.com");
  });

  test("always formats timestamps as ISO strings", () => {
    const dto = shapeVisitorSession(SESSION_ROW, false);
    expect(dto.firstSeenAt).toBe("2026-07-10T00:00:00.000Z");
    expect(dto.lastSeenAt).toBe("2026-07-10T00:05:00.000Z");
  });
});

describe("shapeVisitEvent", () => {
  test("omits raw-detail fields when canSeeRawDetail is false", () => {
    const dto = shapeVisitEvent(EVENT_ROW, false);
    expect(dto.ipHash).toBeNull();
    expect(dto.userAgentHash).toBeNull();
    expect(dto.pathSanitized).toBe("/admin/dashboard");
    expect(dto.humanStatus).toBe("human");
  });

  test("includes raw-detail fields when canSeeRawDetail is true", () => {
    const dto = shapeVisitEvent(EVENT_ROW, true);
    expect(dto.ipHash).toBe("sha256:iphash");
    expect(dto.userAgentHash).toBe("sha256:uahash");
  });

  test("never omits non-raw parsed/aggregate fields regardless of raw-detail access", () => {
    const withoutRaw = shapeVisitEvent(EVENT_ROW, false);
    const withRaw = shapeVisitEvent(EVENT_ROW, true);
    expect(withoutRaw.userAgentParsed).toEqual(withRaw.userAgentParsed);
    expect(withoutRaw.area).toBe(withRaw.area);
  });
});
