import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createDatabase } from "../src/db/client/postgres.mjs";
import { importAdministrativeRegions } from "../src/db/importers/administrative-regions.mjs";
import { loadLocalEnvFiles } from "./_local-env.mjs";

function printUsage() {
  console.log("Usage: node scripts/db-seed-administrative-regions.mjs [path-to-json]");
}

async function main() {
  loadLocalEnvFiles();

  const argument = process.argv[2];

  if (argument === "--help" || argument === "-h") {
    printUsage();
    return;
  }

  const filePath = resolve(argument ?? "src/db/data/administrative-regions.seed.json");
  const contents = readFileSync(filePath, "utf8");
  const records = JSON.parse(contents);
  const db = createDatabase();

  try {
    const result = await importAdministrativeRegions({ database: db, records });
    console.log(`Imported ${result.total} administrative regions (${result.created} created, ${result.updated} updated).`);
  } finally {
    await db.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
