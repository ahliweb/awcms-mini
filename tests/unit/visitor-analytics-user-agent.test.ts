import { describe, expect, test } from "bun:test";

import {
  isBotUserAgent,
  parseUserAgent
} from "../../src/modules/visitor-analytics/domain/user-agent";

describe("parseUserAgent — desktop browsers", () => {
  test("Chrome on Windows", () => {
    const result = parseUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    );
    expect(result).toMatchObject({
      browserName: "Chrome",
      browserVersionMajor: "126",
      osName: "Windows",
      deviceType: "desktop",
      isBot: false
    });
  });

  test("Firefox on Linux", () => {
    const result = parseUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0"
    );
    expect(result).toMatchObject({
      browserName: "Firefox",
      browserVersionMajor: "127",
      osName: "Linux",
      deviceType: "desktop",
      isBot: false
    });
  });

  test("Safari on macOS", () => {
    const result = parseUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15"
    );
    expect(result).toMatchObject({
      browserName: "Safari",
      browserVersionMajor: "17",
      osName: "macOS",
      deviceType: "desktop",
      isBot: false
    });
  });

  test("Edge on Windows", () => {
    const result = parseUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0"
    );
    expect(result).toMatchObject({
      browserName: "Edge",
      browserVersionMajor: "126",
      osName: "Windows",
      deviceType: "desktop",
      isBot: false
    });
  });

  test("Opera on Windows", () => {
    const result = parseUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 OPR/111.0.0.0"
    );
    expect(result).toMatchObject({
      browserName: "Opera",
      browserVersionMajor: "111",
      deviceType: "desktop"
    });
  });

  test("Chrome on Chrome OS", () => {
    const result = parseUserAgent(
      "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    );
    expect(result).toMatchObject({
      browserName: "Chrome",
      osName: "Chrome OS",
      deviceType: "desktop"
    });
  });

  test("Internet Explorer 11 on Windows", () => {
    const result = parseUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; WOW64; Trident/7.0; rv:11.0) like Gecko"
    );
    expect(result).toMatchObject({
      browserName: "Internet Explorer",
      browserVersionMajor: "11",
      osName: "Windows",
      deviceType: "desktop"
    });
  });
});

describe("parseUserAgent — mobile browsers", () => {
  test("Chrome on Android phone", () => {
    const result = parseUserAgent(
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36"
    );
    expect(result).toMatchObject({
      browserName: "Chrome",
      osName: "Android",
      deviceType: "mobile",
      isBot: false
    });
  });

  test("Safari on iPhone", () => {
    const result = parseUserAgent(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
    );
    expect(result).toMatchObject({
      browserName: "Safari",
      osName: "iOS",
      deviceType: "mobile",
      isBot: false
    });
  });

  test("Firefox on Android phone", () => {
    const result = parseUserAgent(
      "Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0"
    );
    expect(result).toMatchObject({
      browserName: "Firefox",
      osName: "Android",
      deviceType: "mobile"
    });
  });

  test("Samsung Internet on Android phone", () => {
    const result = parseUserAgent(
      "Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/115.0.0.0 Mobile Safari/537.36"
    );
    expect(result).toMatchObject({
      browserName: "Samsung Internet",
      deviceType: "mobile"
    });
  });

  test("Chrome on iPhone (CriOS)", () => {
    const result = parseUserAgent(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1"
    );
    expect(result).toMatchObject({
      browserName: "Chrome",
      osName: "iOS",
      deviceType: "mobile"
    });
  });
});

describe("parseUserAgent — tablets", () => {
  test("Safari on iPad", () => {
    const result = parseUserAgent(
      "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
    );
    expect(result).toMatchObject({
      browserName: "Safari",
      osName: "iOS",
      deviceType: "tablet"
    });
  });

  test("Chrome on Android tablet (no Mobile token)", () => {
    const result = parseUserAgent(
      "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    );
    expect(result).toMatchObject({
      browserName: "Chrome",
      osName: "Android",
      deviceType: "tablet"
    });
  });
});

describe("parseUserAgent — bots and crawlers", () => {
  const botCases: { ua: string; reason: string }[] = [
    {
      ua: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      reason: "Googlebot"
    },
    {
      ua: "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
      reason: "Bingbot"
    },
    {
      ua: "Mozilla/5.0 (compatible; Yahoo! Slurp; http://help.yahoo.com/help/us/ysearch/slurp)",
      reason: "Yahoo Slurp"
    },
    {
      ua: "DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)",
      reason: "DuckDuckBot"
    },
    {
      ua: "Baiduspider+(+http://www.baidu.com/search/spider.htm)",
      reason: "Baiduspider"
    },
    {
      ua: "Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)",
      reason: "YandexBot"
    },
    {
      ua: "Mozilla/5.0 (Applebot/0.1; +http://www.apple.com/go/applebot)",
      reason: "Applebot"
    },
    {
      ua: "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
      reason: "Facebook"
    },
    { ua: "Twitterbot/1.0", reason: "Twitterbot" },
    {
      ua: "LinkedInBot/1.0 (compatible; Mozilla/5.0; +http://www.linkedin.com)",
      reason: "LinkedInBot"
    },
    { ua: "curl/8.4.0", reason: "curl" },
    { ua: "python-requests/2.31.0", reason: "python-requests" },
    { ua: "PostmanRuntime/7.36.0", reason: "PostmanRuntime" }
  ];

  for (const { ua, reason } of botCases) {
    test(`classifies "${ua}" as bot (${reason})`, () => {
      const result = parseUserAgent(ua);
      expect(result.isBot).toBe(true);
      expect(result.botReason).toBe(reason);
      expect(result.deviceType).toBe("bot");
    });
  }

  test("isBotUserAgent matches parseUserAgent's own bot decision", () => {
    const ua =
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
    expect(isBotUserAgent(ua)).toEqual({ isBot: true, botReason: "Googlebot" });
  });
});

describe("parseUserAgent — unknown/ambiguous, never trusted as human", () => {
  test("empty string", () => {
    const result = parseUserAgent("");
    expect(result).toMatchObject({
      browserName: null,
      osName: null,
      deviceType: "unknown",
      isBot: false
    });
  });

  test("null/undefined", () => {
    expect(parseUserAgent(null).deviceType).toBe("unknown");
    expect(parseUserAgent(undefined).deviceType).toBe("unknown");
  });

  test("gibberish string with no recognizable tokens", () => {
    const result = parseUserAgent("some-custom-internal-client/1.0");
    expect(result).toMatchObject({
      browserName: null,
      osName: null,
      deviceType: "unknown",
      isBot: false
    });
  });
});
