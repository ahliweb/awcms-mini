/**
 * Unit tests for `src/modules/visitor-analytics/domain/dashboard-view.ts`
 * (Issue #622, epic: visitor analytics #617-#624). Covers the issue's own
 * "wajib" test list for logic that does not need a browser: raw-detail
 * gating (a `null` field renders as a placeholder, never the literal
 * "null"/"undefined", and is never invented when absent), and the
 * loading/empty/error section-state resolution doc 14 §State pattern
 * requires. Access-denied and full aggregate-view rendering are covered
 * by `tests/e2e/admin-analytics-*.e2e.ts` instead (SSR permission gating
 * and real browser rendering cannot be exercised through `bun:test` — see
 * `tests/integration/admin-security-ui.integration.test.ts`'s own doc
 * comment for why this repo has no such harness for `/admin/*` pages).
 */
import { describe, expect, test } from "bun:test";

import {
  buildSessionRowCells,
  DASHBOARD_VALUE_PLACEHOLDER,
  displayOrPlaceholder,
  isNamedCountListEmpty,
  isRealtimeAllZero,
  isSecurityViewEmpty,
  isSummaryEmpty,
  matchesAreaFilter,
  matchesVisitorTypeFilter,
  resolveSectionState
} from "../../src/modules/visitor-analytics/domain/dashboard-view";

describe("displayOrPlaceholder", () => {
  test("renders null as the placeholder, never the literal string 'null'", () => {
    expect(displayOrPlaceholder(null)).toBe(DASHBOARD_VALUE_PLACEHOLDER);
  });

  test("renders undefined as the placeholder", () => {
    expect(displayOrPlaceholder(undefined)).toBe(DASHBOARD_VALUE_PLACEHOLDER);
  });

  test("renders a blank string as the placeholder", () => {
    expect(displayOrPlaceholder("   ")).toBe(DASHBOARD_VALUE_PLACEHOLDER);
  });

  test("renders a real value unchanged", () => {
    expect(displayOrPlaceholder("Chrome")).toBe("Chrome");
  });
});

describe("buildSessionRowCells — raw-detail gating", () => {
  const baseSession = {
    area: "admin",
    currentPath: "/admin/dashboard",
    browserName: "Chrome",
    osName: "Windows",
    deviceType: "desktop",
    isHuman: true,
    countryCode: "ID",
    ipAddress: "203.0.113.7",
    ipHash: "hash-of-ip",
    userAgentHash: "hash-of-ua",
    loginIdentifierSnapshot: "owner@example.com"
  };

  test("raw block is null (not rendered) when showRawDetailColumns is false, even though the row carries real raw values", () => {
    const cells = buildSessionRowCells(baseSession, {
      showRawDetailColumns: false,
      humanLabel: "Human",
      botLabel: "Bot"
    });

    expect(cells.raw).toBeNull();
  });

  test("raw block renders the real values when showRawDetailColumns is true", () => {
    const cells = buildSessionRowCells(baseSession, {
      showRawDetailColumns: true,
      humanLabel: "Human",
      botLabel: "Bot"
    });

    expect(cells.raw).toEqual({
      ipAddress: "203.0.113.7",
      ipHash: "hash-of-ip",
      userAgentHash: "hash-of-ua",
      loginIdentifier: "owner@example.com"
    });
  });

  test("a caller without raw_detail.read (API already returned null for every raw field) never sees a leaked value, even with showRawDetailColumns true", () => {
    const shapedForUnprivilegedCaller = {
      ...baseSession,
      ipAddress: null,
      ipHash: null,
      userAgentHash: null,
      loginIdentifierSnapshot: null
    };

    const cells = buildSessionRowCells(shapedForUnprivilegedCaller, {
      showRawDetailColumns: true,
      humanLabel: "Human",
      botLabel: "Bot"
    });

    expect(cells.raw).toEqual({
      ipAddress: DASHBOARD_VALUE_PLACEHOLDER,
      ipHash: DASHBOARD_VALUE_PLACEHOLDER,
      userAgentHash: DASHBOARD_VALUE_PLACEHOLDER,
      loginIdentifier: DASHBOARD_VALUE_PLACEHOLDER
    });
    // Never the literal string "null" anywhere in the rendered cells.
    expect(JSON.stringify(cells)).not.toContain("null");
  });

  test("visitorType uses the bot label for a bot session", () => {
    const cells = buildSessionRowCells(
      { ...baseSession, isHuman: false },
      { showRawDetailColumns: false, humanLabel: "Human", botLabel: "Bot" }
    );

    expect(cells.visitorType).toBe("Bot");
  });

  test("nullable display fields (currentPath, browserName, etc.) fall back to the placeholder", () => {
    const cells = buildSessionRowCells(
      {
        ...baseSession,
        currentPath: null,
        browserName: null,
        osName: null,
        deviceType: null,
        countryCode: null
      },
      { showRawDetailColumns: false, humanLabel: "Human", botLabel: "Bot" }
    );

    expect(cells.currentPath).toBe(DASHBOARD_VALUE_PLACEHOLDER);
    expect(cells.browser).toBe(DASHBOARD_VALUE_PLACEHOLDER);
    expect(cells.os).toBe(DASHBOARD_VALUE_PLACEHOLDER);
    expect(cells.device).toBe(DASHBOARD_VALUE_PLACEHOLDER);
    expect(cells.country).toBe(DASHBOARD_VALUE_PLACEHOLDER);
  });
});

