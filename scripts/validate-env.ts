/**
 * validate-env.ts — `bun run config:validate`.
 *
 * Issue 12.2 (doc 18 §Prinsip konfigurasi #5 "Konfigurasi tervalidasi saat
 * boot; nilai wajib yang hilang menghentikan start dengan pesan jelas",
 * doc 18 §"Referensi environment variable", doc 18 §"Validasi konfigurasi
 * saat boot"). Validates the environment (as loaded by Bun's built-in
 * `.env` support — the same mechanism every other script in this repo
 * relies on, e.g. `scripts/security-readiness.ts` reading
 * `process.env.DATABASE_URL` directly) against doc 18's variable table:
 *
 *  1. Required, must be non-empty: APP_ENV, APP_URL, APP_TIMEZONE,
 *     DATABASE_URL, AUTH_JWT_SECRET.
 *  2. Conditional: if AWCMS_MINI_SYNC_ENABLED === "true", then
 *     AWCMS_MINI_SYNC_HMAC_SECRET must be set and not left at the
 *     `.env.example` placeholder ("change-me"). This reuses
 *     `checkSyncHmacSecretNotDefault` from `security-readiness.ts` (Issue
 *     10.3) verbatim rather than re-implementing the placeholder-detection
 *     logic a second, divergent way — its `status` field (not its
 *     `severity`, which is scoped to that script's own go-live gate) is
 *     what decides pass/fail here.
 *  3. Conditional: if R2_ENABLED === "true", then R2_ACCOUNT_ID,
 *     R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET must all be
 *     set. These four vars are not in the current minimal `.env.example`
 *     (doc 18 documents them as "bila R2" in its fuller reference table) —
 *     that's fine, they are validated conditionally regardless of whether
 *     `.env.example` carries commented-out placeholders for them.
 *  4. Conditional (Issue #493, epic #492): if EMAIL_ENABLED === "true",
 *     then EMAIL_FROM_ADDRESS must be set, EMAIL_PROVIDER must be one of
 *     `KNOWN_EMAIL_PROVIDERS` (`../src/modules/email/domain/email-config`),
 *     and — when EMAIL_PROVIDER === "mailketing" — EMAIL_MAILKETING_ACCOUNT_ID,
 *     EMAIL_MAILKETING_API_TOKEN, and EMAIL_MAILKETING_API_BASE_URL must all
 *     be set. Mirrors the R2 conditional check above; see
 *     `src/modules/email/README.md` for why these vars are namespaced
 *     `EMAIL_*`/`EMAIL_MAILKETING_*` rather than the illustrative
 *     `MAILKETING_*` rows in doc 18 §Provider CRM (opsional).
 *  5. Public tenant routing (Issue #556, epic #555, config-only — no
 *     tenant-domain schema/resolver/routes here yet):
 *       - PUBLIC_TENANT_RESOLUTION_MODE, if set, must be one of
 *         `PUBLIC_TENANT_RESOLUTION_MODES`. Left unset it is *not* an
 *         error — that is the backward-compatible default every existing
 *         offline/LAN deployment already runs (today's only public route
 *         is the legacy `/blog/{tenantCode}` path; see doc 18 §Public
 *         routing and `deployment-profiles.md`).
 *       - mode === "host_default" requires PUBLIC_PLATFORM_ROOT_DOMAIN:
 *         the host-based resolver landing in Issue #559 needs a root
 *         domain to tell a tenant subdomain apart from an unrelated host.
 *       - mode === "env_default" requires at least one of
 *         PUBLIC_DEFAULT_TENANT_ID / PUBLIC_DEFAULT_TENANT_CODE.
 *       - mode === "setup_default" / "tenant_code_legacy" need no extra
 *         var here (setup_default's default tenant lives in DB via the
 *         Setup Wizard; tenant_code_legacy is today's behavior).
 *       - PUBLIC_CANONICAL_BASE_PATH, if set, must be an absolute path
 *         (leading "/", no whitespace, no trailing slash unless it is
 *         exactly "/", no "//"). Left unset it defaults to `/news`
 *         at the code level (not enforced here, same convention as other
 *         defaulted vars like AUDIT_LOG_RETENTION_DAYS).
 *       - PUBLIC_TRUST_PROXY is intentionally not validated here (no
 *         format/conditional requirement, same as other boolean flags in
 *         this file) — its safe default is `false` in `.env.example`.
 *         Docs (doc 18, deployment-profiles.md) spell out that
 *         `PUBLIC_TRUST_PROXY=true` must only be used behind a trusted
 *         reverse proxy, since a future host-based resolver (#559) would
 *         otherwise trust a spoofable `X-Forwarded-Host` header.
 *
 * Never prints actual secret values — only which variable name is
 * missing/invalid (doc 18: "Var wajib hilang → gagal start dengan pesan
 * jelas (tanpa membocorkan nilai)"). Exits non-zero on any failure. None of
 * the public-routing vars above are secrets, but they follow the same
 * name-only reporting style for consistency.
 */
