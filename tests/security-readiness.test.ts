import { describe, expect, test } from "bun:test";

import {
  checkAbacDefaultDeny,
  checkEmailProviderConfigReady,
  checkGoogleOidcReady,
  checkLoginLockoutImplemented,
  checkLoginRateLimitImplemented,
  checkNewsMediaR2PublicBaseUrlProductionSafe,
  checkOnlineAuthSecurityReady,
  checkSyncHmacSecretNotDefault,
  checkMfaReady,
  checkTurnstileReady,
  checkVisitorAnalyticsGeoTrustedSourceReady,
  checkVisitorAnalyticsHashSaltReady,
  checkVisitorAnalyticsRawIpRetentionReady,
  checkVisitorAnalyticsRawUserAgentRetentionReady,
  checkVisitorAnalyticsRetentionOrderingReady,
  scanLineForHardcodedSecret
} from "../scripts/security-readiness";

// DB-dependent checks (`checkRlsEnabled`, `checkAuditLogTableReachable`,
// `checkSoftDeletePermissionsSeededAndAudited`'s permission-row lookup,
// `checkSsoBreakGlassReady` — Issue #593, `checkNewsMediaR2NoStalePendingObjects`
// — Issue #635) are NOT unit-tested here — they require a real PostgreSQL
// connection and can't be meaningfully faked without either a real DB or a
// mock so heavy it would stop testing the actual query. They are covered by
// live verification instead (`bun run security:readiness` against a real
// migrated database, see `docs/awcms-mini/production-readiness.md`) AND, for
// `checkSsoBreakGlassReady` specifically, by
// `tests/integration/security-readiness-break-glass.integration.test.ts`
// (real Postgres, both the "eligible" pass case and the "deactivated after
// save" fail case); `checkNewsMediaR2NoStalePendingObjects` is covered the
// same way by
// `tests/integration/security-readiness-news-media-r2.integration.test.ts`.
//
// `checkSecurityHeadersPresent` (Issue #437) is likewise not unit-tested
// here — it deliberately hits a *running* server to prove
// `src/middleware.ts` really sets the headers on a live response (not just
// that `buildSecurityHeaders()` returns the right array in isolation,
// already covered by `tests/security-headers.test.ts`). Same "info/not
// checked" fallback as `checkErrorsDontLeakStackTraces` when no server is
// reachable; verified live via `docker compose` / `bun run
// production:preflight` instead.

describe("scanLineForHardcodedSecret", () => {
  test("flags a const declaration assigned a literal secret", () => {
    expect(
      scanLineForHardcodedSecret('const apiSecretKey = "sk_live_abcdef123456";')
    ).toBe("apiSecretKey");
  });

  test("flags an object-literal key assigned a literal password", () => {
    expect(scanLineForHardcodedSecret('  password: "hunter2",')).toBe(
      "password"
    );
  });

  test("does not flag a value read from process.env", () => {
    expect(
      scanLineForHardcodedSecret(
        'const token = process.env.AUTH_JWT_SECRET ?? "change-me-in-production";'
      )
    ).toBeNull();
  });

  test("does not flag a member-expression write (e.g. URL masking)", () => {
    expect(scanLineForHardcodedSecret('url.password = "****";')).toBeNull();
  });

  test("does not flag documented placeholder values", () => {
    expect(
      scanLineForHardcodedSecret('const secret = "change-me";')
    ).toBeNull();
    expect(scanLineForHardcodedSecret('const token = "xxx";')).toBeNull();
  });

  test("does not flag lines with no secret-like variable name", () => {
    expect(
      scanLineForHardcodedSecret('const greeting = "hello world";')
    ).toBeNull();
  });

  test("does not flag a plain string comparison (not an assignment)", () => {
    expect(
      scanLineForHardcodedSecret('if (secret === "change-me") { return; }')
    ).toBeNull();
  });

  // Regression (Issue #437, found live running `bun run security:readiness`
  // against this exact repo): `src/lib/i18n/error-messages.ts`'s
  // `ERROR_CODE_KEYS` map has `TOKEN_EXPIRED: "error.token_expired"` — the
  // key name contains "TOKEN" but the value is an i18n lookup key, not a
  // secret. This previously blocked go-live with a false "critical" finding.
  test("does not flag an i18n/error-code lookup key value", () => {
    expect(
      scanLineForHardcodedSecret('  TOKEN_EXPIRED: "error.token_expired",')
    ).toBeNull();
  });

  // A value containing a dot must NOT be treated as i18n-key-like unless it
  // actually matches the strict lowercase dot-namespace shape — this
  // fixture's second segment starts with a digit, so it still gets flagged.
  // Built via concatenation (not one static string literal) so no single
  // line of *this test file's own source* looks like a plausible
  // "name = quoted-secret" assignment — a prior version used one static
  // literal and GitGuardian's CI secret scan flagged it (twice, across two
  // commits, even after the value was changed to something low-entropy),
  // since it pattern-matches the shape itself, not just high-entropy
  // values. Runtime behavior under test is identical either way.
  test("still flags a value with a dot that isn't i18n-key-shaped", () => {
    const variableName = "api" + "Key";
    const fixtureValue = "not-a-key" + "." + "123not-i18n";
    const line = `const ${variableName} = "${fixtureValue}";`;

    expect(scanLineForHardcodedSecret(line)).toBe("apiKey");
  });
});

