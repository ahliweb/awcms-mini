/**
 * Drift-fixture tests for `scripts/i18n-parity-check.ts` (Issue #685,
 * epic #679) — proves the gate actually FAILS on each drift shape it
 * claims to catch, using synthetic key sets rather than mutating the real
 * `i18n/*.po`/`.pot` files. Extended by Issue #694 with placeholder-parity
 * and plural-forms-tripwire fixtures (`checkPlaceholderParity`,
 * `checkNoPluralForms`).
 */
import { describe, expect, test } from "bun:test";

import {
  checkKeyParity,
  checkNoPluralForms,
  checkPlaceholderParity,
  extractPlaceholders,
  runI18nParityCheck
} from "../../scripts/i18n-parity-check";

describe("checkKeyParity", () => {
  test("passes when all catalogs share the exact same key set", () => {
    const problems = checkKeyParity({
      "en.po": new Set(["a.b", "c.d"]),
      "id.po": new Set(["a.b", "c.d"]),
      "messages.pot": new Set(["a.b", "c.d"])
    });

    expect(problems).toEqual([]);
  });

  test("fails when a key is missing from one catalog (drift fixture)", () => {
    const problems = checkKeyParity({
      "en.po": new Set(["a.b", "c.d"]),
      "id.po": new Set(["a.b"]), // "c.d" missing — simulates a translator gap
      "messages.pot": new Set(["a.b", "c.d"])
    });

    expect(problems).toHaveLength(1);
    expect(problems[0]!.file).toBe("i18n/id.po");
    expect(problems[0]!.message).toContain('"c.d"');
  });

  test("fails when a key is missing from the template only (stale .pot)", () => {
    const problems = checkKeyParity({
      "en.po": new Set(["a.b", "c.d"]),
      "id.po": new Set(["a.b", "c.d"]),
      "messages.pot": new Set(["a.b"]) // "c.d" never extracted to the template
    });

    expect(problems).toHaveLength(1);
    expect(problems[0]!.file).toBe("i18n/messages.pot");
  });

  test("reports one problem per drifted key, not per catalog", () => {
    const problems = checkKeyParity({
      "en.po": new Set(["a.b", "c.d", "e.f"]),
      "id.po": new Set(["a.b"]),
      "messages.pot": new Set(["a.b"])
    });

    expect(problems).toHaveLength(2);
  });

  test("a key entirely absent from every catalog is not reported (not a parity issue)", () => {
    const problems = checkKeyParity({
      "en.po": new Set(["a.b"]),
      "id.po": new Set(["a.b"]),
      "messages.pot": new Set(["a.b"])
    });

    expect(problems).toEqual([]);
  });

  test("does nothing with fewer than two catalogs (nothing to compare)", () => {
    expect(checkKeyParity({ "en.po": new Set(["a.b"]) })).toEqual([]);
    expect(checkKeyParity({})).toEqual([]);
  });
});

describe("extractPlaceholders", () => {
  test("extracts every distinct {word} placeholder", () => {
    expect(
      extractPlaceholders("Hello, {name}! You have {days} days left.")
    ).toEqual(new Set(["name", "days"]));
  });

  test("returns an empty set for a string with no placeholders", () => {
    expect(extractPlaceholders("No placeholders here")).toEqual(new Set());
  });
});

describe("checkPlaceholderParity (Issue #694 — placeholder mismatch fixture)", () => {
  test("passes when a shared key's placeholders match exactly", () => {
    const problems = checkPlaceholderParity(
      { "greeting.hello": "Hello, {name}!" },
      { "greeting.hello": "Halo, {name}!" }
    );

    expect(problems).toEqual([]);
  });

  test("fails when id.po drops a placeholder en.po has (drift fixture)", () => {
    const problems = checkPlaceholderParity(
      { "greeting.hello": "Hello, {name}!" },
      { "greeting.hello": "Halo!" } // translator forgot {name}
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain('"greeting.hello"');
    expect(problems[0]!.message).toContain("id.po is missing {name}");
  });

  test("fails when id.po has a placeholder en.po doesn't", () => {
    const problems = checkPlaceholderParity(
      { "greeting.hello": "Hello!" },
      { "greeting.hello": "Halo, {name}!" }
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain("en.po is missing {name}");
  });

  test("ignores a key present in only one catalog (checkKeyParity's job, not this function's)", () => {
    const problems = checkPlaceholderParity(
      { "only.in.en": "Hello, {name}!" },
      {}
    );

    expect(problems).toEqual([]);
  });

  test("reports one problem per mismatched key, not per placeholder", () => {
    const problems = checkPlaceholderParity(
      { "a.b": "Hi {name} ({days} days)" },
      { "a.b": "Hai" } // missing both {name} and {days}
    );

    expect(problems).toHaveLength(1);
  });
});

describe("checkNoPluralForms (Issue #694 — plural-forms tripwire fixture)", () => {
  test("passes when no source contains msgid_plural", () => {
    const problems = checkNoPluralForms({
      "en.po": 'msgid "a.b"\nmsgstr "Hello"\n',
      "id.po": 'msgid "a.b"\nmsgstr "Halo"\n'
    });

    expect(problems).toEqual([]);
  });

  test("fails when a source introduces msgid_plural (unsupported plural mismatch fixture)", () => {
    const problems = checkNoPluralForms({
      "en.po": [
        'msgid "item.count"',
        'msgid_plural "item.count.plural"',
        'msgstr[0] "one item"',
        'msgstr[1] "{count} items"'
      ].join("\n")
    });

    expect(problems).toHaveLength(1);
    expect(problems[0]!.file).toBe("i18n/en.po");
    expect(problems[0]!.message).toContain("msgid_plural");
  });
});

describe("runI18nParityCheck against the real repository catalogs (Issue #685/#694)", () => {
  test("the real i18n/en.po, i18n/id.po, and i18n/messages.pot are in sync today (keys, placeholders, no plural forms)", async () => {
    const problems = await runI18nParityCheck();

    expect(problems).toEqual([]);
  });
});
