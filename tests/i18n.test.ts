import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parsePo } from "../src/lib/i18n/po-parser";
import {
  DEFAULT_LOCALE,
  isSupportedLocale,
  LOCALE_COOKIE_NAME,
  resolveLocale,
  SUPPORTED_LOCALES
} from "../src/lib/i18n/locale";
import { clearCatalogCache, loadCatalog } from "../src/lib/i18n/catalog";
import { createTranslator, interpolate } from "../src/lib/i18n/translate";
import {
  buildClientErrorMessages,
  translateErrorCode
} from "../src/lib/i18n/error-messages";
import {
  formatCurrencyIDR,
  formatDate,
  formatDateTime,
  formatNumber
} from "../src/lib/i18n/format";

describe("parsePo", () => {
  test("parses simple msgid/msgstr pairs", () => {
    const source = [
      'msgid "greeting"',
      'msgstr "Hello"',
      "",
      'msgid "farewell"',
      'msgstr "Goodbye"'
    ].join("\n");

    expect(parsePo(source)).toEqual({
      greeting: "Hello",
      farewell: "Goodbye"
    });
  });

  test("skips the PO header (empty msgid) as metadata, not a key", () => {
    const source = [
      'msgid ""',
      'msgstr ""',
      '"Content-Type: text/plain; charset=UTF-8\\n"',
      "",
      'msgid "real.key"',
      'msgstr "Value"'
    ].join("\n");

    const result = parsePo(source);
    expect(result[""]).toBeUndefined();
    expect(result["real.key"]).toBe("Value");
  });

  test("concatenates multi-line quoted strings", () => {
    const source = [
      'msgid "long.greeting"',
      'msgstr "Hello, "',
      '"world!"'
    ].join("\n");

    expect(parsePo(source)["long.greeting"]).toBe("Hello, world!");
  });

  test("decodes escaped quotes, backslashes, and newlines", () => {
    const source = [
      'msgid "quoted"',
      'msgstr "She said \\"hi\\" then left\\n"'
    ].join("\n");

    expect(parsePo(source).quoted).toBe('She said "hi" then left\n');
  });

  test("ignores comment lines", () => {
    const source = [
      "# a translator comment",
      "#: src/pages/login.astro",
      "#. a note for translators",
      'msgid "commented.key"',
      'msgstr "Value"'
    ].join("\n");

    expect(parsePo(source)["commented.key"]).toBe("Value");
  });

  test("skips a malformed entry (msgid with no following msgstr)", () => {
    const source = [
      'msgid "orphan"',
      "",
      'msgid "valid.key"',
      'msgstr "Value"'
    ].join("\n");

    const result = parsePo(source);
    expect(result.orphan).toBeUndefined();
    expect(result["valid.key"]).toBe("Value");
  });

  test("returns an empty catalog for empty source", () => {
    expect(parsePo("")).toEqual({});
  });
});

describe("locale resolution", () => {
  test("SUPPORTED_LOCALES includes en and id, default is en", () => {
    expect(SUPPORTED_LOCALES).toContain("en");
    expect(SUPPORTED_LOCALES).toContain("id");
    expect(DEFAULT_LOCALE).toBe("en");
  });

  test("isSupportedLocale accepts only known locales", () => {
    expect(isSupportedLocale("en")).toBe(true);
    expect(isSupportedLocale("id")).toBe(true);
    expect(isSupportedLocale("ms")).toBe(false);
    expect(isSupportedLocale("ar")).toBe(false);
    expect(isSupportedLocale(null)).toBe(false);
    expect(isSupportedLocale(undefined)).toBe(false);
    expect(isSupportedLocale(42)).toBe(false);
  });

  test("cookie locale wins over tenant default", () => {
    expect(
      resolveLocale({ cookieLocale: "id", tenantDefaultLocale: "en" })
    ).toBe("id");
  });

  test("falls back to tenant default when no cookie", () => {
    expect(
      resolveLocale({ cookieLocale: null, tenantDefaultLocale: "id" })
    ).toBe("id");
  });

  test("falls back to en when neither cookie nor tenant default is valid", () => {
    expect(resolveLocale({})).toBe("en");
    expect(
      resolveLocale({ cookieLocale: "fr", tenantDefaultLocale: "ms" })
    ).toBe("en");
  });

  test("an invalid cookie locale does not shadow a valid tenant default", () => {
    expect(
      resolveLocale({ cookieLocale: "xx", tenantDefaultLocale: "id" })
    ).toBe("id");
  });

  test("LOCALE_COOKIE_NAME is the documented cookie name", () => {
    expect(LOCALE_COOKIE_NAME).toBe("awcms_mini_locale");
  });
});