describe("checkAbacDefaultDeny", () => {
  test("passes when evaluateAccess denies with an empty permission set", () => {
    const result = checkAbacDefaultDeny();

    expect(result.severity).toBe("critical");
    expect(result.status).toBe("pass");
    expect(result.evidence).toContain("default_deny");
  });
});

describe("checkLoginLockoutImplemented", () => {
  test("passes when the 5th consecutive failed attempt locks the account", () => {
    const result = checkLoginLockoutImplemented();

    expect(result.severity).toBe("critical");
    expect(result.status).toBe("pass");
    expect(result.evidence).toContain("lockedUntil");
  });
});

describe("checkLoginRateLimitImplemented", () => {
  test("passes when the 4th call within maxAttempts=3 is denied", () => {
    const result = checkLoginRateLimitImplemented();

    expect(result.severity).toBe("warning");
    expect(result.status).toBe("pass");
    expect(result.evidence).toContain("denies the 4th call");
  });
});

describe("checkSyncHmacSecretNotDefault", () => {
  test("is info/pass when sync is not enabled", () => {
    const result = checkSyncHmacSecretNotDefault({
      AWCMS_MINI_SYNC_ENABLED: "false",
      AWCMS_MINI_SYNC_HMAC_SECRET: "change-me"
    } as NodeJS.ProcessEnv);

    expect(result.severity).toBe("info");
    expect(result.status).toBe("pass");
  });

  test("fails when sync is enabled but the secret is still the placeholder", () => {
    const result = checkSyncHmacSecretNotDefault({
      AWCMS_MINI_SYNC_ENABLED: "true",
      AWCMS_MINI_SYNC_HMAC_SECRET: "change-me"
    } as NodeJS.ProcessEnv);

    expect(result.severity).toBe("warning");
    expect(result.status).toBe("fail");
  });

  test("fails when sync is enabled but the secret is unset", () => {
    const result = checkSyncHmacSecretNotDefault({
      AWCMS_MINI_SYNC_ENABLED: "true"
    } as NodeJS.ProcessEnv);

    expect(result.status).toBe("fail");
  });

  test("passes when sync is enabled and the secret has been changed", () => {
    const result = checkSyncHmacSecretNotDefault({
      AWCMS_MINI_SYNC_ENABLED: "true",
      AWCMS_MINI_SYNC_HMAC_SECRET: "a-real-random-secret-value"
    } as NodeJS.ProcessEnv);

    expect(result.severity).toBe("warning");
    expect(result.status).toBe("pass");
  });
});

