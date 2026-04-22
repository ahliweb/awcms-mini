import { spawnSync } from "node:child_process";

import { loadLocalEnvFiles } from "./_local-env.mjs";

function normalizeOptionalString(value) {
  if (typeof value !== "string") {
    return null;
  }

  const next = value.trim();
  return next.length > 0 ? next : null;
}

function resolveVerificationBaseUrl(env = process.env) {
  return normalizeOptionalString(process.argv[2]) || normalizeOptionalString(env.SMOKE_TEST_BASE_URL) || normalizeOptionalString(env.SITE_URL);
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
  const baseUrl = resolveVerificationBaseUrl();

  if (!baseUrl) {
    throw new Error("Set SITE_URL or SMOKE_TEST_BASE_URL, or pass a base URL as the first argument.");
  }

  runStep("Database posture healthcheck", "node", ["./scripts/healthcheck.mjs"], process.env);
  runStep("EmDash compatibility verify", "node", ["./scripts/db-migrate.mjs", "emdash-verify"], process.env);
  runStep("Cloudflare admin smoke", "node", ["./scripts/smoke-cloudflare-admin.mjs", baseUrl], process.env);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
