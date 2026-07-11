import { describe, expect, test } from "bun:test";

import {
  CONFIG_EXEMPTIONS,
  CONFIG_REGISTRY,
  findConfigVarEntry,
  listDeprecatedConfigVarEntries,
  listSecretConfigVarNames,
  type ConfigVarRequirement,
  type ConfigVarSensitivity,
  type ConfigVarType,
  type DeploymentProfile
} from "../../src/lib/config/registry";
import { runEnvValidation } from "../../scripts/validate-env";
import { DEFAULT_LOCALE, resolveLocale } from "../../src/lib/i18n/locale";
import { formatDateTime } from "../../src/lib/i18n/format";
import { resolveObjectUploader } from "../../src/modules/sync-storage/infrastructure/object-storage-uploader";

const VALID_TYPES: readonly ConfigVarType[] = [
  "string",
  "boolean",
  "integer",
  "url",
  "enum",
  "path",
  "csv",
  "uuid"
];
const VALID_REQUIREMENTS: readonly ConfigVarRequirement[] = [
  "required",
  "optional",
  "conditional"
];
const VALID_SENSITIVITIES: readonly ConfigVarSensitivity[] = [
  "secret",
  "non-secret"
];
const VALID_PROFILES: readonly DeploymentProfile[] = [
  "development",
  "staging",
  "production",
  "offline-lan"
];

