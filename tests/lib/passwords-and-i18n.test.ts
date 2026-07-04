import { describe, expect, test } from "bun:test";
import { hashPassword, verifyPassword } from "../../src/lib/auth/passwords";
import { resolveLocale, textDirection } from "../../src/lib/i18n";

describe("password hashing (scrypt)", () => {
  test("hash/verify roundtrip", async () => {
    const hash = await hashPassword("s3cret-panjang!");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("s3cret-panjang!", hash)).toBe(true);
    expect(await verifyPassword("salah", hash)).toBe(false);
  });

  test("hash unik per salt", async () => {
    const a = await hashPassword("sama");
    const b = await hashPassword("sama");
    expect(a).not.toBe(b);
  });

  test("hash malformed tidak crash — return false", async () => {
    expect(await verifyPassword("x", "bukan-hash")).toBe(false);
    expect(await verifyPassword("x", "scrypt$abc$def")).toBe(false);
  });
});

describe("i18n dasar (doc 14)", () => {
  test("resolveLocale menghormati q-value dan fallback", () => {
    expect(resolveLocale("en-US,en;q=0.9,id;q=0.8")).toBe("en");
    expect(resolveLocale("fr-FR,fr;q=0.9")).toBe("id");
    expect(resolveLocale(null)).toBe("id");
    expect(resolveLocale("ar")).toBe("ar");
  });

  test("arah teks RTL untuk ar", () => {
    expect(textDirection("ar")).toBe("rtl");
    expect(textDirection("id")).toBe("ltr");
  });
});
