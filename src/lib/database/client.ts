import { log } from "../logging/logger";

let sharedClient: Bun.SQL | undefined;

const DEFAULT_POOL_MAX = 20;
const DEFAULT_STATEMENT_TIMEOUT_MS = 15000;

/**
 * Issue 10.2 pool config. `Bun.SQL` itself only understands a flat
 * connection pool (`max`); it has no notion of "work class" — that
 * concurrency gate lives in `work-class.ts` and sits in front of this
 * client. This module only wires:
 *
 * - `max` — pool size, from `DATABASE_POOL_MAX` (doc 16 §Connection pooling).
 * - `prepare` — disabled when `DATABASE_PGBOUNCER=true`, since automatic
 *   prepared statements are unsafe/ineffective behind PgBouncer transaction
 *   mode (doc 16, `docs/awcms-mini/database-pooling.md`).
 * - `connection.statement_timeout` — sets the session-level
 *   `statement_timeout` GUC on every new pooled connection. NOTE: per
 *   `node_modules/bun-types/sql.d.ts`, `onconnect` on `Bun.SQL.Options` is
 *   typed `(err: Error | null) => void` — it only reports connect
 *   success/failure, it does not hand back a client to run SQL against (the
 *   `onconnect: (client) => ...` shown in that same file's own JSDoc example
 *   is inconsistent with the actual signature). The documented, type-correct
 *   way to apply a per-connection session GUC like `statement_timeout` is
 *   the `connection` option ("Postgres client runtime configuration
 *   options", see postgresql.org/docs/current/runtime-config-client.html),
 *   which Bun applies to every pooled connection at connect time. `onconnect`
 *   is still used below, only to log connection failures.
 */
export function getDatabaseClient(): Bun.SQL {
  if (!sharedClient) {
    const databaseUrl = process.env.DATABASE_URL;

    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required to connect to the database.");
    }

    const poolMax = Number(process.env.DATABASE_POOL_MAX ?? DEFAULT_POOL_MAX);
    const statementTimeoutMs = Number(
      process.env.DATABASE_STATEMENT_TIMEOUT_MS ?? DEFAULT_STATEMENT_TIMEOUT_MS
    );
    const usePgBouncer = process.env.DATABASE_PGBOUNCER === "true";

    sharedClient = new Bun.SQL(databaseUrl, {
      max: Number.isFinite(poolMax) && poolMax > 0 ? poolMax : DEFAULT_POOL_MAX,
      prepare: !usePgBouncer,
      connection: {
        statement_timeout:
          Number.isFinite(statementTimeoutMs) && statementTimeoutMs > 0
            ? statementTimeoutMs
            : DEFAULT_STATEMENT_TIMEOUT_MS
      },
      onconnect: (err) => {
        if (err) {
          log("error", "database.connection.failed", {
            moduleKey: "database-connectivity",
            error: err.message
          });
        }
      }
    });
  }

  return sharedClient;
}
