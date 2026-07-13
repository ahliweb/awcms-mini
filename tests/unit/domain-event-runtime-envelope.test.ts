import { describe, expect, test } from "bun:test";

import {
  DOMAIN_EVENT_PAYLOAD_MAX_BYTES,
  deriveOrderKey,
  isValidEventType,
  isValidEventVersion,
  validateDomainEventPayload
} from "../../src/modules/domain-event-runtime/domain/envelope";

describe("validateDomainEventPayload (Issue #742)", () => {
  test("accepts a small, plain-object payload", () => {
    const result = validateDomainEventPayload({ title: "hello", count: 3 });
    expect(result.valid).toBe(true);
  });

  test("rejects a non-object payload", () => {
    expect(validateDomainEventPayload("a string").valid).toBe(false);
    expect(validateDomainEventPayload(42).valid).toBe(false);
    expect(validateDomainEventPayload(null).valid).toBe(false);
    expect(validateDomainEventPayload(["array"]).valid).toBe(false);
  });

  test("rejects a payload over the byte-size limit", () => {
    const result = validateDomainEventPayload({
      blob: "x".repeat(DOMAIN_EVENT_PAYLOAD_MAX_BYTES + 1)
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((error) => error.includes("exceeds"))).toBe(
        true
      );
    }
  });

  test("rejects a payload with a credential-shaped key name", () => {
    const result = validateDomainEventPayload({
      title: "hello",
      password: "hunter2"
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((error) => error.includes("password"))).toBe(
        true
      );
    }
  });

  test("rejects a payload with a credential-shaped key nested inside another object", () => {
    const result = validateDomainEventPayload({
      account: { apiKey: "abc123" }
    });
    expect(result.valid).toBe(false);
  });

  test("rejects a payload with a secret-shaped value regardless of key name", () => {
    const result = validateDomainEventPayload({
      // AWS's own canonical public documentation example access key id —
      // same fixture `tests/audit-log.test.ts` already uses for this exact
      // purpose. Deliberately NOT a JWT-shaped fixture: even an obviously-
      // joke JWT payload is still a structurally well-formed JSON Web
      // Token and gets flagged by GitGuardian's JWT detector regardless of
      // its decoded content being nonsense (confirmed empirically on this
      // PR — a JWT-shaped fixture here, even reusing the exact "fake
      // signature" convention two other already-merged test files use,
      // still tripped the check).
      publicLabel: "AKIAIOSFODNN7EXAMPLE"
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((error) => error.includes("publicLabel"))).toBe(
        true
      );
    }
  });

  test("rejects a payload with a Bearer-token-shaped value", () => {
    // Same obviously-fake fixture string `tests/audit-log.test.ts` already
    // established for this exact purpose (avoids a more plausible-looking
    // fabricated token being flagged as a genuine leaked secret).
    const result = validateDomainEventPayload({
      note: "Bearer not-a-real-token-example-0000"
    });
    expect(result.valid).toBe(false);
  });

  test("accepts ordinary business data that merely mentions an email address value (not key-name-flagged as a credential)", () => {
    // `findSensitiveKeys`/`findSecretShapedValues` target credential SHAPES
    // (password/token/JWT/PEM/etc), not ordinary PII shapes like an email
    // address — that is `payload-redaction.ts`'s read-time masking
    // responsibility (defense in depth for display), not a write-time
    // rejection here (a legitimate consumer may need the real address).
    const result = validateDomainEventPayload({
      customerEmail: "customer@example.com"
    });
    expect(result.valid).toBe(true);
  });
});

describe("isValidEventType / isValidEventVersion (Issue #742)", () => {
  test("accepts a well-formed namespace.aggregate.action event type", () => {
    expect(
      isValidEventType("awcms-mini.domain-event-runtime.sample.recorded")
    ).toBe(true);
  });

  test("rejects an event type without at least one dot-separated segment", () => {
    expect(isValidEventType("notanamespacedtype")).toBe(false);
  });

  test("rejects an event type with uppercase characters", () => {
    expect(isValidEventType("AWCMS.Sample.Recorded")).toBe(false);
  });

  test("accepts a well-formed X.Y version", () => {
    expect(isValidEventVersion("1.0")).toBe(true);
    expect(isValidEventVersion("2.13")).toBe(true);
  });

  test("rejects a malformed version", () => {
    expect(isValidEventVersion("1")).toBe(false);
    expect(isValidEventVersion("v1.0")).toBe(false);
    expect(isValidEventVersion("1.0.0")).toBe(false);
  });
});

describe("deriveOrderKey (Issue #742)", () => {
  test("combines aggregate type and id with a colon", () => {
    expect(deriveOrderKey("domain_event_sample", "abc-123")).toBe(
      "domain_event_sample:abc-123"
    );
  });

  test("is deterministic for the same inputs", () => {
    const a = deriveOrderKey("x", "y");
    const b = deriveOrderKey("x", "y");
    expect(a).toBe(b);
  });

  test("differs for different aggregate ids (independent ordering lanes)", () => {
    expect(deriveOrderKey("x", "1")).not.toBe(deriveOrderKey("x", "2"));
  });
});
