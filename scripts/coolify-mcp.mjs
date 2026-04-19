import { spawn } from "node:child_process";

import { loadLocalEnvFiles } from "./_local-env.mjs";

loadLocalEnvFiles();

if (!process.env.COOLIFY_BASE_URL) {
  process.env.COOLIFY_BASE_URL = "https://app.coolify.io";
}

if (!process.env.COOLIFY_ACCESS_TOKEN) {
  console.error("COOLIFY_ACCESS_TOKEN must be set in .env.local or the environment");
  process.exit(1);
}

const child = spawn("npx", ["-y", "@masonator/coolify-mcp"], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});
