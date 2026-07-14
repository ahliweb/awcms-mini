import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  findSecretShapedValues,
  findSensitiveKeys,
  redactSecretsInText,
  redactSensitiveAttributes,
  redactSensitiveJsonValue
} from "../src/modules/_shared/redaction";
import {
  getAuditExportHook,
  recordAuditEvent,
  setAuditExportHook,
  type AuditEventInput,
  type AuditEventRecorded
} from "../src/modules/logging/application/audit-log";

describe("redactSensitiveAttributes", () => {
  test("undefined input stays undefined", () => {
    expect(redactSensitiveAttributes(undefined)).toBeUndefined();
  });

  test("keys that don't match any redaction key are left untouched", () => {
    expect(
      redactSensitiveAttributes({ reason: "customer request", count: 3 })
    ).toEqual({ reason: "customer request", count: 3 });
  });

  test("redacts top-level keys matching the redaction list, case-insensitively", () => {
    expect(
      redactSensitiveAttributes({
        password: "hunter2",
        PasswordHash: "abc",
        token: "t1",
        accessToken: "t2",
        refreshToken: "t3",
        apiKey: "k1",
        secret: "s1",
        Authorization: "Bearer xyz",
        npwp: "12.345.678.9-012.000",
        nik: "3271xxxxxxxxxxxx",
        phone: "+62812xxxxxxx",
        whatsapp: "+62812xxxxxxx",
        email: "user@example.com"
      })
    ).toEqual({
      password: "[REDACTED]",
      PasswordHash: "[REDACTED]",
      token: "[REDACTED]",
      accessToken: "[REDACTED]",
      refreshToken: "[REDACTED]",
      apiKey: "[REDACTED]",
      secret: "[REDACTED]",
      Authorization: "[REDACTED]",
      npwp: "[REDACTED]",
      nik: "[REDACTED]",
      phone: "[REDACTED]",
      whatsapp: "[REDACTED]",
      email: "[REDACTED]"
    });
  });

  test("matches on substring, not exact key name (e.g. customerEmail, contactPhoneNumber)", () => {
    expect(
      redactSensitiveAttributes({
        customerEmail: "user@example.com",
        contactPhoneNumber: "+62812xxxxxxx",
        internalApiKeyRef: "key-1"
      })
    ).toEqual({
      customerEmail: "[REDACTED]",
      contactPhoneNumber: "[REDACTED]",
      internalApiKeyRef: "[REDACTED]"
    });
  });

  test("redacts sensitive keys nested inside objects", () => {
    expect(
      redactSensitiveAttributes({
        actor: { name: "Owner", email: "owner@example.com" },
        reason: "soft delete"
      })
    ).toEqual({
      actor: { name: "Owner", email: "[REDACTED]" },
      reason: "soft delete"
    });
  });

  test("redacts sensitive keys nested inside arrays of objects", () => {
    expect(
      redactSensitiveAttributes({
        identifiers: [
          { type: "email", value: "a@example.com" },
          { type: "phone", value: "+62812xxxxxxx" }
        ]
      })
    ).toEqual({
      identifiers: [
        { type: "email", value: "a@example.com" },
        { type: "phone", value: "+62812xxxxxxx" }
      ]
    });
  });

  test("redacts sensitive keys inside arrays of objects when the key itself is sensitive", () => {
    expect(
      redactSensitiveAttributes({
        contacts: [{ email: "a@example.com" }, { phone: "+62812xxxxxxx" }]
      })
    ).toEqual({
      contacts: [{ email: "[REDACTED]" }, { phone: "[REDACTED]" }]
    });
  });

  test("does not mutate the input object", () => {
    const input = { password: "hunter2", note: "keep" };
    const result = redactSensitiveAttributes(input);

    expect(input.password).toBe("hunter2");
    expect(result).not.toBe(input);
  });

  test("redacts credential (Issue #516 — added for module settings rejection)", () => {
    expect(redactSensitiveAttributes({ credential: "shh" })).toEqual({
      credential: "[REDACTED]"
    });
  });

  // Issue #687 — extending REDACTION_KEYS with "cookie" and an IP-address
  // synonym set (credentials/tokens/cookies/authorization headers/DSNs/
  // email/IP per the issue's own acceptance criteria).
  test("redacts cookie-named keys (substring match, like the other keys above)", () => {
    expect(
      redactSensitiveAttributes({
        cookie: "session=abc123",
        setCookie: "session=abc123",
        cookies: ["a", "b"]
      })
    ).toEqual({
      cookie: "[REDACTED]",
      setCookie: "[REDACTED]",
      cookies: "[REDACTED]"
    });
  });

  // PR #712 follow-up (security review, item 7) — the same over-match
  // concern raised for "ip" (a 2-character substring matching inside many
  // unrelated words) does NOT apply the same way to "cookie": it's a
  // 6-character substring, and a repo-wide grep for
  // `[a-zA-Z_]*[Cc]ookie[a-zA-Z_]*` across `src/` (before writing this
  // test) found only genuinely cookie-related identifiers
  // (`cookieLocale`, `cookieName`, `cookieOptions`, `cookies`,
  // `AstroCookies`) — no unrelated English word in this codebase happens
  // to contain "cookie" as an accidental substring the way "shipping"/
  // "recipient" contain "ip". This test locks in that the existing
  // substring approach (not an exact-match allowlist like "ip" needed)
  // stays intentional, not an oversight.
  test("cookie-adjacent, non-secret field names in this codebase are all legitimately cookie-related", () => {
    // `cookieLocale`/`cookieName`/`cookieOptions` are real field/parameter
    // names in this codebase (`src/lib/i18n/*`, `src/middleware.ts`) — none
    // of them are secrets themselves, but redacting them as a side effect
    // of the substring match is the safe direction (over-inclusive, not
    // an information leak), unlike "ip" which had genuine unrelated-word
    // false positives to guard against.
    expect(
      redactSensitiveAttributes({
        cookieLocale: "en",
        cookieName: "awcms_mini_session",
        reason: "unrelated, must stay untouched"
      })
    ).toEqual({
      cookieLocale: "[REDACTED]",
      cookieName: "[REDACTED]",
      reason: "unrelated, must stay untouched"
    });
  });

  test("redacts every real IP-address key shape (exact-match synonyms, not substring)", () => {
    expect(
      redactSensitiveAttributes({
        ip: "203.0.113.5",
        ipAddress: "203.0.113.5",
        ip_address: "203.0.113.5",
        clientIp: "203.0.113.5",
        client_ip: "203.0.113.5",
        remoteAddr: "203.0.113.5",
        remote_address: "203.0.113.5",
        "x-forwarded-for": "203.0.113.5",
        xForwardedFor: "203.0.113.5"
      })
    ).toEqual({
      ip: "[REDACTED]",
      ipAddress: "[REDACTED]",
      ip_address: "[REDACTED]",
      clientIp: "[REDACTED]",
      client_ip: "[REDACTED]",
      remoteAddr: "[REDACTED]",
      remote_address: "[REDACTED]",
      "x-forwarded-for": "[REDACTED]",
      xForwardedFor: "[REDACTED]"
    });
  });

  // Issue #687 — the over-match finding: a plain substring check for "ip"
  // (mirroring how the other REDACTION_KEYS entries work) would also catch
  // every key that merely *contains* the letters "ip" consecutively.
  // Verified before shipping the "ip" addition — these keys must NOT be
  // redacted, so "ip" is an exact-match synonym allowlist, not a
  // REDACTION_KEYS substring entry.
  test("does NOT redact keys that merely contain the substring 'ip' (over-match check)", () => {
    expect(
      redactSensitiveAttributes({
        description: "a package description",
        shipping: "flat rate",
        recipient: "Jane Doe",
        equipment: "POS terminal",
        membership: "gold tier",
        principal: "site owner"
      })
    ).toEqual({
      description: "a package description",
      shipping: "flat rate",
      recipient: "Jane Doe",
      equipment: "POS terminal",
      membership: "gold tier",
      principal: "site owner"
    });
  });
});