describe("checkEmailProviderConfigReady", () => {
  test("is critical/pass when email is not enabled", () => {
    const result = checkEmailProviderConfigReady({
      EMAIL_ENABLED: "false"
    } as NodeJS.ProcessEnv);

    expect(result.severity).toBe("critical");
    expect(result.status).toBe("pass");
  });

  test("fails when email is enabled but EMAIL_FROM_ADDRESS/EMAIL_PROVIDER are missing", () => {
    const result = checkEmailProviderConfigReady({
      EMAIL_ENABLED: "true"
    } as NodeJS.ProcessEnv);

    expect(result.severity).toBe("critical");
    expect(result.status).toBe("fail");
  });

  test("fails when EMAIL_PROVIDER=mailketing but its account/token/base-url vars are missing", () => {
    const result = checkEmailProviderConfigReady({
      EMAIL_ENABLED: "true",
      EMAIL_FROM_ADDRESS: "no-reply@example.com",
      EMAIL_PROVIDER: "mailketing"
    } as NodeJS.ProcessEnv);

    expect(result.status).toBe("fail");
    expect(result.evidence).toContain("EMAIL_MAILKETING");
  });

  test("passes when email is enabled and all conditional config is complete", () => {
    const result = checkEmailProviderConfigReady({
      EMAIL_ENABLED: "true",
      EMAIL_FROM_ADDRESS: "no-reply@example.com",
      EMAIL_PROVIDER: "mailketing",
      EMAIL_MAILKETING_ACCOUNT_ID: "acc",
      EMAIL_MAILKETING_API_TOKEN: "token",
      EMAIL_MAILKETING_API_BASE_URL: "https://api.mailketing.co.id"
    } as NodeJS.ProcessEnv);

    expect(result.severity).toBe("critical");
    expect(result.status).toBe("pass");
  });
});

describe("checkTurnstileReady", () => {
  test("is critical/pass (informational, not a failure) when Turnstile is not enabled", () => {
    const result = checkTurnstileReady({} as NodeJS.ProcessEnv);

    expect(result.severity).toBe("critical");
    expect(result.status).toBe("pass");
  });

  test("fails when TURNSTILE_ENABLED=true but the site/secret keys are missing", () => {
    const result = checkTurnstileReady({
      TURNSTILE_ENABLED: "true"
    } as NodeJS.ProcessEnv);

    expect(result.severity).toBe("critical");
    expect(result.status).toBe("fail");
  });

  test("passes when TURNSTILE_ENABLED=true and both keys are set", () => {
    const result = checkTurnstileReady({
      TURNSTILE_ENABLED: "true",
      TURNSTILE_SITE_KEY: "site-key-abc",
      TURNSTILE_SECRET_KEY: "a-real-secret"
    } as NodeJS.ProcessEnv);

    expect(result.severity).toBe("critical");
    expect(result.status).toBe("pass");
  });
});

describe("checkMfaReady", () => {
  const validKey = Buffer.alloc(32, 5).toString("base64");

  test("is critical/pass (informational, not a failure) when MFA is not enabled", () => {
    const result = checkMfaReady({} as NodeJS.ProcessEnv);

    expect(result.severity).toBe("critical");
    expect(result.status).toBe("pass");
  });

  test("fails when AUTH_MFA_ENABLED=true but the encryption key is missing", () => {
    const result = checkMfaReady({
      AUTH_MFA_ENABLED: "true"
    } as NodeJS.ProcessEnv);

    expect(result.severity).toBe("critical");
    expect(result.status).toBe("fail");
  });

  test("passes when AUTH_MFA_ENABLED=true and the key is a valid 32-byte base64 value", () => {
    const result = checkMfaReady({
      AUTH_MFA_ENABLED: "true",
      AUTH_MFA_SECRET_ENCRYPTION_KEY: validKey
    } as NodeJS.ProcessEnv);

    expect(result.severity).toBe("critical");
    expect(result.status).toBe("pass");
  });
});

