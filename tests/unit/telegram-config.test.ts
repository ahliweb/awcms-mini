import { describe, expect, test } from "bun:test";

import {
  DEFAULT_TELEGRAM_REQUEST_TIMEOUT_MS,
  isKnownTelegramParseMode,
  isTelegramProviderEnabled,
  resolveTelegramBotTokenSecretReference,
  resolveTelegramDefaultParseMode,
  resolveTelegramRequestTimeoutMs
} from "../../src/modules/social-publishing/domain/telegram-config";

describe("isTelegramProviderEnabled", () => {
  test("false when unset", () => {
    expect(isTelegramProviderEnabled({})).toBe(false);
  });

  test('false for anything other than the literal string "true"', () => {
    expect(isTelegramProviderEnabled({ TELEGRAM_PROVIDER_ENABLED: "1" })).toBe(
      false
    );
    expect(
      isTelegramProviderEnabled({ TELEGRAM_PROVIDER_ENABLED: "TRUE" })
    ).toBe(false);
  });

  test('true only for the exact string "true"', () => {
    expect(
      isTelegramProviderEnabled({ TELEGRAM_PROVIDER_ENABLED: "true" })
    ).toBe(true);
  });
});

describe("resolveTelegramRequestTimeoutMs", () => {
  test("falls back to the default when unset", () => {
    expect(resolveTelegramRequestTimeoutMs({})).toBe(
      DEFAULT_TELEGRAM_REQUEST_TIMEOUT_MS
    );
  });

  test("falls back to the default for a non-numeric or non-positive value", () => {
    expect(
      resolveTelegramRequestTimeoutMs({ TELEGRAM_REQUEST_TIMEOUT_MS: "abc" })
    ).toBe(DEFAULT_TELEGRAM_REQUEST_TIMEOUT_MS);
    expect(
      resolveTelegramRequestTimeoutMs({ TELEGRAM_REQUEST_TIMEOUT_MS: "-5" })
    ).toBe(DEFAULT_TELEGRAM_REQUEST_TIMEOUT_MS);
    expect(
      resolveTelegramRequestTimeoutMs({ TELEGRAM_REQUEST_TIMEOUT_MS: "0" })
    ).toBe(DEFAULT_TELEGRAM_REQUEST_TIMEOUT_MS);
  });

  test("uses a valid positive override", () => {
    expect(
      resolveTelegramRequestTimeoutMs({ TELEGRAM_REQUEST_TIMEOUT_MS: "5000" })
    ).toBe(5000);
  });
});

describe("resolveTelegramBotTokenSecretReference", () => {
  test("empty string when unset", () => {
    expect(resolveTelegramBotTokenSecretReference({})).toBe("");
  });

  test("trims surrounding whitespace", () => {
    expect(
      resolveTelegramBotTokenSecretReference({
        TELEGRAM_BOT_TOKEN_SECRET_REFERENCE: "  env:MY_BOT_TOKEN  "
      })
    ).toBe("env:MY_BOT_TOKEN");
  });
});

describe("isKnownTelegramParseMode / resolveTelegramDefaultParseMode", () => {
  test("MarkdownV2 and HTML are known", () => {
    expect(isKnownTelegramParseMode("MarkdownV2")).toBe(true);
    expect(isKnownTelegramParseMode("HTML")).toBe(true);
  });

  test("legacy Markdown is deliberately NOT known/supported", () => {
    expect(isKnownTelegramParseMode("Markdown")).toBe(false);
  });

  test("unset/empty/garbage are not known", () => {
    expect(isKnownTelegramParseMode(undefined)).toBe(false);
    expect(isKnownTelegramParseMode("")).toBe(false);
    expect(isKnownTelegramParseMode("markdownv2")).toBe(false); // case-sensitive
  });

  test("resolveTelegramDefaultParseMode defaults to undefined (plain text, safe) for unset/invalid values", () => {
    expect(resolveTelegramDefaultParseMode({})).toBeUndefined();
    expect(
      resolveTelegramDefaultParseMode({
        TELEGRAM_DEFAULT_PARSE_MODE: "Markdown"
      })
    ).toBeUndefined();
    expect(
      resolveTelegramDefaultParseMode({
        TELEGRAM_DEFAULT_PARSE_MODE: "garbage"
      })
    ).toBeUndefined();
  });

  test("resolveTelegramDefaultParseMode returns the explicit opt-in value", () => {
    expect(
      resolveTelegramDefaultParseMode({
        TELEGRAM_DEFAULT_PARSE_MODE: "MarkdownV2"
      })
    ).toBe("MarkdownV2");
    expect(
      resolveTelegramDefaultParseMode({ TELEGRAM_DEFAULT_PARSE_MODE: "HTML" })
    ).toBe("HTML");
  });
});
