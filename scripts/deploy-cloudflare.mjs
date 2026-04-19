import { spawnSync } from "node:child_process";

import { loadLocalEnvFiles } from "./_local-env.mjs";

function run(command, args, env, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env,
    ...options,
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }

  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }

  return result.stdout ?? "";
}

function extractVersionId(output) {
  const match = output.match(/Worker Version ID:\s+([a-f0-9-]+)/i);
  if (!match) {
    throw new Error("Could not determine uploaded Worker version ID");
  }

  return match[1];
}

loadLocalEnvFiles();

if (
  process.env.DATABASE_TRANSPORT === "hyperdrive"
  && process.env.DATABASE_URL
  && !process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE
) {
  process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE = process.env.DATABASE_URL;
}

run("pnpm", ["build"], process.env);

const uploadOutput = run(
  "npx",
  ["wrangler", "versions", "upload", "--message", "route-safe deploy"],
  process.env,
);

const versionId = extractVersionId(uploadOutput);

run(
  "npx",
  [
    "wrangler",
    "versions",
    "deploy",
    `${versionId}@100%`,
    "--name",
    "awcms-mini",
    "--message",
    "route-safe deploy",
    "--yes",
  ],
  process.env,
);
