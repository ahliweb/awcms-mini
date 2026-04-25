import { spawnSync } from "node:child_process";

import {
  applyLocalCloudflareRuntimeEnv,
  assertRequiredWorkerSecretsPresent,
  cleanupGeneratedCloudflareLocalSecretFiles,
  loadLocalEnvFiles,
} from "./_local-env.mjs";

loadLocalEnvFiles();
applyLocalCloudflareRuntimeEnv();
assertRequiredWorkerSecretsPresent();

const [, , command, ...args] = process.argv;

if (!command) {
  console.error("Usage: node ./scripts/run-with-local-env.mjs <command> [...args]");
  process.exit(1);
}

const shouldCleanupGeneratedCloudflareSecrets = command === "astro" && args[0] === "build";

async function main() {
  let result;

  try {
    result = spawnSync(command, args, {
      stdio: "inherit",
      env: process.env,
    });
  } finally {
    if (shouldCleanupGeneratedCloudflareSecrets) {
      await cleanupGeneratedCloudflareLocalSecretFiles();
    }
  }

  if (result?.error) {
    throw result.error;
  }

  process.exit(result?.status ?? 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