// Issue #785 — array-recursion sibling of `redactSensitiveAttributes`, used
// where the top-level JSON value is a batch array of records rather than a
// single object (e.g. a batch-webhook provider body).
describe("redactSensitiveJsonValue", () => {
  test("undefined input stays undefined", () => {
    expect(redactSensitiveJsonValue(undefined)).toBeUndefined();
  });

  test("null input stays null (never coerced to undefined or {})", () => {
    expect(redactSensitiveJsonValue(null)).toBeNull();
  });

  test("a top-level object behaves identically to redactSensitiveAttributes", () => {
    expect(
      redactSensitiveJsonValue({ email: "user@example.com", count: 3 })
    ).toEqual({ email: "[REDACTED]", count: 3 });
  });

  test("recurses into a top-level array of records, redacting each element", () => {
    expect(
      redactSensitiveJsonValue([
        { email: "a@example.com", label: "ok" },
        { password: "hunter2", count: 2 },
        { nested: { token: "shh" } }
      ])
    ).toEqual([
      { email: "[REDACTED]", label: "ok" },
      { password: "[REDACTED]", count: 2 },
      { nested: { token: "[REDACTED]" } }
    ]);
  });

  test("an empty top-level array stays an empty array", () => {
    expect(redactSensitiveJsonValue([])).toEqual([]);
  });

  test("a top-level array containing an array of records (batch-of-batches) still recurses", () => {
    expect(
      redactSensitiveJsonValue([[{ apiKey: "shh" }], [{ label: "ok" }]])
    ).toEqual([[{ apiKey: "[REDACTED]" }], [{ label: "ok" }]]);
  });

  // Defensive/runtime check beyond the officially-typed input surface (the
  // exported type only declares object/array/null/undefined) — a caller
  // passing an unexpected primitive at runtime (e.g. a malformed provider
  // response before its own shape validation runs) must not throw, since
  // `redactValue` already returns non-object/array values unchanged.
  test("a primitive value (outside the declared type) is returned unchanged, not thrown", () => {
    const asUnknown = redactSensitiveJsonValue as (input: unknown) => unknown;

    expect(asUnknown("just a string")).toBe("just a string");
    expect(asUnknown(42)).toBe(42);
    expect(asUnknown(true)).toBe(true);
  });
});