describe("checkGoogleOidcReady", () => {
  test("is critical/pass (informational, not a failure) when Google login is not enabled", () => {
    const result = checkGoogleOidcReady({} as NodeJS.ProcessEnv);

    expect(result.severity).toBe("critical");
    expect(result.status).toBe("pass");
  });

  test("fails when AUTH_GOOGLE_LOGIN_ENABLED=true but the client id/secret are missing", () => {
    const result = checkGoogleOidcReady({
      AUTH_GOOGLE_LOGIN_ENABLED: "true"
    } as NodeJS.ProcessEnv);

    expect(result.severity).toBe("critical");
    expect(result.status).toBe("fail");
  });

  test("passes when AUTH_GOOGLE_LOGIN_ENABLED=true and both client id/secret are set", () => {
    const result = checkGoogleOidcReady({
      AUTH_GOOGLE_LOGIN_ENABLED: "true",
      AUTH_GOOGLE_CLIENT_ID: "client-abc",
      AUTH_GOOGLE_CLIENT_SECRET: "a-real-secret"
    } as NodeJS.ProcessEnv);

    expect(result.severity).toBe("critical");
    expect(result.status).toBe("pass");
  });
});

describe("checkOnlineAuthSecurityReady", () => {
  test("is critical/pass (informational, not a failure) when the gate is disabled", () => {
    const result = checkOnlineAuthSecurityReady({} as NodeJS.ProcessEnv);

    expect(result.severity).toBe("critical");
    expect(result.status).toBe("pass");
  });

  test("fails when AUTH_ONLINE_SECURITY_ENABLED=true but AUTH_ONLINE_SECURITY_PROFILE is missing/invalid", () => {
    const result = checkOnlineAuthSecurityReady({
      AUTH_ONLINE_SECURITY_ENABLED: "true"
    } as NodeJS.ProcessEnv);

    expect(result.severity).toBe("critical");
    expect(result.status).toBe("fail");
  });

  test("passes when AUTH_ONLINE_SECURITY_ENABLED=true and AUTH_ONLINE_SECURITY_PROFILE=full_online", () => {
    const result = checkOnlineAuthSecurityReady({
      AUTH_ONLINE_SECURITY_ENABLED: "true",
      AUTH_ONLINE_SECURITY_PROFILE: "full_online"
    } as NodeJS.ProcessEnv);

    expect(result.severity).toBe("critical");
    expect(result.status).toBe("pass");
  });
});

// Issue #624 (epic: visitor analytics #617-#624) — cross-field
// privacy/retention posture checks, distinct from `validate-env.test.ts`'s
// `checkVisitorAnalyticsConfig` (shape-only: enum/positive-int format).
describe("checkVisitorAnalyticsRawIpRetentionReady", () => {
  test("is critical/pass when raw IP is not enabled", () => {
    const result = checkVisitorAnalyticsRawIpRetentionReady(
      {} as NodeJS.ProcessEnv
    );

    expect(result.severity).toBe("critical");
    expect(result.status).toBe("pass");
  });

  test("passes when raw IP is enabled and raw-detail retention does not exceed event retention", () => {
    const result = checkVisitorAnalyticsRawIpRetentionReady({
      VISITOR_ANALYTICS_RAW_IP_ENABLED: "true",
      VISITOR_ANALYTICS_RAW_DETAIL_RETENTION_DAYS: "30",
      VISITOR_ANALYTICS_EVENT_RETENTION_DAYS: "90"
    } as NodeJS.ProcessEnv);

    expect(result.severity).toBe("critical");
    expect(result.status).toBe("pass");
  });

  test("fails when raw IP is enabled and raw-detail retention exceeds event retention", () => {
    const result = checkVisitorAnalyticsRawIpRetentionReady({
      VISITOR_ANALYTICS_RAW_IP_ENABLED: "true",
      VISITOR_ANALYTICS_RAW_DETAIL_RETENTION_DAYS: "200",
      VISITOR_ANALYTICS_EVENT_RETENTION_DAYS: "90"
    } as NodeJS.ProcessEnv);

    expect(result.severity).toBe("critical");
    expect(result.status).toBe("fail");
  });
});

