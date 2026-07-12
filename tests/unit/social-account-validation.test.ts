import { describe, expect, test } from "bun:test";

import {
  isValidProviderKey,
  looksLikeRawSecretToken,
  validateCreateSocialAccountInput
} from "../../src/modules/social-publishing/domain/social-account-validation";

describe("isValidProviderKey (Issue #643)", () => {
  test("accepts lowercase snake_case provider keys", () => {
    expect(isValidProviderKey("telegram_channel")).toBe(true);
    expect(isValidProviderKey("facebook_page")).toBe(true);
  });

  test("rejects uppercase, leading digit, or empty", () => {
    expect(isValidProviderKey("Telegram")).toBe(false);
    expect(isValidProviderKey("1telegram")).toBe(false);
    expect(isValidProviderKey("")).toBe(false);
  });
});

describe("looksLikeRawSecretToken (Issue #643)", () => {
  test("flags JWT-shaped values", () => {
    expect(
      looksLikeRawSecretToken(
        "not-a-real-jwt-header-segment.not-a-real-jwt-payload-segment.not-a-real-jwt-signature-segment"
      )
    ).toBe(true);
  });

  test("flags Meta/Facebook graph-token-shaped values", () => {
    expect(
      looksLikeRawSecretToken(
        "EAABwzZCZCpvNsBAA1234567890abcdefghijklmnopqrstuvwxyz"
      )
    ).toBe(true);
  });

  test("flags Google OAuth-shaped values", () => {
    expect(
      looksLikeRawSecretToken("ya29.a0AfH6SMBx1234567890abcdefghijklmnop")
    ).toBe(true);
  });

  test("flags GitHub-style token prefixes", () => {
    expect(
      looksLikeRawSecretToken("ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD")
    ).toBe(true);
  });

  test("flags a long unstructured base64/hex blob with no separators", () => {
    expect(looksLikeRawSecretToken("a".repeat(80))).toBe(true);
  });

  test("flags a realistic Telegram Bot API token (Issue #731 review round 1, security-auditor High finding)", () => {
    // Realistic shape: <bot_id 6-10 digits>:<35-char secret>. The original
    // catch-all blob check exempted ANY colon-containing string from the
    // entropy rejection, which incidentally whitelisted this exact shape —
    // Telegram is the very next provider adapter this epic ships (#646).
    expect(
      looksLikeRawSecretToken("110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw")
    ).toBe(true);
    expect(
      looksLikeRawSecretToken("5012345678:AAFxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")
    ).toBe(true);
  });

  test("does not flag a short, structured secret-storage reference", () => {
    expect(looksLikeRawSecretToken("secretsmanager:social/fb-page-42")).toBe(
      false
    );
    expect(looksLikeRawSecretToken("env:SOCIAL_TOKEN_FB_PAGE_42")).toBe(false);
  });

  test("does not flag a reference using any known reference prefix, even a long one", () => {
    expect(
      looksLikeRawSecretToken(
        `ref:${"a".repeat(80)}` // long, but shaped like a known reference prefix, not a bare blob.
      )
    ).toBe(false);
    expect(
      looksLikeRawSecretToken(`vault:secret/data/social/telegram#token`)
    ).toBe(false);
    expect(looksLikeRawSecretToken(`ssm:/social/telegram/bot-token`)).toBe(
      false
    );
    expect(looksLikeRawSecretToken(`kms:alias/social-telegram-token`)).toBe(
      false
    );
  });

  test("a long blob-shaped value containing a colon but NOT matching a known reference prefix is still flagged (narrowed exemption)", () => {
    expect(looksLikeRawSecretToken(`${"a".repeat(70)}:${"b".repeat(10)}`)).toBe(
      true
    );
  });
});

describe("validateCreateSocialAccountInput (Issue #643)", () => {
  const BASE = {
    providerKey: "telegram_channel",
    providerAccountId: "channel-1",
    providerAccountName: "My Channel",
    providerAccountType: "channel",
    tokenReference: "secretsmanager:social/telegram-1"
  };

  test("accepts a well-formed request", () => {
    const result = validateCreateSocialAccountInput(BASE);
    expect(result.valid).toBe(true);
  });

  test("rejects a tokenReference shaped like a raw secret", () => {
    const result = validateCreateSocialAccountInput({
      ...BASE,
      tokenReference:
        "not-a-real-jwt-header-segment.not-a-real-jwt-payload-segment.not-a-real-jwt-signature-segment"
    });
    expect(result.valid).toBe(false);
  });

  test("rejects an invalid providerAccountType", () => {
    const result = validateCreateSocialAccountInput({
      ...BASE,
      providerAccountType: "not-a-real-type"
    });
    expect(result.valid).toBe(false);
  });

  test("rejects a malformed providerKey", () => {
    const result = validateCreateSocialAccountInput({
      ...BASE,
      providerKey: "Telegram Channel!"
    });
    expect(result.valid).toBe(false);
  });
});
