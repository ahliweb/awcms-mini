import { log } from "../logging/logger";

type ClientKind = "app" | "worker" | "setup";

const sharedClients = new Map<ClientKind, Bun.SQL>();

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
function buildClient(databaseUrl: string, kind: ClientKind): Bun.SQL {
  const poolMax = Number(process.env.DATABASE_POOL_MAX ?? DEFAULT_POOL_MAX);
  const statementTimeoutMs = Number(
    process.env.DATABASE_STATEMENT_TIMEOUT_MS ?? DEFAULT_STATEMENT_TIMEOUT_MS
  );
  const usePgBouncer = process.env.DATABASE_PGBOUNCER === "true";

  return new Bun.SQL(databaseUrl, {
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
          clientKind: kind,
          error: err.message
        });
      }
    }
  });
}

/**
 * Issue #683 (epic #679, platform-hardening) — each named client kind maps
 * to its own least-privilege Postgres role (`sql/045_awcms_mini_db_role_
 * separation.sql`): `app` -> `awcms_mini_app` (`DATABASE_URL`, unchanged
 * name/var for backward compatibility), `worker` -> `awcms_mini_worker`
 * (`WORKER_DATABASE_URL`), `setup` -> `awcms_mini_setup`
 * (`SETUP_DATABASE_URL`). `worker`/`setup` fall back to `DATABASE_URL` (the
 * `app` connection) when their own env var isn't set — small/offline
 * deployments that don't want to manage 3 connection strings can still run
 * everything through the single narrowed `awcms_mini_app` role; operators
 * who want the extra defense-in-depth isolation set the dedicated vars.
 * Each kind gets its OWN lazily-created, memoized `Bun.SQL` pool — never
 * shared across kinds, even when they resolve to the same URL by fallback
 * (simpler than trying to dedupe pools by URL, and pool-per-kind is cheap:
 * `Bun.SQL` pools are lazy, an unused one opens zero connections).
 */
function getNamedDatabaseClient(kind: ClientKind): Bun.SQL {
  const existing = sharedClients.get(kind);

  if (existing) {
    return existing;
  }

  const envVarName =
    kind === "app"
      ? "DATABASE_URL"
      : kind === "worker"
        ? "WORKER_DATABASE_URL"
        : "SETUP_DATABASE_URL";
  const databaseUrl = process.env[envVarName] ?? process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error(
      `${envVarName} (or DATABASE_URL as a fallback) is required to connect to the database.`
    );
  }

  const client = buildClient(databaseUrl, kind);
  sharedClients.set(kind, client);
  return client;
}

/** The "web runtime" connection (`awcms_mini_app`) — every ordinary HTTP request. */
export function getDatabaseClient(): Bun.SQL {
  return getNamedDatabaseClient("app");
}

/** The "background worker" connection (`awcms_mini_worker`) — the 7 unattended cron-style scripts with no corresponding web endpoint (see migration 045's header for the exact list). Falls back to `DATABASE_URL` if `WORKER_DATABASE_URL` isn't set. */
export function getWorkerDatabaseClient(): Bun.SQL {
  return getNamedDatabaseClient("worker");
}

/** The "bootstrap/setup" connection (`awcms_mini_setup`) — used ONLY by `tenant-admin/application/platform-bootstrap.ts`'s one-time setup wizard. Falls back to `DATABASE_URL` if `SETUP_DATABASE_URL` isn't set. */
export function getSetupDatabaseClient(): Bun.SQL {
  return getNamedDatabaseClient("setup");
}
