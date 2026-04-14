import { sql } from "kysely";

import { classifyDatabaseError } from "./errors.mjs";
import { createDatabase } from "./index.mjs";

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