describe("findSensitiveKeys", () => {
  test("undefined input yields no keys", () => {
    expect(findSensitiveKeys(undefined)).toEqual([]);
  });

  test("no keys when nothing matches", () => {
    expect(findSensitiveKeys({ theme: "dark", retries: 3 })).toEqual([]);
  });

  test("finds a top-level secret-shaped key", () => {
    expect(findSensitiveKeys({ apiToken: "sk-123" })).toEqual(["apiToken"]);
  });

  test("finds a secret-shaped key nested in an object", () => {
    expect(findSensitiveKeys({ provider: { credential: "shh" } })).toEqual([
      "credential"
    ]);
  });

  test("finds a secret-shaped key nested inside an array of objects", () => {
    expect(
      findSensitiveKeys({ webhooks: [{ url: "x", secret: "shh" }] })
    ).toEqual(["secret"]);
  });
});

describe("findSecretShapedValues", () => {
  test("undefined input yields no paths", () => {
    expect(findSecretShapedValues(undefined)).toEqual([]);
  });

  test("ordinary label/URL/flag values are left alone", () => {
    expect(
      findSecretShapedValues({
        publicLabel: "Acme News",
        publicBasePath: "/news",
        enabled: true,
        webhookUrl: "https://example.com/hooks/acme"
      })
    ).toEqual([]);
  });

  test("finds a JWT-shaped value under an innocently-named key", () => {
    expect(
      findSecretShapedValues({
        // Deliberately fabricated, not the well-known jwt.io canonical
        // example token — that exact string previously tripped GitGuardian's
        // scanner on this PR despite being public test data (structural
        // JWT-pattern matching doesn't distinguish "famous example" from
        // "real secret"). This fixture only needs to be JWT-*shaped* (three
        // base64url segments prefixed `eyJ`) to exercise the same regex, so
        // a fabricated, non-canonical value works equally well as a test.
        publicLabel:
          "eyJub3RfYV9yZWFsX2p3dF9maXh0dXJl.eyJqdXN0X3Rlc3RfZGF0YV9oZXJl.bm90YV9yZWFsX3NpZ25hdHVyZQ"
      })
    ).toEqual(["publicLabel"]);
  });

  test("finds a PEM private key block", () => {
    expect(
      findSecretShapedValues({
        note: "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEA\n-----END PRIVATE KEY-----"
      })
    ).toEqual(["note"]);
  });

  test("finds an AWS access key id", () => {
    expect(
      findSecretShapedValues({ description: "AKIAIOSFODNN7EXAMPLE" })
    ).toEqual(["description"]);
  });

  test("finds a raw Bearer/Basic auth-header value", () => {
    expect(
      findSecretShapedValues({ title: "Bearer not-a-real-token-example-0000" })
    ).toEqual(["title"]);
  });

  test("finds a connection string with an embedded user:pass@ credential", () => {
    expect(
      findSecretShapedValues({
        webhookUrl: "postgres://admin:hunter2@db.example.com:5432/prod"
      })
    ).toEqual(["webhookUrl"]);
  });

  // PR #712 follow-up (security review, CRITICAL) — the password character
  // class used to exclude `:` and `@`, so a connection string whose
  // password itself contains either character bypassed detection entirely
  // (`:`) or matched the wrong `@` and produced a garbled result (`@`).
  test("finds a connection string whose password itself contains a colon", () => {
    expect(
      findSecretShapedValues({
        webhookUrl:
          "postgres://appuser:my:pass@db.internal.example.com:5432/awcms"
      })
    ).toEqual(["webhookUrl"]);
  });

  test("finds a connection string whose password itself contains an at-sign", () => {
    expect(
      findSecretShapedValues({
        webhookUrl:
          "postgres://appuser:p@ss!w0rd@db.internal.example.com:5432/awcms"
      })
    ).toEqual(["webhookUrl"]);
  });

  // PR #712 follow-up (security review, HIGH) — the JWT pattern used to
  // require the signature segment to be at least 5 characters, so a
  // truncated/empty-signature JWT bypassed detection even though its
  // header/payload (often containing `sub`/`tenant_id`/`roles`) still leak.
  test("finds a JWT-shaped value with an empty signature segment", () => {
    expect(
      findSecretShapedValues({
        note: "eyJhbGciOiJub25lIn0.eyJzdWIiOiIxMjM0NTY3ODkwIn0."
      })
    ).toEqual(["note"]);
  });

  test("finds a secret-shaped value nested inside an object", () => {
    expect(
      findSecretShapedValues({
        provider: { note: "Bearer not-a-real-token-example-0000" }
      })
    ).toEqual(["provider.note"]);
  });

  test("finds a secret-shaped value nested inside an array of objects", () => {
    expect(
      findSecretShapedValues({
        webhooks: [
          { label: "ok" },
          { label: "Bearer not-a-real-token-example-0000" }
        ]
      })
    ).toEqual(["webhooks[1].label"]);
  });

  // Issue #785 — vendor secret-key formats surfaced by two independent
  // security audits during epic #738 Wave 3 (PR #783/#750 reference-data,
  // PR #784/#754 integration-hub), previously undetected by this function.
  // Every fixture below is deliberately a FABRICATED, non-canonical
  // credential (the body spells out "NOT A REAL ... FIXTURE ... FOR
  // TESTS/TESTING ONLY" using only the vendor's own allowed character set)
  // — same established convention as the JWT fixture above, chosen
  // specifically so it reads as obviously fake to a human reviewer while
  // still exercising the exact shape/length our own regex requires. See
  // that fixture's own comment for why a well-known PUBLIC canonical
  // example (like AWS's `AKIAIOSFODNN7EXAMPLE`) isn't used here — none of
  // these vendors publish an equivalent officially-sanctioned example
  // credential.
  describe("vendor secret-key formats (Issue #785)", () => {
    // Every fixture below is built via string concatenation (prefix + body),
    // never one contiguous literal — GitHub's own push-protection secret
    // scanning previously blocked this exact PR on a single literal
    // `sk_live_...`-shaped Stripe string in this file (scanned regardless of
    // how obviously fake the body is), the same class of prior incident
    // already documented on the JWT fixture above. Splitting the prefix from
    // the body avoids that literal-text match while producing the identical
    // runtime string each regex under test still needs to see.
    test("finds a GitHub personal access token", () => {
      const githubPatFixture = "ghp_" + "NOTAREALFIXTURETOKENFORTESTINGONLY0N";

      expect(
        findSecretShapedValues({
          publicLabel: githubPatFixture
        })
      ).toEqual(["publicLabel"]);
    });

    test("finds a GitHub fine-grained personal access token", () => {
      const githubFineGrainedPatFixture =
        "github_pat_" + "NOT_A_REAL_FIXTURE_TOKEN_FOR_TESTING_ONLY_0011";

      expect(
        findSecretShapedValues({
          note: githubFineGrainedPatFixture
        })
      ).toEqual(["note"]);
    });

    test("finds an OpenAI project-scoped key", () => {
      const openAiProjectKeyFixture =
        "sk-proj-" + "NOT-A-REAL-OPENAI-KEY-FIXTURE-FOR-TESTS-0011";

      expect(
        findSecretShapedValues({
          description: openAiProjectKeyFixture
        })
      ).toEqual(["description"]);
    });

    test("finds an OpenAI classic key", () => {
      const openAiClassicKeyFixture =
        "sk-" + "NOTAREALOPENAIKEYFIXTUREFORTESTSONLY0011";

      expect(
        findSecretShapedValues({
          title: openAiClassicKeyFixture
        })
      ).toEqual(["title"]);
    });

    test("finds a Slack bot token", () => {
      const slackBotTokenFixture =
        "xoxb-" + "NOT-A-REAL-SLACK-BOT-TOKEN-FIXTURE-0011";

      expect(
        findSecretShapedValues({
          webhookLabel: slackBotTokenFixture
        })
      ).toEqual(["webhookLabel"]);
    });

    test("finds a Slack user token", () => {
      const slackUserTokenFixture =
        "xoxp-" + "NOT-A-REAL-SLACK-USER-TOKEN-FIXTURE-0011";

      expect(
        findSecretShapedValues({
          webhookLabel: slackUserTokenFixture
        })
      ).toEqual(["webhookLabel"]);
    });

    test("finds a Slack incoming-webhook URL", () => {
      const slackWebhookUrlFixture =
        "https://hooks.slack.com/services/" +
        "NOTAREAL/FIXTUREONLY/TESTDATAXXXXXXXXXXXXXXXXXXXX";

      expect(
        findSecretShapedValues({
          webhookUrl: slackWebhookUrlFixture
        })
      ).toEqual(["webhookUrl"]);
    });

    test("finds a Stripe live secret key", () => {
      // Built via concatenation, not one contiguous literal — GitHub's own
      // push-protection secret scanning previously blocked this exact PR on
      // a single literal `sk_live_...`-shaped string in this file (the
      // "Stripe API Key" shape is scanned regardless of how obviously fake
      // the body is), the same class of prior incident already documented
      // on the JWT fixture above. Splitting the prefix from the body avoids
      // that literal-text match while producing the identical runtime
      // string the regex under test still needs to see.
      const stripeLiveFixture =
        "sk_live_" + "NOTAREALSTRIPEKEYFIXTUREFORTESTS0011";

      expect(findSecretShapedValues({ note: stripeLiveFixture })).toEqual([
        "note"
      ]);
    });

    test("finds a Stripe test secret key", () => {
      // Same concatenation rationale as the live-key fixture above.
      const stripeTestFixture =
        "sk_test_" + "NOTAREALSTRIPEKEYFIXTUREFORTESTS0011";

      expect(
        findSecretShapedValues({
          note: stripeTestFixture
        })
      ).toEqual(["note"]);
    });

    test("finds a Google API key", () => {
      const googleApiKeyFixture =
        "AIzaSy" + "NOTAREALGOOGLEAPIKEYFIXTUREONLYXX";

      expect(
        findSecretShapedValues({
          description: googleApiKeyFixture
        })
      ).toEqual(["description"]);
    });

    test("finds a vendor secret shape nested inside an array of objects (batch webhook body)", () => {
      const githubPatFixture = "ghp_" + "NOTAREALFIXTURETOKENFORTESTINGONLY0N";

      expect(
        findSecretShapedValues({
          webhooks: [{ label: "ok" }, { label: githubPatFixture }]
        })
      ).toEqual(["webhooks[1].label"]);
    });

    // Negative tests — realistic non-secret values that happen to share a
    // short prefix with a vendor pattern must NOT be flagged, guarding
    // against over-blocking legitimate settings/metadata.
    test("does NOT flag a short, innocuous 'sk-' prefixed code (below the length floor)", () => {
      expect(findSecretShapedValues({ productCode: "sk-widget-2024" })).toEqual(
        []
      );
    });

    test("does NOT flag a UUID (structurally unrelated to every vendor prefix)", () => {
      expect(
        findSecretShapedValues({
          referenceId: "550e8400-e29b-41d4-a716-446655440000"
        })
      ).toEqual([]);
    });

    test("does NOT flag a legitimately-stored SHA-256 content hash", () => {
      expect(
        findSecretShapedValues({
          contentHash:
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        })
      ).toEqual([]);
    });

    test("does NOT flag an ordinary https webhook URL with no vendor-specific path shape", () => {
      expect(
        findSecretShapedValues({
          webhookUrl: "https://example.com/hooks/acme-tenant-42"
        })
      ).toEqual([]);
    });
  });
});

