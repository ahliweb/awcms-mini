import { spawnSync } from "node:child_process";

import { applyLocalCloudflareRuntimeEnv, loadLocalEnvFiles } from "./_local-env.mjs";

const DEFAULT_LIVE_RUNTIME_EXPECTATIONS = {
  DATABASE_TRANSPORT: "hyperdrive",
  HYPERDRIVE_BINDING: "HYPERDRIVE",
  MINI_RUNTIME_TARGET: "cloudflare",
  HEALTHCHECK_EXPECT_DATABASE_TRANSPORT: "hyperdrive",
  HEALTHCHECK_EXPECT_HYPERDRIVE_BINDING: "HYPERDRIVE",
};

function normalizeOptionalString(value) {
  if (typeof value !== "string") {
    return null;
  }

  const next = value.trim();
  return next.length > 0 ? next : null;
}

function resolveCliBaseUrlArg(argv = process.argv) {
  for (const value of argv.slice(2)) {
    if (value === "--") {
      continue;
    }

    return value;
  }

  return null;
}

function resolveVerificationBaseUrl(env = process.env) {
  return normalizeOptionalString(resolveCliBaseUrlArg()) || normalizeOptionalString(env.SMOKE_TEST_BASE_URL) || normalizeOptionalString(env.SITE_URL);
}

function buildLiveRuntimeEnv(env = process.env) {
  const verificationEnv = {
    ...DEFAULT_LIVE_RUNTIME_EXPECTATIONS,
    ...env,
  };

  applyLocalCloudflareRuntimeEnv(verificationEnv);
  return verificationEnv;
}

function shouldRunLocalEmdashVerify(env = process.env) {
  const value = normalizeOptionalString(env.VERIFY_LIVE_RUNTIME_INCLUDE_LOCAL_EMDASH_VERIFY);
  return value === "1" || value === "true";
}

function runStep(label, command, args, env) {
  console.log(`== ${label} ==`);

  const result = spawnSync(command, args, {
    encoding: "utf8",
    env,
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }

  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  if ((result.status ?? 1) !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? 1}`);
  }
}

async function main() {
  loadLocalEnvFiles();
  const verificationEnv = buildLiveRuntimeEnv();
  const baseUrl = resolveVerificationBaseUrl(verificationEnv);

  if (!baseUrl) {
    throw new Error("Set SITE_URL or SMOKE_TEST_BASE_URL, or pass a base URL as the first argument.");
  }

  runStep("Deployed runtime health", "node", ["./scripts/smoke-deployed-runtime-health.mjs", baseUrl], verificationEnv);
  runStep("Cloudflare admin smoke", "node", ["./scripts/smoke-cloudflare-admin.mjs", baseUrl], verificationEnv);

  if (shouldRunLocalEmdashVerify(verificationEnv)) {
    runStep("Local EmDash compatibility verify", "node", ["./scripts/db-migrate.mjs", "emdash-verify"], verificationEnv);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
