import { existsSync } from "node:fs";

import { checkDatabaseHealth } from "../src/db/health.mjs";

function loadLocalEnvFiles() {
  if (typeof process.loadEnvFile !== "function") {
    return;
  }

  for (const file of [".env", ".env.local"]) {
    if (existsSync(file)) {
      process.loadEnvFile(file);
    }
  }
}

async function main() {
  loadLocalEnvFiles();
  const database = await checkDatabaseHealth();
  const result = {
    ok: database.ok,
    service: "awcms-mini",
    checks: {
      app: {
        ok: true,
        message: "runtime validation script executed",
      },
      database,
    },
    timestamp: new Date().toISOString(),
  };

  console.log(JSON.stringify(result, null, 2));

  if (!database.ok) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
