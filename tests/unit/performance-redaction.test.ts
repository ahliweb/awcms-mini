/**
 * Unit tests for report redaction (Issue #744, epic #738) — the
 * non-negotiable "Result artifacts redact DSNs, host credentials, and
 * high-cardinality tenant/user identifiers" requirement.
 */
import { describe, expect, test } from "bun:test";

import {
  createIdRedactor,
  redactDatabaseUrl,
  redactDsnPatternsDeep,
  redactUuidsDeep
} from "../../src/lib/performance/redaction";

describe("redactDatabaseUrl", () => {
  test("strips username and password, keeps host/port/database", () => {
    const redacted = redactDatabaseUrl(
      "postgres://awcms_mini_app:s3cr3t-password@db.internal:5432/awcms-mini"
    );

    expect(redacted).not.toContain("awcms_mini_app");
    expect(redacted).not.toContain("s3cr3t-password");
    expect(redacted).toContain("db.internal");
    expect(redacted).toContain("5432");
    expect(redacted).toContain("<redacted>");
  });

  test("returns a placeholder for an unset value", () => {
    expect(redactDatabaseUrl(undefined)).toBe("(not set)");
  });

  test("never throws on an unparsable value", () => {
    expect(() => redactDatabaseUrl("not a url at all")).not.toThrow();
    expect(redactDatabaseUrl("not a url at all")).toContain("redacted");
  });
});

describe("createIdRedactor", () => {
  test("assigns stable pseudonyms in first-seen order", () => {
    const redactor = createIdRedactor("tenant");
    const idA = "11111111-1111-1111-1111-111111111111";
    const idB = "22222222-2222-2222-2222-222222222222";

    expect(redactor.redact(idA)).toBe("tenant#1");
    expect(redactor.redact(idB)).toBe("tenant#2");
    // Re-redacting the SAME real id returns the SAME pseudonym.
    expect(redactor.redact(idA)).toBe("tenant#1");
    expect(redactor.size()).toBe(2);
  });

  test("a fresh redactor never reuses another redactor's numbering", () => {
    const first = createIdRedactor("tenant");
    const second = createIdRedactor("tenant");
    const id = "33333333-3333-3333-3333-333333333333";

    first.redact("00000000-0000-0000-0000-000000000000");
    expect(second.redact(id)).toBe("tenant#1");
  });
});

describe("redactUuidsDeep", () => {
  test("replaces every UUID-shaped string nested anywhere in the value", () => {
    const redactor = createIdRedactor("id");
    const input = {
      tenantId: "11111111-1111-1111-1111-111111111111",
      nested: {
        list: ["22222222-2222-2222-2222-222222222222", "not-a-uuid"]
      }
    };

    const result = redactUuidsDeep(input, redactor) as typeof input;

    expect(result.tenantId).toBe("id#1");
    expect((result.nested.list as string[])[0]).toBe("id#2");
    expect((result.nested.list as string[])[1]).toBe("not-a-uuid");
  });

  test("leaves non-UUID strings, numbers, and booleans untouched", () => {
    const redactor = createIdRedactor("id");
    const input = {
      name: "audit-events-rls-keyset-pagination",
      cost: 42,
      ok: true
    };

    expect(redactUuidsDeep(input, redactor)).toEqual(input);
  });

  test("ADVERSARIAL (reviewer finding on PR #775): redacts a UUID EMBEDDED inside a longer free-text string, not just a value that is nothing but a UUID", () => {
    const redactor = createIdRedactor("id");
    const tenantId = "44444444-4444-4444-4444-444444444444";
    const detail = `tenant ${tenantId} rejected: capacity exceeded`;

    const result = redactUuidsDeep(detail, redactor) as string;

    expect(result).not.toContain(tenantId);
    expect(result).toBe("tenant id#1 rejected: capacity exceeded");
  });

  test("redacts multiple distinct embedded UUIDs in the same string, consistently via the same redactor", () => {
    const redactor = createIdRedactor("id");
    const first = "11111111-1111-1111-1111-111111111111";
    const second = "22222222-2222-2222-2222-222222222222";
    const detail = `moved from ${first} to ${second}, then back to ${first}`;

    const result = redactUuidsDeep(detail, redactor) as string;

    expect(result).toBe("moved from id#1 to id#2, then back to id#1");
  });
});

describe("redactDsnPatternsDeep", () => {
  test("redacts a DSN embedded inside a longer free-text string (security-auditor finding on PR #775)", () => {
    const detail =
      "seeding failed: connection error for postgres://awcms_mini_app:s3cr3t@db.internal:5432/awcms-mini";

    const result = redactDsnPatternsDeep(detail) as string;

    expect(result).not.toContain("awcms_mini_app");
    expect(result).not.toContain("s3cr3t");
    expect(result).toContain("db.internal");
    expect(result).toContain("<redacted>");
    expect(result).toContain("seeding failed: connection error for");
  });

  test("walks nested objects/arrays, matching redactUuidsDeep's own traversal shape", () => {
    const input = {
      scenarios: [
        {
          detail:
            "error: postgres://user:pass@host.example.com:5432/db unreachable"
        }
      ]
    };

    const result = redactDsnPatternsDeep(input) as typeof input;

    expect(result.scenarios[0]!.detail).not.toContain("user:pass");
    expect(result.scenarios[0]!.detail).toContain("<redacted>");
  });

  test("leaves strings with no DSN-shaped substring unchanged", () => {
    expect(redactDsnPatternsDeep("plain detail, no connection string")).toBe(
      "plain detail, no connection string"
    );
  });
});