import { checkSyncHmacSecretNotDefault } from "./security-readiness";
import {
  EMAIL_MAILKETING_REQUIRED_WHEN_SELECTED,
  EMAIL_REQUIRED_WHEN_ENABLED,
  isKnownEmailProvider
} from "../src/modules/email/domain/email-config";

export type EnvCheckResult = {
  name: string;
  status: "pass" | "fail";
  detail: string;
};

const REQUIRED_NON_EMPTY_VARS = [
  "APP_ENV",
  "APP_URL",
  "APP_TIMEZONE",
  "DATABASE_URL",
  "AUTH_JWT_SECRET"
] as const;

const R2_REQUIRED_WHEN_ENABLED = [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET"
] as const;

/**
 * The four documented public tenant resolution modes (Issue #556, epic
 * #555). See the file header comment §5 for what each mode requires.
 */
const PUBLIC_TENANT_RESOLUTION_MODES = [
  "host_default",
  "env_default",
  "setup_default",
  "tenant_code_legacy"
] as const;

type PublicTenantResolutionMode =
  (typeof PUBLIC_TENANT_RESOLUTION_MODES)[number];

function isKnownPublicTenantResolutionMode(
  value: string
): value is PublicTenantResolutionMode {
  return (PUBLIC_TENANT_RESOLUTION_MODES as readonly string[]).includes(value);
}