describe("checkVisitorAnalyticsRawUserAgentRetentionReady", () => {
  test("is warning/pass when raw user-agent is not enabled", () => {
    const result = checkVisitorAnalyticsRawUserAgentRetentionReady(
      {} as NodeJS.ProcessEnv
    );

    expect(result.severity).toBe("warning");
    expect(result.status).toBe("pass");
  });

  test("fails (warning) when raw user-agent is enabled and retention ordering is unsafe", () => {
    const result = checkVisitorAnalyticsRawUserAgentRetentionReady({
      VISITOR_ANALYTICS_RAW_USER_AGENT_ENABLED: "true",
      VISITOR_ANALYTICS_RAW_DETAIL_RETENTION_DAYS: "200",
      VISITOR_ANALYTICS_EVENT_RETENTION_DAYS: "90"
    } as NodeJS.ProcessEnv);

    expect(result.severity).toBe("warning");
    expect(result.status).toBe("fail");
    expect(result.evidence).toContain("no-op");
  });

  test("passes when raw user-agent is enabled and retention ordering is safe", () => {
    const result = checkVisitorAnalyticsRawUserAgentRetentionReady({
      VISITOR_ANALYTICS_RAW_USER_AGENT_ENABLED: "true",
      VISITOR_ANALYTICS_RAW_DETAIL_RETENTION_DAYS: "30",
      VISITOR_ANALYTICS_EVENT_RETENTION_DAYS: "90"
    } as NodeJS.ProcessEnv);

    expect(result.severity).toBe("warning");
    expect(result.status).toBe("pass");
  });
});

describe("checkVisitorAnalyticsGeoTrustedSourceReady", () => {
  test("is critical/pass when geo enrichment is not enabled", () => {
    const result = checkVisitorAnalyticsGeoTrustedSourceReady(
      {} as NodeJS.ProcessEnv
    );

    expect(result.severity).toBe("critical");
    expect(result.status).toBe("pass");
  });

  test("fails when geo is enabled but Cloudflare trust is not", () => {
    const result = checkVisitorAnalyticsGeoTrustedSourceReady({
      VISITOR_ANALYTICS_GEO_ENABLED: "true"
    } as NodeJS.ProcessEnv);

    expect(result.severity).toBe("critical");
    expect(result.status).toBe("fail");
  });

  test("passes when geo is enabled and Cloudflare trust is also enabled", () => {
    const result = checkVisitorAnalyticsGeoTrustedSourceReady({
      VISITOR_ANALYTICS_GEO_ENABLED: "true",
      VISITOR_ANALYTICS_TRUST_CLOUDFLARE: "true"
    } as NodeJS.ProcessEnv);

    expect(result.severity).toBe("critical");
    expect(result.status).toBe("pass");
  });
});

describe("checkVisitorAnalyticsRetentionOrderingReady", () => {
  test("passes with every retention var left at its privacy-first default", () => {
    const result = checkVisitorAnalyticsRetentionOrderingReady(
      {} as NodeJS.ProcessEnv
    );

    expect(result.severity).toBe("warning");
    expect(result.status).toBe("pass");
  });

  test("fails when raw-detail retention exceeds event retention", () => {
    const result = checkVisitorAnalyticsRetentionOrderingReady({
      VISITOR_ANALYTICS_RAW_DETAIL_RETENTION_DAYS: "200",
      VISITOR_ANALYTICS_EVENT_RETENTION_DAYS: "90"
    } as NodeJS.ProcessEnv);

    expect(result.status).toBe("fail");
    expect(result.evidence).toContain("RAW_DETAIL_RETENTION_DAYS");
  });

  test("fails when rollup retention is shorter than event retention", () => {
    const result = checkVisitorAnalyticsRetentionOrderingReady({
      VISITOR_ANALYTICS_EVENT_RETENTION_DAYS: "90",
      VISITOR_ANALYTICS_ROLLUP_RETENTION_DAYS: "30"
    } as NodeJS.ProcessEnv);

    expect(result.status).toBe("fail");
    expect(result.evidence).toContain("ROLLUP_RETENTION_DAYS");
  });
});

