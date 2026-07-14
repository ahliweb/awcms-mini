import { describe, expect, test } from "bun:test";

import {
  findMissingOrInvalidLinkedInConfig,
  isLinkedInProviderEnabled,
  isSupportedLinkedInOrganizationRole,
  isValidLinkedInApiVersion,
  resolveLinkedInApiVersion,
  resolveLinkedInRequiredScopes,
  resolveLinkedInSecretReference
} from "../../src/modules/social-publishing/domain/linkedin-provider-config";

const FULL_ENV = {
  LINKEDIN_PROVIDER_ENABLED: "true",
  LINKEDIN_CLIENT_ID: "client-abc",
  LINKEDIN_CLIENT_SECRET_REFERENCE: "env:LINKEDIN_CLIENT_SECRET_ACTUAL",
  LINKEDIN_API_VERSION: "202506",
  LINKEDIN_OAUTH_REDIRECT_URI: "https://app.example.com/callback",
  LINKEDIN_REQUIRED_SCOPES:
    "w_organization_social,r_organization_social,rw_organization_admin"
} as NodeJS.ProcessEnv;

describe("isLinkedInProviderEnabled (Issue #645)", () => {
  test("false when unset", () => {
    expect(isLinkedInProviderEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  test('true only for exact string "true"', () => {
    expect(
      isLinkedInProviderEnabled({
        LINKEDIN_PROVIDER_ENABLED: "true"
      } as NodeJS.ProcessEnv)
    ).toBe(true);
    expect(
      isLinkedInProviderEnabled({
        LINKEDIN_PROVIDER_ENABLED: "yes"
      } as NodeJS.ProcessEnv)
    ).toBe(false);
  });
});

describe("isValidLinkedInApiVersion (Issue #645)", () => {
  test("accepts YYYYMM", () => {
    expect(isValidLinkedInApiVersion("202506")).toBe(true);
  });

  test("rejects malformed values", () => {
    expect(isValidLinkedInApiVersion("2025-06")).toBe(false);
    expect(isValidLinkedInApiVersion("v2")).toBe(false);
    expect(isValidLinkedInApiVersion("")).toBe(false);
  });
});

describe("resolveLinkedInApiVersion (Issue #645)", () => {
  test("trims the configured value", () => {
    expect(
      resolveLinkedInApiVersion({
        LINKEDIN_API_VERSION: " 202506 "
      } as NodeJS.ProcessEnv)
    ).toBe("202506");
  });

  test('empty string when unset (never "undefined")', () => {
    expect(resolveLinkedInApiVersion({} as NodeJS.ProcessEnv)).toBe("");
  });
});

describe("resolveLinkedInRequiredScopes (Issue #645)", () => {
  test("parses a comma-separated list, trims, drops empties", () => {
    expect(
      resolveLinkedInRequiredScopes({
        LINKEDIN_REQUIRED_SCOPES:
          " w_organization_social ,,r_organization_social"
      } as NodeJS.ProcessEnv)
    ).toEqual(["w_organization_social", "r_organization_social"]);
  });

  test("empty when unset (fail-closed — no scope is ever satisfied)", () => {
    expect(resolveLinkedInRequiredScopes({} as NodeJS.ProcessEnv)).toEqual([]);
  });
});

describe("findMissingOrInvalidLinkedInConfig (Issue #645)", () => {
  test('empty when LINKEDIN_PROVIDER_ENABLED is not "true"', () => {
    expect(
      findMissingOrInvalidLinkedInConfig({
        LINKEDIN_PROVIDER_ENABLED: "false"
      } as NodeJS.ProcessEnv)
    ).toEqual([]);
  });

  test("empty when fully configured", () => {
    expect(findMissingOrInvalidLinkedInConfig(FULL_ENV)).toEqual([]);
  });

  test("reports every missing required var by name", () => {
    const problems = findMissingOrInvalidLinkedInConfig({
      LINKEDIN_PROVIDER_ENABLED: "true"
    } as NodeJS.ProcessEnv);

    expect(problems).toContain("LINKEDIN_CLIENT_ID");
    expect(problems).toContain("LINKEDIN_CLIENT_SECRET_REFERENCE");
    expect(problems).toContain("LINKEDIN_API_VERSION");
    expect(problems).toContain("LINKEDIN_OAUTH_REDIRECT_URI");
    expect(problems).toContain("LINKEDIN_REQUIRED_SCOPES");
  });

  test("reports a malformed LINKEDIN_API_VERSION distinctly from missing", () => {
    const problems = findMissingOrInvalidLinkedInConfig({
      ...FULL_ENV,
      LINKEDIN_API_VERSION: "not-a-version"
    });

    expect(
      problems.some((problem) => problem.includes("LINKEDIN_API_VERSION"))
    ).toBe(true);
  });

  // Medium finding (PR #737 review): doc 18/registry claimed
  // LINKEDIN_CLIENT_SECRET_REFERENCE was rejected if it looked like a raw
  // secret, but nothing in this file actually checked it — only presence
  // was validated. Now enforced directly here.
  test("reports a raw-secret-shaped LINKEDIN_CLIENT_SECRET_REFERENCE", () => {
    const problems = findMissingOrInvalidLinkedInConfig({
      ...FULL_ENV,
      LINKEDIN_CLIENT_SECRET_REFERENCE:
        "EAABwzZCZCpvNsBAA1234567890abcdefghijklmnopqrstuvwxyz"
    });

    expect(
      problems.some((problem) =>
        problem.includes("LINKEDIN_CLIENT_SECRET_REFERENCE")
      )
    ).toBe(true);
  });

  test("accepts a properly-referenced LINKEDIN_CLIENT_SECRET_REFERENCE", () => {
    const problems = findMissingOrInvalidLinkedInConfig(FULL_ENV);

    expect(
      problems.some((problem) =>
        problem.includes("LINKEDIN_CLIENT_SECRET_REFERENCE")
      )
    ).toBe(false);
  });
});

describe("isSupportedLinkedInOrganizationRole (Issue #645)", () => {
  test("accepts ADMINISTRATOR and CONTENT_ADMIN", () => {
    expect(isSupportedLinkedInOrganizationRole("ADMINISTRATOR")).toBe(true);
    expect(isSupportedLinkedInOrganizationRole("CONTENT_ADMIN")).toBe(true);
  });

  test("rejects an ads-only or unknown role", () => {
    expect(
      isSupportedLinkedInOrganizationRole("DIRECT_SPONSORED_CONTENT_POSTER")
    ).toBe(false);
    expect(isSupportedLinkedInOrganizationRole("VIEWER")).toBe(false);
  });
});

describe("resolveLinkedInSecretReference (Issue #645)", () => {
  test("resolves a valid env: reference to the named env var's value", () => {
    const result = resolveLinkedInSecretReference("env:MY_LINKEDIN_SECRET", {
      MY_LINKEDIN_SECRET: "a-non-secret-shaped-reference-value"
    } as NodeJS.ProcessEnv);

    expect(result).toEqual({
      ok: true,
      value: "a-non-secret-shaped-reference-value"
    });
  });

  // Round 1 security-auditor finding (PR #737): an earlier version
  // re-applied `looksLikeRawSecretToken` to the RESOLVED value too, which
  // rejects every realistic LinkedIn access token (150-1000+ opaque
  // chars — exactly the shape the 64+-char high-entropy catch-all is
  // designed to flag). These two fixtures are deliberately >64 chars and
  // match the same `[A-Za-z0-9+/:_-]{64,}` charset/length shape a real
  // token would — the bug's own regression tests must never rely on a
  // short fake token that dodges the threshold, the way `TEST_TOKEN` in
  // `linkedin-provider-adapter.test.ts` does for unrelated scenarios.
  //
  // Deliberately LOW-entropy (repeated blocks, not pseudo-random-looking
  // characters): `matchesKnownRawSecretShape`'s blob regex only checks
  // character class + length, never entropy, so a repeated-block string
  // exercises the exact same code path as a real high-entropy token
  // without reading as a plausible real credential to an automated
  // secret scanner (GitGuardian, etc.) — a false positive there doesn't
  // fail the same way a later commit can clear (see
  // gitguardian-scans-full-pr-history in project memory).
  test("resolves a long (256 char) synthetic opaque value — must NOT be rejected as looking like a raw secret", () => {
    const syntheticOpaqueValue = "aZ29".repeat(64);
    // Well over the 64-char threshold `looksLikeRawSecretToken`'s
    // high-entropy catch-all flags — the whole point of this fixture.
    expect(syntheticOpaqueValue.length).toBe(256);

    const result = resolveLinkedInSecretReference(
      "env:SYNTHETIC_OPAQUE_VALUE",
      { SYNTHETIC_OPAQUE_VALUE: syntheticOpaqueValue } as NodeJS.ProcessEnv
    );

    expect(result).toEqual({ ok: true, value: syntheticOpaqueValue });
  });

  test("resolves a shorter (>64 char) synthetic opaque value — must NOT be rejected as looking like a raw secret", () => {
    const syntheticOpaqueValue = "bK71".repeat(19); // 76 chars
    expect(syntheticOpaqueValue.length).toBeGreaterThan(64);

    const result = resolveLinkedInSecretReference(
      "env:SYNTHETIC_OPAQUE_VALUE_2",
      { SYNTHETIC_OPAQUE_VALUE_2: syntheticOpaqueValue } as NodeJS.ProcessEnv
    );

    expect(result).toEqual({ ok: true, value: syntheticOpaqueValue });
  });

  test("unset reference", () => {
    expect(
      resolveLinkedInSecretReference(null, {} as NodeJS.ProcessEnv)
    ).toEqual({ ok: false, reason: "unset" });
  });

  test("rejects a raw-secret-shaped reference outright (reuses looksLikeRawSecretToken)", () => {
    expect(
      resolveLinkedInSecretReference(
        "EAABwzZCZCpvNsBAA1234567890abcdefghijklmnopqrstuvwxyz",
        {} as NodeJS.ProcessEnv
      )
    ).toEqual({ ok: false, reason: "looks_like_raw_secret" });
  });

  test("prefix-exemption bypass attempt still rejected (env: + a real secret shape)", () => {
    // Same adversarial shape the #643 security-auditor rounds probed —
    // gluing a recognized reference prefix onto a raw-secret-shaped value
    // must NOT defeat the shape check on the stripped remainder.
    expect(
      resolveLinkedInSecretReference(
        "env:EAABwzZCZCpvNsBAA1234567890abcdefghijklmnopqrstuvwxyz",
        {} as NodeJS.ProcessEnv
      )
    ).toEqual({ ok: false, reason: "looks_like_raw_secret" });
  });

  test("unresolvable when the env: target var is unset", () => {
    expect(
      resolveLinkedInSecretReference(
        "env:DOES_NOT_EXIST",
        {} as NodeJS.ProcessEnv
      )
    ).toEqual({ ok: false, reason: "unresolvable" });
  });

  test("unresolvable for a syntactically-recognized but unimplemented reference prefix", () => {
    expect(
      resolveLinkedInSecretReference(
        "secretsmanager:social/linkedin-org-42",
        {} as NodeJS.ProcessEnv
      )
    ).toEqual({ ok: false, reason: "unresolvable" });
  });
});
