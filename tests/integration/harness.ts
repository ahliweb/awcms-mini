/**
 * Integration-test harness (recommendation: real-Postgres HTTP-level tests).
 *
 * The rest of the `bun test` suite is pure-unit + migration-shape assertions —
 * nothing there issues a real request or touches a database, so an endpoint's
 * actual wiring (auth -> ABAC -> transaction -> RLS -> response envelope) is
 * only ever exercised by manual live verification. These integration tests
 * close that gap: they call the real Astro route handlers against a real
 * PostgreSQL, guarding the wiring the unit suite structurally cannot.
 *
 * Gating: the whole integration suite is SKIPPED unless `DATABASE_URL` is set
 * (see `integrationEnabled`), so `bun test` locally without a database stays
 * green and the pure-unit suite is unaffected. CI sets `DATABASE_URL` to a
 * Postgres service and runs `bun run db:migrate` before `bun test`, so the
 * integration suite runs there.
 *
 * Two connection roles (mirrors production after the RLS-enforcement change):
 * the `DATABASE_URL` passed in is the PRIVILEGED (owner/superuser) role, used
 * for migrations, per-test truncation, and cross-tenant fixture seeding. The
 * ROUTE HANDLERS, however, must run as the least-privilege `awcms_mini_app`
 * role so that FORCE'd RLS is actually enforced (a superuser bypasses RLS). So
 * `provisionAppRole()` activates that role's login and repoints `DATABASE_URL`
 * at it before any handler runs — `getDatabaseClient()` (and thus every
 * handler) then connects least-privilege, exactly like the deployed app.
 */
import type { APIContext, APIRoute } from "astro";

import { getDatabaseClient } from "../../src/lib/database/client";

// Captured at module load, before provisionAppRole() repoints DATABASE_URL.
const ADMIN_DATABASE_URL = process.env.DATABASE_URL ?? "";

// Non-secret fixture password for the least-privilege app role in tests.
const APP_ROLE_TEST_PASSWORD = "integration_app_role_password";

export const integrationEnabled = ADMIN_DATABASE_URL.length > 0;

let adminSql: Bun.SQL | undefined;

/**
 * Privileged (owner/superuser) client — migrations, truncation, and fixture
 * seeding that needs to bypass RLS. Independent of the DATABASE_URL repoint
 * that `provisionAppRole()` does for handlers.
 */
export function getAdminSql(): Bun.SQL {
  if (!adminSql) {
    adminSql = new Bun.SQL(ADMIN_DATABASE_URL);
  }
  return adminSql;
}

/**
 * The client the route handlers use — the least-privilege `awcms_mini_app`
 * role after `provisionAppRole()` has repointed `DATABASE_URL`. Shares the
 * app's own lazy singleton, so tests and handlers use the same connection.
 */
export function getTestSql(): Bun.SQL {
  return getDatabaseClient();
}

/**
 * Ensures the schema is present by running the real migration runner
 * (`scripts/db-migrate.ts`) as a subprocess — the same runner CI and operators
 * use, not a reimplemented apply loop. Always runs as the PRIVILEGED role
 * (migrations create the app role, FORCE RLS, and GRANT — owner-only ops),
 * regardless of any later DATABASE_URL repoint. Idempotent.
 */
export async function applyMigrations(): Promise<void> {
  const proc = Bun.spawn(["bun", "scripts/db-migrate.ts"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, DATABASE_URL: ADMIN_DATABASE_URL }
  });
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`db:migrate failed (exit ${exitCode}): ${stderr}`);
  }
}

/**
 * Activates the least-privilege `awcms_mini_app` role's login (migration 013
 * created it NOLOGIN/passwordless) with a test password, then repoints
 * `DATABASE_URL` at it so `getDatabaseClient()` — and therefore every route
 * handler — connects as the least-privilege role, exactly like the deployed
 * app. `getAdminSql()` keeps its own privileged connection. Must run after
 * `applyMigrations()` and before the first handler call.
 */