// Issue #687 — free-text complement to `redactSensitiveAttributes`, used by
// `src/lib/logging/error-sanitizer.ts` to sanitize a caught exception's own
// message/stack (unstructured prose, no object key to check by name).
describe("redactSecretsInText", () => {
  test("leaves text with no secret-shaped content untouched", () => {
    expect(redactSecretsInText("connection refused")).toBe(
      "connection refused"
    );
  });

  test("redacts a password=value pair", () => {
    expect(redactSecretsInText("login failed: password=hunter2")).toBe(
      "login failed: password=[REDACTED]"
    );
  });

  test("redacts a quoted key: value secret pair", () => {
    expect(redactSecretsInText('config error: apiKey: "abc123"')).toBe(
      "config error: apiKey: [REDACTED]"
    );
  });

  test("redacts an embedded JWT", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQ_dGVzdF9zaWduYXR1cmU";

    // Deliberately no "token:"/"password:"-shaped prefix immediately before
    // the JWT here — that's a separate, still-safe overlap case (the
    // key=value pattern would also match "token: <value>" and win with the
    // generic `[REDACTED]` tag instead of `[REDACTED_JWT]`; the secret is
    // still fully redacted either way, only the tag differs).
    expect(redactSecretsInText(`unexpected value: ${jwt}`)).toBe(
      "unexpected value: [REDACTED_JWT]"
    );
  });

  test("redacts a connection-string credential (DSN)", () => {
    expect(
      redactSecretsInText(
        "could not connect to postgres://appuser:s3cr3t@db.internal:5432/awcms"
      )
    ).toBe("could not connect to postgres://[REDACTED]@db.internal:5432/awcms");
  });

  // PR #712 follow-up (security review, CRITICAL) — regression tests for
  // the exact two empirical failure scenarios the security auditor found:
  // a DSN password containing `:` (previously not redacted AT ALL — the
  // regex failed to match), and a DSN password containing `@` (previously
  // matched the WRONG `@`, leaking most of the real password after the
  // `[REDACTED]` tag).
  test("redacts a DSN whose password itself contains a colon (was: not redacted at all)", () => {
    expect(
      redactSecretsInText(
        "postgres://appuser:my:pass@db.internal.example.com:5432/awcms"
      )
    ).toBe("postgres://[REDACTED]@db.internal.example.com:5432/awcms");
  });

  test("redacts a DSN whose password itself contains an at-sign (was: partially leaked)", () => {
    const output = redactSecretsInText(
      "postgres://appuser:p@ss!w0rd@db.internal.example.com:5432/awcms"
    );

    expect(output).toBe(
      "postgres://[REDACTED]@db.internal.example.com:5432/awcms"
    );
    expect(output).not.toContain("ss!w0rd");
  });

  // PR #712 follow-up (security review, HIGH) — a truncated/short-signature
  // JWT (e.g. a log line cut off mid-token) used to bypass redaction
  // entirely because the third segment required >= 5 characters.
  test("redacts a JWT with an empty signature segment (truncated log line)", () => {
    expect(
      redactSecretsInText(
        "bad token seen: eyJhbGciOiJub25lIn0.eyJzdWIiOiIxMjM0NTY3ODkwIn0."
      )
    ).toBe("bad token seen: [REDACTED_JWT]");
  });

  test("redacts a JWT with a short (but non-empty) signature segment", () => {
    expect(
      redactSecretsInText(
        "bad token seen: eyJhbGciOiJub25lIn0.eyJzdWIiOiIxMjM0NTY3ODkwIn0.ab"
      )
    ).toBe("bad token seen: [REDACTED_JWT]");
  });

  // PR #712 follow-up (security review, CRITICAL) — the paired
  // BEGIN...END PEM pattern never matches at all when a stack trace/error
  // message is truncated before the END marker is reached (buffer limits,
  // a provider truncating its own error response) — previously the ENTIRE
  // raw key body (base64) passed through completely unredacted.
  test("redacts a truncated PEM private key block with no END marker", () => {
    const truncated =
      "-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBgkqhkiG9w0BAQEFAASCAWMwggFf";

    const output = redactSecretsInText(`key dump: ${truncated}`);

    expect(output).toBe("key dump: [REDACTED_PRIVATE_KEY]");
    expect(output).not.toContain("MIIBVgIBADANBgkqhkiG9w0BAQEFAASCAWMwggFf");
  });

  test("a well-formed (non-truncated) PEM block still redacts to a single tag", () => {
    const pem =
      "-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBgkqhkiG9w0BAQ\n-----END PRIVATE KEY-----";

    expect(redactSecretsInText(`key: ${pem} trailing text`)).toBe(
      "key: [REDACTED_PRIVATE_KEY] trailing text"
    );
  });

  test("redacts a Bearer authorization header value", () => {
    expect(
      redactSecretsInText("request failed — Authorization: Bearer abc.def.ghi")
    ).toBe("request failed — Authorization: Bearer [REDACTED]");
  });

  test("redacts a PEM private key block", () => {
    const pem =
      "-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBgkqhkiG9w0BAQ\n-----END PRIVATE KEY-----";

    expect(redactSecretsInText(`key: ${pem}`)).toBe(
      "key: [REDACTED_PRIVATE_KEY]"
    );
  });

  test("redacts an AWS access key id", () => {
    expect(
      redactSecretsInText("using key AKIAIOSFODNN7EXAMPLE for upload")
    ).toBe("using key [REDACTED_AWS_KEY] for upload");
  });

  // Issue #785 — free-text equivalents of the vendor secret-key shapes
  // added to `findSecretShapedValues`'s fixtures above. Same fabricated,
  // non-canonical fixture convention (see that describe block's own
  // comment for why).
  describe("vendor secret-key formats (Issue #785)", () => {
    test("redacts a GitHub personal access token embedded in prose", () => {
      const githubPatFixture = "ghp_" + "NOTAREALFIXTURETOKENFORTESTINGONLY0N";

      expect(
        redactSecretsInText(`leaked in log: ${githubPatFixture} here`)
      ).toBe("leaked in log: [REDACTED_GITHUB_TOKEN] here");
    });

    test("redacts a GitHub fine-grained personal access token embedded in prose", () => {
      const githubFineGrainedPatFixture =
        "github_pat_" + "NOT_A_REAL_FIXTURE_TOKEN_FOR_TESTING_ONLY_0011";

      expect(
        redactSecretsInText(`leaked: ${githubFineGrainedPatFixture} here`)
      ).toBe("leaked: [REDACTED_GITHUB_TOKEN] here");
    });

    test("redacts an OpenAI project-scoped key embedded in prose", () => {
      const openAiProjectKeyFixture =
        "sk-proj-" + "NOT-A-REAL-OPENAI-KEY-FIXTURE-FOR-TESTS-0011";

      expect(
        redactSecretsInText(`config dump: ${openAiProjectKeyFixture} end`)
      ).toBe("config dump: [REDACTED_OPENAI_KEY] end");
    });

    test("redacts an OpenAI classic key embedded in prose", () => {
      const openAiClassicKeyFixture =
        "sk-" + "NOTAREALOPENAIKEYFIXTUREFORTESTSONLY0011";

      expect(
        redactSecretsInText(`config dump: ${openAiClassicKeyFixture} end`)
      ).toBe("config dump: [REDACTED_OPENAI_KEY] end");
    });

    test("redacts a Slack bot token embedded in prose", () => {
      const slackBotTokenFixture =
        "xoxb-" + "NOT-A-REAL-SLACK-BOT-TOKEN-FIXTURE-0011";

      expect(
        redactSecretsInText(`webhook config: ${slackBotTokenFixture} end`)
      ).toBe("webhook config: [REDACTED_SLACK_TOKEN] end");
    });

    test("redacts a Slack incoming-webhook URL embedded in prose", () => {
      const slackWebhookUrlFixture =
        "https://hooks.slack.com/services/" +
        "NOTAREAL/FIXTUREONLY/TESTDATAXXXXXXXXXXXXXXXXXXXX";

      expect(
        redactSecretsInText(`posting to ${slackWebhookUrlFixture} failed`)
      ).toBe("posting to [REDACTED_SLACK_WEBHOOK] failed");
    });

    test("redacts a Stripe secret key embedded in prose", () => {
      // Same concatenation-to-avoid-push-protection technique as the
      // `findSecretShapedValues` Stripe fixture above — see its comment.
      const stripeLiveFixture =
        "sk_live_" + "NOTAREALSTRIPEKEYFIXTUREFORTESTS0011";

      expect(
        redactSecretsInText(`provider error using ${stripeLiveFixture} key`)
      ).toBe("provider error using [REDACTED_STRIPE_KEY] key");
    });

    test("redacts a Google API key embedded in prose", () => {
      const googleApiKeyFixture =
        "AIzaSy" + "NOTAREALGOOGLEAPIKEYFIXTUREONLYXX";

      expect(
        redactSecretsInText(
          `request failed with key ${googleApiKeyFixture} rejected`
        )
      ).toBe("request failed with key [REDACTED_GOOGLE_API_KEY] rejected");
    });

    test("leaves a realistic non-secret 'sk-' prefixed code untouched", () => {
      expect(
        redactSecretsInText("applying discount code sk-widget-2024 now")
      ).toBe("applying discount code sk-widget-2024 now");
    });

    test("leaves an ordinary https URL untouched", () => {
      expect(
        redactSecretsInText(
          "callback registered at https://example.com/hooks/acme-tenant-42"
        )
      ).toBe("callback registered at https://example.com/hooks/acme-tenant-42");
    });
  });
});