describe("CONFIG_REGISTRY completeness (Issue #689)", () => {
  test("every entry has all required metadata fields non-empty", () => {
    for (const entry of CONFIG_REGISTRY) {
      expect(entry.name.length, `${entry.name}: name`).toBeGreaterThan(0);
      expect(
        VALID_TYPES.includes(entry.type),
        `${entry.name}: type "${entry.type}" must be a known ConfigVarType`
      ).toBe(true);
      expect(
        VALID_REQUIREMENTS.includes(entry.required),
        `${entry.name}: required "${entry.required}" must be a known ConfigVarRequirement`
      ).toBe(true);
      expect(
        entry.ownerModule.length,
        `${entry.name}: ownerModule`
      ).toBeGreaterThan(0);
      expect(
        VALID_SENSITIVITIES.includes(entry.sensitivity),
        `${entry.name}: sensitivity "${entry.sensitivity}" must be a known ConfigVarSensitivity`
      ).toBe(true);
      expect(
        Array.isArray(entry.profiles) && entry.profiles.length > 0,
        `${entry.name}: profiles must be a non-empty array`
      ).toBe(true);

      for (const profile of entry.profiles) {
        expect(
          VALID_PROFILES.includes(profile),
          `${entry.name}: profile "${profile}" must be a known DeploymentProfile`
        ).toBe(true);
      }

      expect(
        entry.description.length,
        `${entry.name}: description`
      ).toBeGreaterThan(0);
    }
  });

  test("every var name matches SCREAMING_SNAKE_CASE convention", () => {
    for (const entry of CONFIG_REGISTRY) {
      expect(entry.name).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  test("no duplicate variable names", () => {
    const names = CONFIG_REGISTRY.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("no name collides between the registry and CONFIG_EXEMPTIONS", () => {
    const registryNames = new Set(CONFIG_REGISTRY.map((entry) => entry.name));

    for (const exemption of CONFIG_EXEMPTIONS) {
      expect(
        registryNames.has(exemption.name),
        `"${exemption.name}" is both a registry entry and an exemption — pick one.`
      ).toBe(false);
    }
  });

  test("every exemption has a non-empty reason", () => {
    for (const exemption of CONFIG_EXEMPTIONS) {
      expect(exemption.reason.length, exemption.name).toBeGreaterThan(0);
    }
  });

  test("every deprecated entry has since/removalVersion/guidance all non-empty, and removalVersion differs from since", () => {
    const deprecated = listDeprecatedConfigVarEntries();
    expect(deprecated.length).toBeGreaterThan(0);

    for (const entry of deprecated) {
      const info = entry.deprecated!;
      expect(info.since.length, `${entry.name}: since`).toBeGreaterThan(0);
      expect(
        info.removalVersion.length,
        `${entry.name}: removalVersion`
      ).toBeGreaterThan(0);
      expect(info.guidance.length, `${entry.name}: guidance`).toBeGreaterThan(
        0
      );
      expect(
        info.removalVersion,
        `${entry.name}: removalVersion must differ from since (compatibility window)`
      ).not.toBe(info.since);
    }
  });

  test("findConfigVarEntry finds a known entry and returns undefined for an unknown name", () => {
    expect(findConfigVarEntry("DATABASE_URL")?.name).toBe("DATABASE_URL");
    expect(findConfigVarEntry("NOT_A_REAL_VAR_XYZ")).toBeUndefined();
  });

  test("listSecretConfigVarNames only returns entries flagged secret", () => {
    const secretNames = listSecretConfigVarNames();
    expect(secretNames).toContain("DATABASE_URL");
    expect(secretNames).toContain("AUTH_JWT_SECRET");
    expect(secretNames).not.toContain("APP_ENV");

    for (const name of secretNames) {
      expect(findConfigVarEntry(name)?.sensitivity).toBe("secret");
    }
  });
});

describe("Redaction — no CONFIG_REGISTRY secret value ever leaks into runEnvValidation output (Issue #689 acceptance criteria)", () => {
  const VALID_MFA_KEY = Buffer.alloc(32, 7).toString("base64");
  const VALID_SSO_KEY = Buffer.alloc(32, 9).toString("base64");

  /** A "kitchen sink" env with every feature gate enabled and every conditionally-required var set to a realistic (non-marker) value, so every checkXxxConfig function actually processes every secret var below. */
  function buildFullyEnabledEnv(): NodeJS.ProcessEnv {
    return {
      APP_ENV: "production",
      APP_URL: "https://awcms-mini.example.test",
      APP_TIMEZONE: "Asia/Jakarta",
      DATABASE_URL: "postgres://user:pass@localhost:5432/awcms-mini",
      AUTH_JWT_SECRET: "a-real-random-secret-value",

      AWCMS_MINI_SYNC_ENABLED: "true",
      AWCMS_MINI_SYNC_HMAC_SECRET: "a-real-random-sync-secret",

      R2_ENABLED: "true",
      R2_ACCOUNT_ID: "sync-account-id",
      R2_ACCESS_KEY_ID: "sync-access-key-id",
      R2_SECRET_ACCESS_KEY: "sync-secret-access-key",
      R2_BUCKET: "sync-bucket",

      EMAIL_ENABLED: "true",
      EMAIL_PROVIDER: "mailketing",
      EMAIL_FROM_ADDRESS: "no-reply@example.test",
      EMAIL_MAILKETING_ACCOUNT_ID: "mailketing-account-id",
      EMAIL_MAILKETING_API_TOKEN: "mailketing-api-token",
      EMAIL_MAILKETING_API_BASE_URL: "https://api.mailketing.example/v1",

      PUBLIC_TENANT_RESOLUTION_MODE: "host_default",
      PUBLIC_PLATFORM_ROOT_DOMAIN: "example.test",

      TENANT_DOMAIN_DNS_PROVIDER: "cloudflare",
      TENANT_DOMAIN_PLATFORM_ROOT_DOMAIN: "example.test",
      TENANT_DOMAIN_CLOUDFLARE_ZONE_ID: "zone-abc",
      TENANT_DOMAIN_CLOUDFLARE_API_TOKEN: "cloudflare-api-token",

      AUTH_ONLINE_SECURITY_ENABLED: "true",
      AUTH_ONLINE_SECURITY_PROFILE: "full_online",

      TURNSTILE_ENABLED: "true",
      TURNSTILE_SITE_KEY: "turnstile-site-key",
      TURNSTILE_SECRET_KEY: "turnstile-secret-key",

      AUTH_MFA_ENABLED: "true",
      AUTH_MFA_SECRET_ENCRYPTION_KEY: VALID_MFA_KEY,

      AUTH_GOOGLE_LOGIN_ENABLED: "true",
      AUTH_GOOGLE_CLIENT_ID: "google-client-id",
      AUTH_GOOGLE_CLIENT_SECRET: "google-client-secret",

      AUTH_SSO_ENABLED: "true",
      AUTH_SSO_CREDENTIAL_ENCRYPTION_KEY: VALID_SSO_KEY,

      NEWS_PORTAL_ENABLED: "true",
      NEWS_PORTAL_PROFILE: "full_online_r2",
      NEWS_MEDIA_R2_ENABLED: "true",
      NEWS_MEDIA_R2_ACCOUNT_ID: "news-media-account-id",
      NEWS_MEDIA_R2_ACCESS_KEY_ID: "news-media-access-key-id",
      NEWS_MEDIA_R2_SECRET_ACCESS_KEY: "news-media-secret-access-key",
      NEWS_MEDIA_R2_BUCKET: "news-media-bucket",
      NEWS_MEDIA_R2_PUBLIC_BASE_URL: "https://media.example.test",

      VISITOR_ANALYTICS_HASH_SALT: "visitor-analytics-hash-salt"
    } as NodeJS.ProcessEnv;
  }

  const secretNames = listSecretConfigVarNames();

  test("the registry has more than one secret var to actually exercise this test meaningfully", () => {
    expect(secretNames.length).toBeGreaterThan(5);
  });

  test.each([...secretNames])(
    "%s's configured value never appears in runEnvValidation's output",
    (name: string) => {
      const marker = `REDACTION-MARKER-${name}-${Math.random().toString(36).slice(2)}`;
      const env = {
        ...buildFullyEnabledEnv(),
        [name]: marker
      } as NodeJS.ProcessEnv;

      const results = runEnvValidation(env);
      const serialized = JSON.stringify(results);

      expect(serialized).not.toContain(marker);
    }
  );
});

describe("Minimal offline/LAN config (Issue #689 acceptance criteria)", () => {
  test('setting only registry required= "required" vars (no external provider) passes runEnvValidation', () => {
    const requiredDefaults: Record<string, string> = {
      APP_ENV: "development",
      APP_URL: "http://localhost:4321",
      APP_TIMEZONE: "Asia/Jakarta",
      DATABASE_URL: "postgres://awcms_mini_app:pw@localhost:5432/awcms-mini",
      AUTH_JWT_SECRET: "change-me-in-development"
    };

    const requiredNames = CONFIG_REGISTRY.filter(
      (entry) => entry.required === "required"
    ).map((entry) => entry.name);

    // Guards this test against silently going stale if a new required var
    // is ever added to the registry without a corresponding fixture value.
    for (const name of requiredNames) {
      expect(
        requiredDefaults[name],
        `Add a realistic value for newly-required var "${name}" to this test's requiredDefaults.`
      ).toBeDefined();
    }

    const env = requiredNames.reduce(
      (acc, name) => {
        acc[name] = requiredDefaults[name]!;
        return acc;
      },
      {} as Record<string, string>
    ) as NodeJS.ProcessEnv;

    const results = runEnvValidation(env);
    const failed = results.filter((result) => result.status === "fail");

    expect(failed).toEqual([]);
  });
});

describe("Locale source of truth (Issue #689 — APP_DEFAULT_LOCALE vs runtime DEFAULT_LOCALE evidence)", () => {
  test('DEFAULT_LOCALE is the hardcoded "en" fallback, independent of APP_DEFAULT_LOCALE', () => {
    expect(DEFAULT_LOCALE).toBe("en");
  });

  test("resolveLocale's fallback ignores APP_DEFAULT_LOCALE entirely — its signature has no env parameter at all", () => {
    const original = process.env.APP_DEFAULT_LOCALE;
    process.env.APP_DEFAULT_LOCALE = "id";

    try {
      // No cookie, no tenant default — must fall back to DEFAULT_LOCALE
      // ("en"), never to process.env.APP_DEFAULT_LOCALE ("id" here).
      expect(resolveLocale({})).toBe("en");
    } finally {
      if (original === undefined) {
        delete process.env.APP_DEFAULT_LOCALE;
      } else {
        process.env.APP_DEFAULT_LOCALE = original;
      }
    }
  });
});

describe("Timezone source of truth (Issue #689 — APP_TIMEZONE is never read)", () => {
  test("formatDateTime's output is identical regardless of APP_TIMEZONE — proves the hardcoded Asia/Jakarta constant wins, not this env var", () => {
    const fixedDate = new Date("2024-06-15T20:30:00Z");
    const original = process.env.APP_TIMEZONE;

    try {
      process.env.APP_TIMEZONE = "UTC";
      const withUtc = formatDateTime(fixedDate, "en");

      process.env.APP_TIMEZONE = "America/New_York";
      const withNewYork = formatDateTime(fixedDate, "en");

      // If APP_TIMEZONE had any effect, these two values (UTC vs. America/
      // New_York — many hours apart) would differ. They don't, because
      // src/lib/i18n/format.ts hardcodes Asia/Jakarta and never reads this
      // env var at all.
      expect(withUtc).toBe(withNewYork);
    } finally {
      if (original === undefined) {
        delete process.env.APP_TIMEZONE;
      } else {
        process.env.APP_TIMEZONE = original;
      }
    }
  });
});

describe("Storage source of truth (Issue #689 — STORAGE_DRIVER is never read, R2_ENABLED is)", () => {
  test("resolveObjectUploader takes a plain boolean (already derived from R2_ENABLED at enqueue time) — STORAGE_DRIVER cannot influence it structurally", async () => {
    const original = process.env.STORAGE_DRIVER;

    try {
      // Even set to the "wrong" value on purpose, STORAGE_DRIVER cannot
      // change resolveObjectUploader's behavior — it isn't a parameter and
      // isn't read anywhere in object-storage-uploader.ts.
      process.env.STORAGE_DRIVER = "r2";
      const noopUploader = resolveObjectUploader(false);
      const noopResult = await noopUploader({
        objectKey: "k",
        localPath: "/tmp/x",
        checksumSha256: "abc"
      });
      expect(noopResult.ok).toBe(true);

      process.env.STORAGE_DRIVER = "local";
      delete process.env.R2_ACCOUNT_ID;
      delete process.env.R2_ACCESS_KEY_ID;
      delete process.env.R2_SECRET_ACCESS_KEY;
      delete process.env.R2_BUCKET;

      // requiresUpload=true still attempts the R2 path (and fails cleanly
      // on missing credentials) even though STORAGE_DRIVER=local — proving
      // STORAGE_DRIVER has no veto power over the real switch
      // (requiresUpload, itself derived from R2_ENABLED, not from this var).
      const r2Uploader = resolveObjectUploader(true);
      const r2Result = await r2Uploader({
        objectKey: "k",
        localPath: "/tmp/x",
        checksumSha256: "abc"
      });
      expect(r2Result.ok).toBe(false);
    } finally {
      if (original === undefined) {
        delete process.env.STORAGE_DRIVER;
      } else {
        process.env.STORAGE_DRIVER = original;
      }
    }
  });
});
