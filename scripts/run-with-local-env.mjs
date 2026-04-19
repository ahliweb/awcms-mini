import { spawnSync } from "node:child_process";

import { applyLocalCloudflareRuntimeEnv, loadLocalEnvFiles } from "./_local-env.mjs";

loadLocalEnvFiles();
applyLocalCloudflareRuntimeEnv();

const [, , command, ...args] = process.argv;

if (!command) {
  console.error("Usage: node ./scripts/run-with-local-env.mjs <command> [...args]");
  process.exit(1);
}

const result = spawnSync(command, args, {
  stdio: "inherit",
  env: process.env,
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