function isSet(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Absolute-path check for PUBLIC_CANONICAL_BASE_PATH: leading "/", no
 * whitespace, no "//" collapse, and no trailing slash unless the whole
 * value is the root "/" itself.
 */
function isValidCanonicalBasePath(value: string): boolean {
  if (!value.startsWith("/")) return false;
  if (/\s/.test(value)) return false;
  if (value.includes("//")) return false;
  if (value.length > 1 && value.endsWith("/")) return false;
  return true;
}

function checkPublicCanonicalBasePath(env: NodeJS.ProcessEnv): EnvCheckResult {
  const name = "PUBLIC_CANONICAL_BASE_PATH";
  const raw = env.PUBLIC_CANONICAL_BASE_PATH;

  if (!isSet(raw)) {
    return {
      name,
      status: "pass",
      detail: `${name} is not set — defaults to /news.`
    };
  }

  const value = (raw as string).trim();

  if (isValidCanonicalBasePath(value)) {
    return {
      name,
      status: "pass",
      detail: `${name} is a valid absolute path.`
    };
  }

  return {
    name,
    status: "fail",
    detail: `${name} must be an absolute path starting with "/" (no whitespace, no "//", no trailing slash unless it is exactly "/").`
  };
}

export function checkRequiredVars(
  env: NodeJS.ProcessEnv = process.env
): EnvCheckResult[] {
  return REQUIRED_NON_EMPTY_VARS.map((name) => {
    if (isSet(env[name])) {
      return { name, status: "pass", detail: `${name} is set.` };
    }

    return {
      name,
      status: "fail",
      detail: `${name} is required but missing or empty.`
    };
  });
}

export function checkSyncConfig(
  env: NodeJS.ProcessEnv = process.env
): EnvCheckResult {
  const name = "AWCMS_MINI_SYNC_HMAC_SECRET (conditional on sync enabled)";

  if (env.AWCMS_MINI_SYNC_ENABLED !== "true") {
    return {
      name,
      status: "pass",
      detail:
        'AWCMS_MINI_SYNC_ENABLED is not "true" — sync HMAC secret not required.'
    };
  }

  // Reuses the exact same placeholder-detection function security-readiness
  // uses (Issue 10.3) — do not re-implement this comparison a second way.
  const result = checkSyncHmacSecretNotDefault(env);

  if (result.status === "fail") {
    return {
      name,
      status: "fail",
      detail:
        "AWCMS_MINI_SYNC_ENABLED=true but AWCMS_MINI_SYNC_HMAC_SECRET is unset or still the documented placeholder."
    };
  }

  return {
    name,
    status: "pass",
    detail:
      "AWCMS_MINI_SYNC_ENABLED=true and AWCMS_MINI_SYNC_HMAC_SECRET has been changed from its documented placeholder."
  };
}

export function checkR2Config(
  env: NodeJS.ProcessEnv = process.env
): EnvCheckResult[] {
  if (env.R2_ENABLED !== "true") {
    return [
      {
        name: "R2 credentials (conditional on R2 enabled)",
        status: "pass",
        detail: 'R2_ENABLED is not "true" — R2 credentials not required.'
      }
    ];
  }

  return R2_REQUIRED_WHEN_ENABLED.map((name) => {
    if (isSet(env[name])) {
      return { name, status: "pass", detail: `${name} is set.` };
    }

    return {
      name,
      status: "fail",
      detail: `R2_ENABLED=true but ${name} is missing or empty.`
    };
  });
}

export function checkEmailConfig(
  env: NodeJS.ProcessEnv = process.env
): EnvCheckResult[] {
  if (env.EMAIL_ENABLED !== "true") {
    return [
      {
        name: "Email config (conditional on EMAIL_ENABLED)",
        status: "pass",
        detail: 'EMAIL_ENABLED is not "true" — email config not required.'
      }
    ];
  }

  const results: EnvCheckResult[] = EMAIL_REQUIRED_WHEN_ENABLED.map((name) => {
    if (isSet(env[name])) {
      return { name, status: "pass", detail: `${name} is set.` };
    }

    return {
      name,
      status: "fail",
      detail: `EMAIL_ENABLED=true but ${name} is missing or empty.`
    };
  });

  const provider = env.EMAIL_PROVIDER;

  if (!isKnownEmailProvider(provider)) {
    results.push({
      name: "EMAIL_PROVIDER",
      status: "fail",
      detail:
        'EMAIL_ENABLED=true but EMAIL_PROVIDER is missing or not a known provider ("mailketing").'
    });
    return results;
  }

  results.push({
    name: "EMAIL_PROVIDER",
    status: "pass",
    detail: `EMAIL_PROVIDER is a known provider (${provider}).`
  });

  if (provider === "mailketing") {
    for (const name of EMAIL_MAILKETING_REQUIRED_WHEN_SELECTED) {
      if (isSet(env[name])) {
        results.push({ name, status: "pass", detail: `${name} is set.` });
        continue;
      }

      results.push({
        name,
        status: "fail",
        detail: `EMAIL_PROVIDER=mailketing but ${name} is missing or empty.`
      });
    }
  }

  return results;
}

export function checkPublicRoutingConfig(
  env: NodeJS.ProcessEnv = process.env
): EnvCheckResult[] {
  const results: EnvCheckResult[] = [];
  const rawMode = env.PUBLIC_TENANT_RESOLUTION_MODE;

  if (!isSet(rawMode)) {
    results.push({
      name: "PUBLIC_TENANT_RESOLUTION_MODE",
      status: "pass",
      detail:
        "PUBLIC_TENANT_RESOLUTION_MODE is not set — offline/LAN deployments keep today's legacy /blog/{tenantCode} behavior; no public-host config is required."
    });
    results.push(checkPublicCanonicalBasePath(env));
    return results;
  }

  const mode = (rawMode as string).trim();

  if (!isKnownPublicTenantResolutionMode(mode)) {
    results.push({
      name: "PUBLIC_TENANT_RESOLUTION_MODE",
      status: "fail",
      detail: `PUBLIC_TENANT_RESOLUTION_MODE must be one of ${PUBLIC_TENANT_RESOLUTION_MODES.join(", ")}; got "${mode}".`
    });
    // Unknown mode — cross-field rules below are meaningless for it.
    results.push(checkPublicCanonicalBasePath(env));
    return results;
  }

  results.push({
    name: "PUBLIC_TENANT_RESOLUTION_MODE",
    status: "pass",
    detail: `PUBLIC_TENANT_RESOLUTION_MODE is a known mode (${mode}).`
  });

  if (mode === "host_default") {
    if (isSet(env.PUBLIC_PLATFORM_ROOT_DOMAIN)) {
      results.push({
        name: "PUBLIC_PLATFORM_ROOT_DOMAIN",
        status: "pass",
        detail: "PUBLIC_PLATFORM_ROOT_DOMAIN is set."
      });
    } else {
      results.push({
        name: "PUBLIC_PLATFORM_ROOT_DOMAIN",
        status: "fail",
        detail:
          "PUBLIC_TENANT_RESOLUTION_MODE=host_default but PUBLIC_PLATFORM_ROOT_DOMAIN is missing or empty — the host-based resolver (Issue #559) needs a root domain to tell tenant subdomains apart from unrelated hosts."
      });
    }
  }

  if (mode === "env_default") {
    const hasId = isSet(env.PUBLIC_DEFAULT_TENANT_ID);
    const hasCode = isSet(env.PUBLIC_DEFAULT_TENANT_CODE);

    if (hasId || hasCode) {
      results.push({
        name: "PUBLIC_DEFAULT_TENANT_ID or PUBLIC_DEFAULT_TENANT_CODE",
        status: "pass",
        detail:
          "At least one of PUBLIC_DEFAULT_TENANT_ID/PUBLIC_DEFAULT_TENANT_CODE is set."
      });
    } else {
      results.push({
        name: "PUBLIC_DEFAULT_TENANT_ID or PUBLIC_DEFAULT_TENANT_CODE",
        status: "fail",
        detail:
          "PUBLIC_TENANT_RESOLUTION_MODE=env_default requires at least one of PUBLIC_DEFAULT_TENANT_ID or PUBLIC_DEFAULT_TENANT_CODE to be set."
      });
    }
  }

  // mode === "setup_default" | "tenant_code_legacy": no extra required var.

  results.push(checkPublicCanonicalBasePath(env));

  return results;
}

export function runEnvValidation(
  env: NodeJS.ProcessEnv = process.env
): EnvCheckResult[] {
  return [
    ...checkRequiredVars(env),
    checkSyncConfig(env),
    ...checkR2Config(env),
    ...checkEmailConfig(env),
    ...checkPublicRoutingConfig(env)
  ];
}

function printReport(results: EnvCheckResult[]): boolean {
  console.log("config:validate — environment variable validation (doc 18)");
  console.log("");

  for (const result of results) {
    const label = result.status === "pass" ? "PASS" : "FAIL";
    console.log(`[${label}] ${result.name}\n    ${result.detail}`);
  }

  const failed = results.filter((result) => result.status === "fail");

  console.log("");

  if (failed.length > 0) {
    console.log(
      `config:validate FAILED — ${failed.length} check(s) failed: ${failed
        .map((result) => result.name)
        .join(", ")}.`
    );
    return false;
  }

  console.log(`config:validate OK — ${results.length} check(s) passed.`);
  return true;
}

async function main() {
  const results = runEnvValidation();
  const passed = printReport(results);

  if (!passed) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
