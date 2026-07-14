/**
 * Issue #754 (integration_hub) follow-up — security-auditor Medium finding
 * (PR #784): `secret_reference` must not be able to point at an unrelated
 * process-wide env var (confused-deputy equality oracle).
 */
import { describe, expect, test } from "bun:test";
import {
  assertValidSecretReferenceNaming,
  InvalidSecretReferenceError,
  validateSecretReferenceNaming
} from "../../src/modules/integration-hub/domain/secret-reference-validation";

describe("validateSecretReferenceNaming", () => {
  test("accepts a reference whose env var name starts with the required prefix", () => {
    expect(
      validateSecretReferenceNaming("env:INTEGRATION_HUB_WEBHOOK_SECRET").ok
    ).toBe(true);
  });

  test("accepts a case-insensitive match on the prefix", () => {
    expect(
      validateSecretReferenceNaming("env:integration_hub_webhook_secret").ok
    ).toBe(true);
  });

  test("ADVERSARIAL: rejects a reference to an unrelated process-wide secret (confused-deputy oracle)", () => {
    const result = validateSecretReferenceNaming("env:DATABASE_URL");
    expect(result.ok).toBe(false);
  });

  test("rejects a reference to another module's provider secret", () => {
    const result = validateSecretReferenceNaming("env:MAILKETING_API_KEY");
    expect(result.ok).toBe(false);
  });

  test("rejects a reference that merely CONTAINS the prefix but doesn't start with it", () => {
    const result = validateSecretReferenceNaming(
      "env:SOME_OTHER_INTEGRATION_HUB_SECRET"
    );
    expect(result.ok).toBe(false);
  });

  test("rejects a non env: reference", () => {
    expect(validateSecretReferenceNaming("secretsmanager:foo").ok).toBe(false);
  });

  test("rejects a malformed reference", () => {
    expect(validateSecretReferenceNaming("not-a-reference").ok).toBe(false);
  });
});

describe("assertValidSecretReferenceNaming", () => {
  test("does not throw for a valid reference", () => {
    expect(() =>
      assertValidSecretReferenceNaming("env:INTEGRATION_HUB_SECRET")
    ).not.toThrow();
  });

  test("throws InvalidSecretReferenceError for an unrelated env var", () => {
    let caught: unknown;

    try {
      assertValidSecretReferenceNaming("env:DATABASE_URL");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InvalidSecretReferenceError);
  });
});