export async function provisionAppRole(): Promise<void> {
  await getAdminSql().unsafe(
    `ALTER ROLE awcms_mini_app WITH LOGIN PASSWORD '${APP_ROLE_TEST_PASSWORD}'`
  );

  const appUrl = new URL(ADMIN_DATABASE_URL);
  appUrl.username = "awcms_mini_app";
  appUrl.password = APP_ROLE_TEST_PASSWORD;
  process.env.DATABASE_URL = appUrl.toString();
}

/**
 * Truncates every tenant/runtime table between tests for isolation, while
 * preserving the two things migrations own: `awcms_mini_schema_migrations`
 * (the runner's ledger) and `awcms_mini_permissions` (the global ABAC seed
 * catalog, INSERTed by migrations and copied into the owner role by the setup
 * wizard — truncating it would break every access check). `RESTART IDENTITY
 * CASCADE` resets identity sequences and follows FKs so order doesn't matter.
 * Truncating `awcms_mini_setup_state` resets the singleton setup lock so each
 * test can bootstrap a fresh tenant.
 */
export async function resetDatabase(): Promise<void> {
  const sql = getAdminSql();
  const rows = (await sql`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename LIKE 'awcms_mini_%'
      AND tablename NOT IN ('awcms_mini_schema_migrations', 'awcms_mini_permissions')
  `) as { tablename: string }[];

  if (rows.length === 0) {
    return;
  }

  const list = rows.map((row) => `"${row.tablename}"`).join(", ");
  await sql.unsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

// ---------------------------------------------------------------------------
// Minimal cookie jar (only login/logout use cookies) — backed by a Map so
// values set by one handler can be read back by another within a test.
// ---------------------------------------------------------------------------

export type CookieJar = {
  get(name: string): { value: string } | undefined;
  set(name: string, value: string, options?: unknown): void;
  delete(name: string, options?: unknown): void;
  has(name: string): boolean;
};

export function createCookieJar(): CookieJar {
  const store = new Map<string, string>();

  return {
    get: (name) =>
      store.has(name) ? { value: store.get(name) as string } : undefined,
    set: (name, value) => {
      store.set(name, value);
    },
    delete: (name) => {
      store.delete(name);
    },
    has: (name) => store.has(name)
  };
}

// ---------------------------------------------------------------------------
// Route invocation — build a real Request + minimal Astro context and call the
// handler directly (no running server / no build needed).
// ---------------------------------------------------------------------------

export type InvokeOptions = {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: unknown;
  params?: Record<string, string>;
  locals?: Record<string, unknown>;
  cookies?: CookieJar;
};

export type InvokeResult<T = unknown> = {
  status: number;
  body: T;
  response: Response;
};

/**
 * Calls an Astro `APIRoute` handler with a synthetic context. Only the fields
 * handlers actually destructure are provided (`request`, `params`, `locals`,
 * `url`, `cookies`); the single `as unknown as APIContext` cast is
 * centralized here so no test file needs it.
 */
export async function invoke<T = unknown>(
  handler: APIRoute,
  options: InvokeOptions = {}
): Promise<InvokeResult<T>> {
  const method = options.method ?? "GET";
  const path = options.path ?? "/";
  const url = new URL(`http://integration.test${path}`);

  const hasBody = options.body !== undefined && method !== "GET";
  const request = new Request(url.toString(), {
    method,
    headers: options.headers,
    body: hasBody ? JSON.stringify(options.body) : undefined
  });

  const context = {
    request,
    url,
    params: options.params ?? {},
    locals: options.locals ?? {},
    cookies: options.cookies ?? createCookieJar()
  } as unknown as APIContext;

  const response = await handler(context);
  const text = await response.text();
  const body = text.length > 0 ? (JSON.parse(text) as T) : (undefined as T);

  return { status: response.status, body, response };
}
