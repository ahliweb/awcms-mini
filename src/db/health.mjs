import { sql } from "kysely";

import { getRuntimeConfig } from "../config/runtime.mjs";
import { classifyDatabaseError } from "./errors.mjs";
import { createDatabase } from "./index.mjs";

function summarizeDirectDatabaseTarget(databaseUrl) {
  try {
    const parsed = new URL(databaseUrl);
    const databaseName = parsed.pathname.replace(/^\//, "") || null;

    return {
      source: "DATABASE_URL",
      hostname: parsed.hostname || null,
      port: parsed.port ? Number(parsed.port) : 5432,
      database: databaseName,
      sslmode: parsed.searchParams.get("sslmode") || null,
    };
  } catch {
    return {
      source: "DATABASE_URL",
      hostname: null,
      port: null,
      database: null,
      sslmode: null,
    };
  }
}

export function describeDatabaseHealthPosture(runtimeConfig = getRuntimeConfig()) {
  if (runtimeConfig.databaseTransport === "hyperdrive") {
    return {
      transport: "hyperdrive",
      runtimeTarget: runtimeConfig.runtimeTarget,
      source: "Cloudflare Hyperdrive binding",
      binding: runtimeConfig.hyperdriveBinding,
    };
  }

  return {
    transport: "direct",
    runtimeTarget: runtimeConfig.runtimeTarget,
    ...summarizeDirectDatabaseTarget(runtimeConfig.databaseUrl),
  };
}

export async function checkDatabaseHealth() {
  const db = createDatabase();

  try {
    await sql`select 1`.execute(db);

    return {
      ok: true,
      kind: null,
      message: "database reachable",
    };
  } catch (error) {
    return {
      ok: false,
      kind: classifyDatabaseError(error),
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await db.destroy();
  }
}
