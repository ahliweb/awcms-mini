import { describe, expect, test } from "bun:test";

import {
  evaluateBreakGlassRequirement,
  isAutoLinkAllowedForProvider,
  validateCreateAuthProviderInput,
  validateUpdateAuthProviderInput,
  validateUpdateTenantAuthPolicyInput
} from "../../src/modules/identity-access/domain/tenant-sso-policy";

describe("evaluateBreakGlassRequirement (Issue #591)", () => {
  test("ok when neither restrictive setting is requested, even with zero break-glass identities", () => {
    const result = evaluateBreakGlassRequirement({
      passwordLoginEnabled: true,
      ssoRequired: false,
      breakGlassIdentityIds: [],
      eligibleBreakGlassCount: 0
    });
    expect(result.outcome).toBe("ok");
  });

  test("invalid when sso_required=true and there is no eligible break-glass identity", () => {
    const result = evaluateBreakGlassRequirement({
      passwordLoginEnabled: true,
      ssoRequired: true,
      breakGlassIdentityIds: [],
      eligibleBreakGlassCount: 0
    });
    expect(result).toEqual({
      outcome: "invalid",
      reason: "break_glass_required"
    });
  });

  test("invalid when password_login_enabled=false and there is no eligible break-glass identity", () => {
    const result = evaluateBreakGlassRequirement({
      passwordLoginEnabled: false,
      ssoRequired: false,
      breakGlassIdentityIds: ["identity-1"],
      eligibleBreakGlassCount: 0
    });
    expect(result.outcome).toBe("invalid");
  });

  test("ok when sso_required=true and at least one break-glass identity is eligible", () => {
    const result = evaluateBreakGlassRequirement({
      passwordLoginEnabled: true,
      ssoRequired: true,
      breakGlassIdentityIds: ["identity-1"],
      eligibleBreakGlassCount: 1
    });
    expect(result.outcome).toBe("ok");
  });

  test("invalid even with listed break-glass ids if none of them are currently eligible (stale/deactivated identity)", () => {
    const result = evaluateBreakGlassRequirement({
      passwordLoginEnabled: false,
      ssoRequired: true,
      breakGlassIdentityIds: ["identity-1", "identity-2"],
      eligibleBreakGlassCount: 0
    });
    expect(result.outcome).toBe("invalid");
  });
});

describe("isAutoLinkAllowedForProvider (Issue #591)", () => {
  test("false when the tenant policy master switch is off, regardless of domain match", () => {
    expect(
      isAutoLinkAllowedForProvider(false, true, true, [], "example.com")
    ).toBe(false);
  });

  test("false when email is not verified", () => {
    expect(
      isAutoLinkAllowedForProvider(true, false, true, [], "example.com")
    ).toBe(false);
  });

  test("false when the provider's own domain list does not allow this domain (fail closed)", () => {
    expect(
      isAutoLinkAllowedForProvider(true, true, false, [], "example.com")
    ).toBe(false);
  });

  test("true when master switch on, email verified, provider domain allowed, and tenant policy list is empty (no extra restriction)", () => {
    expect(
      isAutoLinkAllowedForProvider(true, true, true, [], "example.com")
    ).toBe(true);
  });

  test("false when the tenant policy list is non-empty and does not include this domain (defense in depth)", () => {
    expect(
      isAutoLinkAllowedForProvider(
        true,
        true,
        true,
        ["other.example"],
        "example.com"
      )
    ).toBe(false);
  });

  test("true when the tenant policy list is non-empty and includes this domain", () => {
    expect(
      isAutoLinkAllowedForProvider(
        true,
        true,
        true,
        ["example.com"],
        "example.com"
      )
    ).toBe(true);
  });

  test("false when domain could not be extracted from the email", () => {
    expect(isAutoLinkAllowedForProvider(true, true, true, [], null)).toBe(
      false
    );
  });
});

describe("validateCreateAuthProviderInput (Issue #591)", () => {
  const validBody = {
    providerKey: "okta",
    displayName: "Okta",
    issuerUrl: "https://example.okta.com",
    clientId: "client-123",
    clientSecret: "super-secret"
  };

  test("accepts a well-formed body with clientSecret", () => {
    const result = validateCreateAuthProviderInput(validBody);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.providerKey).toBe("okta");
      expect(result.value.clientSecretEnvVar).toBeNull();
    }
  });

  test("accepts a well-formed body with clientSecretEnvVar instead", () => {
    const result = validateCreateAuthProviderInput({
      ...validBody,
      clientSecret: undefined,
      clientSecretEnvVar: "OKTA_CLIENT_SECRET"
    });
    expect(result.valid).toBe(true);
  });

  test("rejects a body with neither clientSecret nor clientSecretEnvVar", () => {
    const result = validateCreateAuthProviderInput({
      ...validBody,
      clientSecret: undefined
    });
    expect(result.valid).toBe(false);
  });

  test("rejects a body with BOTH clientSecret and clientSecretEnvVar", () => {
    const result = validateCreateAuthProviderInput({
      ...validBody,
      clientSecretEnvVar: "OKTA_CLIENT_SECRET"
    });
    expect(result.valid).toBe(false);
  });

  test("rejects an invalid providerKey", () => {
    const result = validateCreateAuthProviderInput({
      ...validBody,
      providerKey: "Not Valid!"
    });
    expect(result.valid).toBe(false);
  });

  test("rejects a non-https issuerUrl", () => {
    const result = validateCreateAuthProviderInput({
      ...validBody,
      issuerUrl: "http://example.okta.com"
    });
    expect(result.valid).toBe(false);
  });

  test("rejects a missing displayName", () => {
    const result = validateCreateAuthProviderInput({
      ...validBody,
      displayName: ""
    });
    expect(result.valid).toBe(false);
  });

  test("defaults scopes and allowedEmailDomains when omitted", () => {
    const result = validateCreateAuthProviderInput(validBody);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.scopes).toBe("openid email profile");
      expect(result.value.allowedEmailDomains).toEqual([]);
    }
  });
});

describe("validateUpdateAuthProviderInput (Issue #591)", () => {
  test("accepts an empty body (no-op partial update)", () => {
    expect(validateUpdateAuthProviderInput({}).valid).toBe(true);
  });

  test("rejects setting BOTH clientSecret and clientSecretEnvVar in one update", () => {
    const result = validateUpdateAuthProviderInput({
      clientSecret: "a",
      clientSecretEnvVar: "B"
    });
    expect(result.valid).toBe(false);
  });

  test("accepts updating only enabled", () => {
    const result = validateUpdateAuthProviderInput({ enabled: true });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.enabled).toBe(true);
    }
  });
});

describe("validateUpdateTenantAuthPolicyInput (Issue #591)", () => {
  test("accepts an empty body", () => {
    expect(validateUpdateTenantAuthPolicyInput({}).valid).toBe(true);
  });

  test("rejects a non-boolean ssoRequired", () => {
    const result = validateUpdateTenantAuthPolicyInput({ ssoRequired: "yes" });
    expect(result.valid).toBe(false);
  });

  test("rejects a malformed breakGlassIdentityIds entry", () => {
    const result = validateUpdateTenantAuthPolicyInput({
      breakGlassIdentityIds: ["not-a-uuid"]
    });
    expect(result.valid).toBe(false);
  });

  test("de-duplicates breakGlassIdentityIds", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    const result = validateUpdateTenantAuthPolicyInput({
      breakGlassIdentityIds: [id, id]
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.breakGlassIdentityIds).toEqual([id]);
    }
  });
});
