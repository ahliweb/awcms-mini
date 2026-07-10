import { describe, expect, test } from "bun:test";

import {
  classifyHumanStatus,
  classifySessionHumanity
} from "../../src/modules/visitor-analytics/domain/human-classifier";
import { parseUserAgent } from "../../src/modules/visitor-analytics/domain/user-agent";

const HUMAN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const BOT_UA =
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const UNKNOWN_UA = "some-custom-internal-client/1.0";

describe("classifyHumanStatus", () => {
  test("a clearly-bot UA is always bot, authenticated or not", () => {
    const parsedUserAgent = parseUserAgent(BOT_UA);
    expect(
      classifyHumanStatus({ isAuthenticated: false, parsedUserAgent })
    ).toBe("bot");
    expect(
      classifyHumanStatus({ isAuthenticated: true, parsedUserAgent })
    ).toBe("bot");
  });

  test("an authenticated session with a recognized browser is human", () => {
    const parsedUserAgent = parseUserAgent(HUMAN_UA);
    expect(
      classifyHumanStatus({ isAuthenticated: true, parsedUserAgent })
    ).toBe("human");
  });

  test("an authenticated session is human even with an unrecognized UA", () => {
    const parsedUserAgent = parseUserAgent(UNKNOWN_UA);
    expect(
      classifyHumanStatus({ isAuthenticated: true, parsedUserAgent })
    ).toBe("human");
  });

  test("an unauthenticated request with a recognized browser is human", () => {
    const parsedUserAgent = parseUserAgent(HUMAN_UA);
    expect(
      classifyHumanStatus({ isAuthenticated: false, parsedUserAgent })
    ).toBe("human");
  });

  test("an unauthenticated request with an unrecognized UA is unknown, never blindly human", () => {
    const parsedUserAgent = parseUserAgent(UNKNOWN_UA);
    expect(
      classifyHumanStatus({ isAuthenticated: false, parsedUserAgent })
    ).toBe("unknown");
  });
});

describe("classifySessionHumanity", () => {
  test("is_human stays true for an unrecognized UA (schema has no unknown tri-state)", () => {
    const parsedUserAgent = parseUserAgent(UNKNOWN_UA);
    expect(
      classifySessionHumanity({ isAuthenticated: false, parsedUserAgent })
    ).toEqual({ isHuman: true, botReason: null });
  });

  test("is_human is false with a bot_reason for a clearly-bot UA", () => {
    const parsedUserAgent = parseUserAgent(BOT_UA);
    expect(
      classifySessionHumanity({ isAuthenticated: false, parsedUserAgent })
    ).toEqual({ isHuman: false, botReason: "Googlebot" });
  });

  test("is_human is true for a recognized human browser", () => {
    const parsedUserAgent = parseUserAgent(HUMAN_UA);
    expect(
      classifySessionHumanity({ isAuthenticated: true, parsedUserAgent })
    ).toEqual({ isHuman: true, botReason: null });
  });
});
