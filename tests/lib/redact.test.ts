import { describe, expect, test } from "bun:test";
import { isSensitiveKey, redactSensitive, REDACTED_VALUE } from "../../src/lib/logging/redact";

describe("redaction (doc 10)", () => {
  test("mengenali variasi key sensitif", () => {
    for (const key of [
      "password",
      "passwordHash",
      "password_hash",
      "accessToken",
      "refresh_token",
      "apiKey",
      "API_KEY",
      "authorization",
      "npwp",
      "nik",
      "phone",
      "whatsapp",
      "email",
      "clientSecret"
    ]) {
      expect(isSensitiveKey(key)).toBe(true);
    }
    expect(isSensitiveKey("displayName")).toBe(false);
    expect(isSensitiveKey("status")).toBe(false);
  });

  test("redact bersarang dan array", () => {
    const result = redactSensitive({
      users: [{ email: "a@b.c", name: "A" }],
      meta: { deep: { npwp: "01.234" } }
    });
    expect(result.users[0]?.email).toBe(REDACTED_VALUE);
    expect(result.users[0]?.name).toBe("A");
    expect((result.meta.deep as Record<string, unknown>).npwp).toBe(REDACTED_VALUE);
  });

  test("aman terhadap referensi siklik", () => {
    const cyclic: Record<string, unknown> = { name: "x" };
    cyclic.self = cyclic;
    const result = redactSensitive(cyclic);
    expect(result.self).toBe("[CYCLE]");
  });
});
