/**
 * CLI kesehatan pool database: `bun scripts/db-pool-health.ts`.
 * Exit non-zero bila status down.
 */
import { checkPoolHealth } from "../src/lib/database/pool-health";
import { closeSql } from "../src/lib/database/db";

async function main(): Promise<void> {
  const health = await checkPoolHealth();
  console.log(JSON.stringify(health, null, 2));
  if (health.status === "down") process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeSql());
