import { describe, expect, test } from "bun:test";

import { resolveNewsShareConfig } from "../../src/modules/news-portal/domain/news-share-config";

describe("resolveNewsShareConfig (Issue #642)", () => {
  test("defaults every flag to true when no NEWS_SHARE_* var is set", () => {
    const config = resolveNewsShareConfig({});

    expect(config).toEqual({
      buttonsEnabled: true,
      native: true,
      whatsapp: true,
      telegram: true,
      facebook: true,
      linkedin: true,
      x: true,
      email: true,
      instagramNativeOnly: true
    });
  });

  test("each flag can be independently disabled via its own env var", () => {
    const config = resolveNewsShareConfig({
      NEWS_SHARE_WHATSAPP_ENABLED: "false",
      NEWS_SHARE_X_ENABLED: "false"
    });

    expect(config.whatsapp).toBe(false);
    expect(config.x).toBe(false);
    // Untouched flags stay at their true default.
    expect(config.telegram).toBe(true);
    expect(config.facebook).toBe(true);
    expect(config.linkedin).toBe(true);
    expect(config.email).toBe(true);
    expect(config.native).toBe(true);
    expect(config.buttonsEnabled).toBe(true);
  });

  test("master switch NEWS_SHARE_BUTTONS_ENABLED=false disables the whole widget", () => {
    const config = resolveNewsShareConfig({
      NEWS_SHARE_BUTTONS_ENABLED: "false"
    });

    expect(config.buttonsEnabled).toBe(false);
  });

  test('only the exact string "true" enables a flag — any other value is treated as false', () => {
    const config = resolveNewsShareConfig({
      NEWS_SHARE_NATIVE_ENABLED: "TRUE",
      NEWS_SHARE_EMAIL_ENABLED: "1"
    });

    expect(config.native).toBe(false);
    expect(config.email).toBe(false);
  });

  test("NEWS_SHARE_INSTAGRAM_NATIVE_ONLY can be independently disabled", () => {
    const config = resolveNewsShareConfig({
      NEWS_SHARE_INSTAGRAM_NATIVE_ONLY: "false"
    });

    expect(config.instagramNativeOnly).toBe(false);
  });
});