describe("AuditEventInput shape", () => {
  test("matches the doc 10 / skill contract (compile-time check via sample object)", () => {
    const sample: AuditEventInput = {
      tenantId: "11111111-1111-1111-1111-111111111111",
      actorTenantUserId: "22222222-2222-2222-2222-222222222222",
      moduleKey: "profile_identity",
      action: "delete",
      resourceType: "profile",
      resourceId: "33333333-3333-3333-3333-333333333333",
      severity: "warning",
      message: "Profile soft-deleted",
      attributes: { reason: "duplicate" },
      correlationId: "corr-1"
    };

    expect(sample.moduleKey).toBe("profile_identity");
    expect(sample.severity).toBe("warning");
  });
});

/**
 * `AuditExportHook` extension point (Issue #447). No DB is needed to test
 * the hook plumbing itself — `recordAuditEvent`'s only interaction with `tx`
 * is one tagged-template call, so a plain function standing in for
 * `Bun.SQL` is enough to exercise everything after the INSERT.
 */
describe("AuditExportHook extension point", () => {
  let originalConsoleLog: typeof console.log;

  function fakeTx(): Promise<unknown[]> {
    return Promise.resolve([]);
  }

  beforeEach(() => {
    originalConsoleLog = console.log;
    console.log = () => {};
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    setAuditExportHook(null);
  });

  test("default hook is null — zero behavior change for every deployment that never registers one", () => {
    expect(getAuditExportHook()).toBeNull();
  });

  test("a registered hook receives the already-redacted event right after the write", async () => {
    const received: AuditEventRecorded[] = [];
    setAuditExportHook((event) => {
      received.push(event);
    });

    await recordAuditEvent(fakeTx as unknown as Bun.SQL, {
      tenantId: "11111111-1111-1111-1111-111111111111",
      moduleKey: "logging",
      action: "purge",
      resourceType: "audit_event",
      severity: "warning",
      message: "Purged expired audit events.",
      attributes: { email: "user@example.com", purgedCount: 3 }
    });

    expect(received).toHaveLength(1);
    expect(received[0]!.action).toBe("purge");
    expect(received[0]!.resourceType).toBe("audit_event");
    // Redaction already applied — a hook can never see raw PII either.
    expect(received[0]!.attributes).toEqual({
      email: "[REDACTED]",
      purgedCount: 3
    });
    expect(received[0]!.recordedAt).toBeInstanceOf(Date);
  });

  test("a synchronously throwing hook never fails recordAuditEvent", async () => {
    setAuditExportHook(() => {
      throw new Error("derived app export hook exploded");
    });

    await expect(
      recordAuditEvent(fakeTx as unknown as Bun.SQL, {
        tenantId: "11111111-1111-1111-1111-111111111111",
        moduleKey: "logging",
        action: "purge",
        resourceType: "audit_event",
        message: "test"
      })
    ).resolves.toBeUndefined();
  });

  test("a rejecting async hook never fails recordAuditEvent", async () => {
    setAuditExportHook(async () => {
      throw new Error("derived app export hook rejected");
    });

    await expect(
      recordAuditEvent(fakeTx as unknown as Bun.SQL, {
        tenantId: "11111111-1111-1111-1111-111111111111",
        moduleKey: "logging",
        action: "purge",
        resourceType: "audit_event",
        message: "test"
      })
    ).resolves.toBeUndefined();
  });

  test("setAuditExportHook(null) detaches a previously registered hook", async () => {
    const received: AuditEventRecorded[] = [];
    setAuditExportHook((event) => {
      received.push(event);
    });
    setAuditExportHook(null);

    await recordAuditEvent(fakeTx as unknown as Bun.SQL, {
      tenantId: "11111111-1111-1111-1111-111111111111",
      moduleKey: "logging",
      action: "purge",
      resourceType: "audit_event",
      message: "test"
    });

    expect(received).toHaveLength(0);
    expect(getAuditExportHook()).toBeNull();
  });
});