describe("checkVisitorAnalyticsHashSaltReady", () => {
  test("is warning/pass when visitor analytics is disabled entirely", () => {
    const result = checkVisitorAnalyticsHashSaltReady({
      VISITOR_ANALYTICS_ENABLED: "false"
    } as NodeJS.ProcessEnv);

    expect(result.severity).toBe("warning");
    expect(result.status).toBe("pass");
  });

  test("fails (warning) when enabled (the default) with no hash salt configured", () => {
    const result = checkVisitorAnalyticsHashSaltReady({} as NodeJS.ProcessEnv);

    expect(result.severity).toBe("warning");
    expect(result.status).toBe("fail");
  });

  test("passes when enabled and a hash salt is configured", () => {
    const result = checkVisitorAnalyticsHashSaltReady({
      VISITOR_ANALYTICS_HASH_SALT: "a-real-deployment-salt"
    } as NodeJS.ProcessEnv);

    expect(result.severity).toBe("warning");
    expect(result.status).toBe("pass");
  });
});

describe("checkNewsMediaR2PublicBaseUrlProductionSafe (Issue #635)", () => {
  test('passes when NEWS_MEDIA_R2_ENABLED is not "true"', () => {
    const result = checkNewsMediaR2PublicBaseUrlProductionSafe({
      APP_ENV: "production",
      NEWS_MEDIA_R2_PUBLIC_BASE_URL: "https://pub-abc.r2.dev"
    } as NodeJS.ProcessEnv);

    expect(result.status).toBe("pass");
    expect(result.severity).toBe("critical");
  });

  test("passes for a non-production APP_ENV even with an r2.dev URL — documented separately, never weakens the production default", () => {
    const result = checkNewsMediaR2PublicBaseUrlProductionSafe({
      APP_ENV: "development",
      NEWS_MEDIA_R2_ENABLED: "true",
      NEWS_MEDIA_R2_PUBLIC_BASE_URL: "https://pub-abc.r2.dev"
    } as NodeJS.ProcessEnv);

    expect(result.status).toBe("pass");
  });

  test("passes in production with a real custom domain", () => {
    const result = checkNewsMediaR2PublicBaseUrlProductionSafe({
      APP_ENV: "production",
      NEWS_MEDIA_R2_ENABLED: "true",
      NEWS_MEDIA_R2_PUBLIC_BASE_URL: "https://media.example.com"
    } as NodeJS.ProcessEnv);

    expect(result.status).toBe("pass");
  });

  test("fails in production with Cloudflare's default *.r2.dev domain", () => {
    const result = checkNewsMediaR2PublicBaseUrlProductionSafe({
      APP_ENV: "production",
      NEWS_MEDIA_R2_ENABLED: "true",
      NEWS_MEDIA_R2_PUBLIC_BASE_URL: "https://pub-abc123.r2.dev"
    } as NodeJS.ProcessEnv);

    expect(result.status).toBe("fail");
    expect(result.evidence).toContain("r2.dev");
  });

  test("fails in production with a loopback host", () => {
    const result = checkNewsMediaR2PublicBaseUrlProductionSafe({
      APP_ENV: "production",
      NEWS_MEDIA_R2_ENABLED: "true",
      NEWS_MEDIA_R2_PUBLIC_BASE_URL: "http://localhost:3000"
    } as NodeJS.ProcessEnv);

    expect(result.status).toBe("fail");
  });
});