describe("isNamedCountListEmpty", () => {
  test("an empty array is empty", () => {
    expect(isNamedCountListEmpty([])).toBe(true);
  });

  test("a list where every count is zero is empty", () => {
    expect(isNamedCountListEmpty([{ name: "a", count: 0 }])).toBe(true);
  });

  test("a list with at least one non-zero count is not empty", () => {
    expect(
      isNamedCountListEmpty([
        { name: "a", count: 0 },
        { name: "b", count: 3 }
      ])
    ).toBe(false);
  });
});

describe("isRealtimeAllZero / isSummaryEmpty / isSecurityViewEmpty", () => {
  test("realtime stats all zero is empty", () => {
    expect(
      isRealtimeAllZero({
        onlineHumanCount: 0,
        onlineAdminCount: 0,
        onlinePublicCount: 0,
        onlineApiCount: 0
      })
    ).toBe(true);
  });

  test("realtime stats with any non-zero count is not empty", () => {
    expect(
      isRealtimeAllZero({
        onlineHumanCount: 1,
        onlineAdminCount: 0,
        onlinePublicCount: 0,
        onlineApiCount: 0
      })
    ).toBe(false);
  });

  test("summary with all zero counters is empty", () => {
    expect(
      isSummaryEmpty({
        humanUniqueVisitors: 0,
        humanPageviews: 0,
        botPageviews: 0
      })
    ).toBe(true);
  });

  test("summary with any non-zero counter is not empty", () => {
    expect(
      isSummaryEmpty({
        humanUniqueVisitors: 0,
        humanPageviews: 0,
        botPageviews: 5
      })
    ).toBe(false);
  });

  test("security view with zero bot pageviews is empty", () => {
    expect(isSecurityViewEmpty({ botPageviews: 0 })).toBe(true);
  });
});

describe("resolveSectionState", () => {
  const isEmptyList = (data: { name: string; count: number }[]) =>
    isNamedCountListEmpty(data);

  test("a failed fetch always resolves to error, never empty", () => {
    expect(resolveSectionState(false, [], isEmptyList)).toBe("error");
  });

  test("fetchOk true but data null resolves to error", () => {
    expect(
      resolveSectionState<{ name: string; count: number }[]>(
        true,
        null,
        isEmptyList
      )
    ).toBe("error");
  });

  test("a successful fetch with an empty payload resolves to empty", () => {
    expect(resolveSectionState(true, [], isEmptyList)).toBe("empty");
  });

  test("a successful fetch with real data resolves to ready", () => {
    expect(
      resolveSectionState(true, [{ name: "a", count: 2 }], isEmptyList)
    ).toBe("ready");
  });
});

describe("matchesAreaFilter", () => {
  test("'all' matches every area", () => {
    expect(matchesAreaFilter("admin", "all")).toBe(true);
    expect(matchesAreaFilter("public", "all")).toBe(true);
  });

  test("'api' also matches 'auth' and 'setup' sub-areas", () => {
    expect(matchesAreaFilter("api", "api")).toBe(true);
    expect(matchesAreaFilter("auth", "api")).toBe(true);
    expect(matchesAreaFilter("setup", "api")).toBe(true);
    expect(matchesAreaFilter("admin", "api")).toBe(false);
  });

  test("'admin'/'public' match exactly", () => {
    expect(matchesAreaFilter("admin", "admin")).toBe(true);
    expect(matchesAreaFilter("public", "admin")).toBe(false);
  });
});

describe("matchesVisitorTypeFilter", () => {
  test("'all' matches human and bot", () => {
    expect(matchesVisitorTypeFilter(true, "all")).toBe(true);
    expect(matchesVisitorTypeFilter(false, "all")).toBe(true);
  });

  test("'human' matches only isHuman=true", () => {
    expect(matchesVisitorTypeFilter(true, "human")).toBe(true);
    expect(matchesVisitorTypeFilter(false, "human")).toBe(false);
  });

  test("'bot' matches only isHuman=false", () => {
    expect(matchesVisitorTypeFilter(false, "bot")).toBe(true);
    expect(matchesVisitorTypeFilter(true, "bot")).toBe(false);
  });
});
