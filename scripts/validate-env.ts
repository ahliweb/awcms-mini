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
 *
 * Never prints actual secret values — only which variable name is
 * missing/invalid (doc 18: "Var wajib hilang → gagal start dengan pesan
 * jelas (tanpa membocorkan nilai)"). Exits non-zero on any failure.
 */
import { checkSyncHmacSecretNotDefault } from "./security-readiness";

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

function isSet(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
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

export function runEnvValidation(
  env: NodeJS.ProcessEnv = process.env
): EnvCheckResult[] {
  return [
    ...checkRequiredVars(env),
    checkSyncConfig(env),
    ...checkR2Config(env)
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
