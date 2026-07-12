import { describe, expect, test } from "bun:test";

import {
  buildTelegramHashtags,
  buildTelegramMessageText,
  escapeTelegramHtml,
  escapeTelegramMarkdownV2,
  truncateTelegramMessageText
} from "../../src/modules/social-publishing/domain/telegram-message-formatting";
import type { SocialPublishContentSnapshot } from "../../src/modules/social-publishing/domain/social-provider-adapter";

const MALICIOUS_TITLE =
  "Breaking: *URGENT* _important_ [click here](https://evil.example) <script>alert(1)</script>";

function content(
  overrides: Partial<SocialPublishContentSnapshot> = {}
): SocialPublishContentSnapshot {
  return {
    title: MALICIOUS_TITLE,
    excerptOrCaption: "A short excerpt.",
    canonicalUrl: "https://news.example.com/news/some-article",
    imageUrl: null,
    ...overrides
  };
}

describe("escapeTelegramMarkdownV2", () => {
  test("escapes every documented MarkdownV2 special character", () => {
    const input = "_*[]()~`>#+-=|{}.!";
    const escaped = escapeTelegramMarkdownV2(input);
    for (const ch of input) {
      // Every occurrence must be immediately preceded by a backslash.
      expect(escaped).toContain(`\\${ch}`);
    }
    // No unescaped instance of any special char survives.
    expect(escaped).not.toMatch(/(?<!\\)[_*[\]()~`>#+\-=|{}.!]/);
  });

  test("backslash-first ordering: a literal backslash followed by a special char round-trips correctly (single pass, no bypass)", () => {
    // Raw input: backslash then asterisk. If the backslash itself were not
    // escaped, a naive escaper would turn `\*` into `\\*` — an escaped
    // backslash followed by a now-BARE, unescaped asterisk (a real
    // formatting-injection bypass). The correct output escapes BOTH
    // characters: `\\\*` (escaped backslash + escaped asterisk).
    const input = "foo\\*bar*baz";
    const escaped = escapeTelegramMarkdownV2(input);
    expect(escaped).toBe("foo\\\\\\*bar\\*baz");
    // Never contains a bare, unescaped asterisk.
    expect(escaped).not.toMatch(/(?<!\\)\*/);
  });

  test("a title shaped like bold/italic/link markdown is fully escaped, not interpreted", () => {
    const escaped = escapeTelegramMarkdownV2(MALICIOUS_TITLE);
    expect(escaped).not.toMatch(/(?<!\\)\*/);
    expect(escaped).not.toMatch(/(?<!\\)_/);
    expect(escaped).not.toMatch(/(?<!\\)\[/);
    expect(escaped).not.toMatch(/(?<!\\)\]/);
    expect(escaped).not.toMatch(/(?<!\\)\(/);
    expect(escaped).not.toMatch(/(?<!\\)\)/);
  });

  test("leaves ordinary alphanumeric text untouched", () => {
    expect(escapeTelegramMarkdownV2("Hello world 123")).toBe("Hello world 123");
  });
});

describe("escapeTelegramHtml", () => {
  test("escapes &, <, > in a single pass without double-escaping", () => {
    // If `&` were escaped in a pass AFTER `<`/`>` were turned into
    // `&lt;`/`&gt;`, the `&` those replacements just introduced would be
    // re-escaped into `&amp;lt;`/`&amp;gt;` — a real double-escaping bug.
    const input = "<b>bold</b> & <script>alert(1)</script>";
    const escaped = escapeTelegramHtml(input);
    expect(escaped).toBe(
      "&lt;b&gt;bold&lt;/b&gt; &amp; &lt;script&gt;alert(1)&lt;/script&gt;"
    );
    expect(escaped).not.toContain("&amp;lt;");
    expect(escaped).not.toContain("&amp;gt;");
  });

  test("a raw ampersand is escaped exactly once", () => {
    expect(escapeTelegramHtml("Tom & Jerry")).toBe("Tom &amp; Jerry");
  });

  test("leaves ordinary text untouched", () => {
    expect(escapeTelegramHtml("Hello world 123")).toBe("Hello world 123");
  });
});

describe("buildTelegramHashtags", () => {
  test("strips unsafe characters and prefixes with #", () => {
    expect(buildTelegramHashtags(["Breaking News"])).toEqual([
      "#Breaking_News"
    ]);
  });

  test("drops tags that sanitize to nothing", () => {
    expect(buildTelegramHashtags(["!!!", "", "   "])).toEqual([]);
  });

  test("dedupe: two distinct raw names that sanitize to the same hashtag only appear once", () => {
    expect(buildTelegramHashtags(["Breaking", "Breaking"])).toEqual([
      "#Breaking"
    ]);
  });
});

describe("buildTelegramMessageText — plain mode (default, safe)", () => {
  test("a title shaped like bold/italic/link markdown is sent completely unescaped/untouched — Telegram never interprets it without parse_mode", () => {
    const text = buildTelegramMessageText(content(), [], undefined);
    expect(text).toContain(MALICIOUS_TITLE);
    expect(text).toContain("https://news.example.com/news/some-article");
  });

  test("includes title, excerpt, and canonical URL on separate lines", () => {
    const text = buildTelegramMessageText(
      content({ title: "Plain Title", excerptOrCaption: "Plain excerpt." }),
      [],
      undefined
    );
    expect(text.split("\n")).toEqual([
      "Plain Title",
      "",
      "Plain excerpt.",
      "",
      "https://news.example.com/news/some-article"
    ]);
  });

  test("omits the excerpt line when there is no excerpt", () => {
    const text = buildTelegramMessageText(
      content({ title: "Plain Title", excerptOrCaption: "" }),
      [],
      undefined
    );
    expect(text).toBe(
      "Plain Title\n\nhttps://news.example.com/news/some-article"
    );
  });

  test("appends hashtags on their own line when present", () => {
    const text = buildTelegramMessageText(
      content({ title: "T", excerptOrCaption: "" }),
      ["#news", "#breaking"],
      undefined
    );
    expect(text).toBe(
      "T\n\nhttps://news.example.com/news/some-article\n\n#news #breaking"
    );
  });
});

describe("buildTelegramMessageText — MarkdownV2 mode (explicit opt-in)", () => {
  test("escapes the title so bold/italic/link-shaped text renders as literal characters, never real formatting", () => {
    const text = buildTelegramMessageText(content(), [], "MarkdownV2");
    // The raw malicious title must NOT appear verbatim (it must be escaped).
    expect(text).not.toContain(MALICIOUS_TITLE);
    // No unescaped MarkdownV2 special character anywhere in the output.
    expect(text).not.toMatch(/(?<!\\)[_*[\]()~`>#+=|{}.!]/);
  });

  test("escapes the canonical URL's special characters (., -, /) so the message remains valid MarkdownV2", () => {
    const text = buildTelegramMessageText(
      content({ title: "T", excerptOrCaption: "" }),
      [],
      "MarkdownV2"
    );
    expect(text).toContain(
      escapeTelegramMarkdownV2("https://news.example.com/news/some-article")
    );
  });
});

describe("buildTelegramMessageText — HTML mode (explicit opt-in)", () => {
  test("escapes a <script> tag in the title so it renders as literal text, never a real tag", () => {
    const text = buildTelegramMessageText(content(), [], "HTML");
    expect(text).not.toContain("<script>");
    expect(text).toContain("&lt;script&gt;");
  });
});

describe("truncateTelegramMessageText", () => {
  test("leaves a short message untouched", () => {
    expect(truncateTelegramMessageText("short")).toBe("short");
  });

  test("truncates an oversized message at the nearest line boundary, never mid-line", () => {
    const line = "x".repeat(100);
    const lines = Array.from({ length: 50 }, () => line); // 50 * 101 > 4096
    const text = lines.join("\n");
    const truncated = truncateTelegramMessageText(text);
    expect(truncated.length).toBeLessThanOrEqual(4096);
    expect(truncated.endsWith("\n")).toBe(false);
    // Every remaining line is a full, untouched copy of `line` — never a
    // partial cut mid-line.
    for (const remainingLine of truncated.split("\n")) {
      expect(remainingLine).toBe(line);
    }
  });
});