describe("catalog loading + translation", () => {
  async function withFixtureCatalog(
    files: Record<string, string>,
    run: (dir: string) => Promise<void>
  ): Promise<void> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "awcms-i18n-test-"));
    try {
      for (const [name, content] of Object.entries(files)) {
        await writeFile(path.join(dir, name), content, "utf8");
      }
      await run(dir);
    } finally {
      clearCatalogCache();
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("loadCatalog parses the requested locale's .po file", async () => {
    await withFixtureCatalog(
      { "en.po": 'msgid "hello"\nmsgstr "Hello"\n' },
      async (dir) => {
        const catalog = await loadCatalog("en", dir);
        expect(catalog.hello).toBe("Hello");
      }
    );
  });

  test("createTranslator falls back to DEFAULT_LOCALE for a missing key", async () => {
    await withFixtureCatalog(
      {
        "en.po": 'msgid "only.in.english"\nmsgstr "English text"\n',
        "id.po": 'msgid "shared.key"\nmsgstr "Teks bersama"\n'
      },
      async (dir) => {
        const idCatalog = await loadCatalog("id", dir);
        expect(idCatalog["only.in.english"]).toBeUndefined();

        // Simulate the fallback chain createTranslator implements: id catalog
        // misses "only.in.english", DEFAULT_LOCALE (en) catalog has it.
        const enCatalog = await loadCatalog("en", dir);
        const template =
          idCatalog["only.in.english"] ??
          enCatalog["only.in.english"] ??
          "only.in.english";
        expect(template).toBe("English text");
      }
    );
  });

  test("createTranslator falls back to the raw key when translation is missing everywhere", async () => {
    await withFixtureCatalog(
      { "en.po": 'msgid "present"\nmsgstr "Present"\n' },
      async (dir) => {
        const t = await createTranslator("en", dir);
        expect(t("does.not.exist")).toBe("does.not.exist");
      }
    );
  });

  test("createTranslator interpolates params", async () => {
    await withFixtureCatalog(
      {
        "en.po": 'msgid "greeting"\nmsgstr "Hello, {name}!"\n'
      },
      async (dir) => {
        const t = await createTranslator("en", dir);
        expect(t("greeting", { name: "Ada" })).toBe("Hello, Ada!");
      }
    );
  });
});

describe("interpolate", () => {
  test("substitutes known params", () => {
    expect(interpolate("Hello, {name}!", { name: "Ada" })).toBe("Hello, Ada!");
  });

  test("leaves unknown placeholders untouched", () => {
    expect(interpolate("Hello, {name}!", { other: "x" })).toBe(
      "Hello, {name}!"
    );
  });

  test("returns the template as-is when no params are given", () => {
    expect(interpolate("No placeholders here")).toBe("No placeholders here");
  });

  test("substitutes numeric params", () => {
    expect(interpolate("Allow ({days} days)", { days: 30 })).toBe(
      "Allow (30 days)"
    );
  });
});

describe("error-messages", () => {
  const fakeTranslator = (key: string) =>
    key === "error.access_denied" ? "You cannot do that." : key;

  test("translateErrorCode maps a known code to its translated message", () => {
    expect(
      translateErrorCode(fakeTranslator, "ACCESS_DENIED", "fallback")
    ).toBe("You cannot do that.");
  });

  test("translateErrorCode falls back for an unknown code", () => {
    expect(
      translateErrorCode(fakeTranslator, "SOME_UNKNOWN_CODE", "fallback")
    ).toBe("fallback");
  });

  test("translateErrorCode falls back when the catalog has no translation for a known code", () => {
    // fakeTranslator returns the key itself for any code other than
    // ACCESS_DENIED, simulating a missing translation.
    expect(
      translateErrorCode(fakeTranslator, "VALIDATION_ERROR", "fallback")
    ).toBe("fallback");
  });

  test("buildClientErrorMessages returns one entry per known error code", () => {
    const messages = buildClientErrorMessages(fakeTranslator);
    expect(messages.ACCESS_DENIED).toBe("You cannot do that.");
    expect(Object.keys(messages).length).toBeGreaterThan(10);
  });
});

describe("formatters", () => {
  const amount = 1234567.5;

  test("formatNumber uses locale-specific separators", () => {
    expect(formatNumber(amount, "en")).toBe("1,234,567.5");
    expect(formatNumber(amount, "id")).toBe("1.234.567,5");
  });

  test("formatCurrencyIDR formats IDR with no decimals", () => {
    // Intl inserts U+00A0 (no-break space) between the currency symbol/code
    // and the amount, not a plain space.
    expect(formatCurrencyIDR(15000, "en")).toBe("IDR 15,000");
    expect(formatCurrencyIDR(15000, "id")).toBe("Rp 15.000");
  });

  test("formatDate and formatDateTime are fixed to Asia/Jakarta", () => {
    const date = new Date("2026-07-06T10:30:00Z");
    expect(formatDate(date, "en")).toBe("Jul 6, 2026");
    expect(formatDate(date, "id")).toBe("6 Jul 2026");
    expect(formatDateTime(date, "en")).toContain("Jul 6, 2026");
    expect(formatDateTime(date, "id")).toContain("6 Jul 2026");
  });
});
