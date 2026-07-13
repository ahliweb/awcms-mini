/**
 * security-readiness.ts — `bun run security:readiness`.
 *
 * Issue 10.3 (doc 07 §Production readiness checklist "Security", doc 20
 * threat model, ADR-0003 RLS, ADR-0004 RBAC/ABAC, ADR-0005 immutability, and
 * skill `awcms-mini-production-preflight`). Runs a fixed list of named
 * security checks against the REAL codebase/database/environment — every
 * check below is backed by a real signal (a DB query, a grep over tracked
 * source files, a call into a real domain function, or an env var read).
 * None of them are hardcoded to "pass".
 *
 * Gate rule (matches the skill's go-live diagram exactly): any `critical`
 * check with `status: "fail"` blocks go-live — exit code is non-zero.
 * `warning`/`info` findings are printed but never block.
 *
 * ## Scope note — generic base vs. domain examples
 *
 * Doc 07's full checklist and doc 20's threat model both illustrate example
 * checklist items using AWPOS/retail domain specifics (tax data masking,
 * CRM opt-out, AI read-only, POS smoke test) and infrastructure/deployment
 * specifics (PostgreSQL not publicly exposed, least-privilege DB user,
 * backup/restore tested, PostgreSQL version pinned). This generic base has
 * no tax/CRM/AI/POS modules, and no `docker-compose.yml`/deployment profile
 * yet (reserved for Issue 12.2, still open) — those items are listed in
 * `OUT_OF_SCOPE_ITEMS` below with a documented reason instead of being
 * silently dropped or force-fit into a fake automated check.
 */
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

import { getDatabaseClient } from "../src/lib/database/client";
import { assertUuid } from "../src/lib/database/tenant-context";
import { evaluateAccess } from "../src/modules/identity-access/domain/access-control";
import { evaluateLoginAttempt } from "../src/modules/identity-access/domain/login-policy";
import { hashPassword } from "../src/lib/auth/password";
import { resolveAppBaseUrl } from "./lib/app-url";
import { checkRateLimit } from "../src/lib/security/rate-limit";
import {
  countEligibleBreakGlassIdentities,
  getTenantAuthPolicy
} from "../src/modules/identity-access/application/tenant-auth-policy";
import {
  checkEmailConfig,
  checkGoogleOidcConfig,
  checkMfaConfig,
  checkOnlineAuthSecurityConfig,
  checkSsoConfig,
  checkTurnstileConfig
} from "./validate-env";
import { resolveVisitorAnalyticsConfig } from "../src/modules/visitor-analytics/domain/visitor-analytics-config";
import {
  allowsSvgMimeType,
  findNewsMediaR2PublicBaseUrlProductionUnsafeReason,
  resolveNewsMediaR2Config
} from "../src/modules/news-portal/domain/news-media-r2-config";
import { evaluateNewsPortalFullOnlineR2Readiness } from "../src/modules/news-portal/domain/news-portal-preset-readiness";
import { isSocialPublishingEnabled } from "../src/modules/social-publishing/domain/social-publishing-config";
import { isTelegramProviderEnabled } from "../src/modules/social-publishing/domain/telegram-config";
import { getSocialProviderAdapter } from "../src/modules/social-publishing/infrastructure/social-provider-registry";
import {
  isMetaProviderEnabled,
  loadMetaProviderConfig
} from "../src/modules/social-publishing/domain/meta-provider-config";
// Issue #646 — side-effect import registers the real Telegram adapter into
// the registry `checkSocialPublishingProviderReadiness` (below) checks
// against, for this process. Meta's own adapters (Issue #644) are already
// registered unconditionally by `social-provider-registry.ts` itself (see
// that file's own trailing registration block) — no equivalent side-effect
// import is needed for Meta here.
import "../src/modules/social-publishing/infrastructure/telegram-provider-registration";

export type CheckSeverity = "critical" | "warning" | "info";
export type CheckStatus = "pass" | "fail";

export type SecurityCheckResult = {
  name: string;
  severity: CheckSeverity;
  status: CheckStatus;
  evidence: string;
};

export type OutOfScopeItem = {
  name: string;
  reason: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// 1. No hardcoded secret (critical)
// ---------------------------------------------------------------------------

/**
 * Heuristic, not a full secret-scanner. It flags lines that look like
 * `<name containing password/secret/apiKey/token> = "<literal>"` (or the
 * object-literal form `name: "<literal>"`), where:
 *
 * - the line does NOT mention `process.env` (a fallback like
 *   `token: process.env.TOKEN ?? "..."` is treated as "reading from env",
 *   not hardcoded — per the issue's own scope);
 * - the assignment is not a member-expression write like `url.password =
 *   "****"` (excluded by requiring the char right before the name not be
 *   `.`) — this repo's `scripts/db-migrate.ts` masks a URL's password with
 *   literal `"****"`, which is a redaction placeholder, not a secret;
 * - the literal isn't an obvious placeholder (`change-me`, `xxx`, `***`,
 *   `...`, `redacted`, `todo`).
 *
 * Known limitations (documented, not silently hidden):
 * - Cannot see through string concatenation/template interpolation.
 * - Cannot tell a real secret literal from an incidental false positive if
 *   the variable name merely contains one of the four keywords (e.g. a
 *   `tokenType = "Bearer"` constant) — no such case exists in this repo
 *   today (verified), but a future one could produce a false positive.
 * - Only scans `src/`, `scripts/`, and a short list of root config files —
 *   matching the issue's own scope. `tests/` is intentionally excluded so
 *   this script's own synthetic test fixtures never count as findings.
 */
const HARDCODED_SECRET_PATTERN =
  /(^|[^.\w])([A-Za-z0-9_$]*(?:password|secret|api[_-]?key|token)[A-Za-z0-9_$]*)\s*(?<![=!<>])[:=](?!=)\s*["'`]([^"'`]{3,})["'`]/i;

const PLACEHOLDER_VALUE_PATTERN = /^(\*+|x+|change-?me|redacted|todo|\.{3})$/i;

/**
 * An i18n/error-code lookup key (e.g. `"error.token_expired"`) — a lowercase
 * dot-namespaced identifier with no random entropy. Real secrets (JWT
 * signing keys, API keys, session tokens) are never valid instances of this
 * shape: they're either read from `process.env` (already excluded above) or
 * high-entropy opaque strings. Found live while running this exact script
 * against this exact repo (Issue #437): `src/lib/i18n/error-messages.ts`'s
 * `ERROR_CODE_KEYS` map has a `TOKEN_EXPIRED: "error.token_expired"` entry —
 * the *key* name contains "TOKEN" (matching `HARDCODED_SECRET_PATTERN`'s
 * name group) but the *value* is an i18n catalog lookup key, not a secret.
 * Without this exclusion `bun run security:readiness` reports a false
 * "critical" failure on unmodified, already-merged code — the gate itself
 * would block go-live for no real reason.
 */
const I18N_KEY_LIKE_VALUE_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

const SECRET_SCAN_PATHSPECS = [
  "src/**/*.ts",
  "src/**/*.astro",
  "src/**/*.mjs",
  "scripts/**/*.ts",
  "scripts/**/*.mjs",
  "astro.config.mjs",
  "package.json"
];

// This script's own file is excluded from the scan: it legitimately declares
// constants like a sync-secret placeholder comparison value, whose *names*
// contain "secret" even though they hold known-safe placeholder strings, not
// real secrets. A secret scanner should not flag itself.
const SECRET_SCAN_SELF_EXCLUDE = "scripts/security-readiness.ts";

export function scanLineForHardcodedSecret(line: string): string | null {
  if (line.includes("process.env")) {
    return null;
  }

  const match = HARDCODED_SECRET_PATTERN.exec(line);

  if (!match) {
    return null;
  }

  const name = match[2];
  const value = match[3];

  if (
    !name ||
    !value ||
    PLACEHOLDER_VALUE_PATTERN.test(value) ||
    I18N_KEY_LIKE_VALUE_PATTERN.test(value)
  ) {
    return null;
  }

  return name;
}

export async function checkNoHardcodedSecret(
  rootDir = process.cwd()
): Promise<SecurityCheckResult> {
  const name = "No hardcoded secret";
  const severity: CheckSeverity = "critical";

  try {
    const trackedOutput = execFileSync(
      "git",
      ["ls-files", ...SECRET_SCAN_PATHSPECS],
      { cwd: rootDir, encoding: "utf8" }
    );
    const trackedFiles = trackedOutput
      .split("\n")
      .filter(Boolean)
      .filter((file) => file !== SECRET_SCAN_SELF_EXCLUDE);

    const findings: string[] = [];

    for (const file of trackedFiles) {
      const content = await readFile(path.join(rootDir, file), "utf8");
      const lines = content.split("\n");

      lines.forEach((line, index) => {
        const hit = scanLineForHardcodedSecret(line);

        if (hit) {
          findings.push(`${file}:${index + 1} (variable "${hit}")`);
        }
      });
    }

    if (findings.length > 0) {
      return {
        name,
        severity,
        status: "fail",
        evidence: `Suspicious literal assigned to a secret-like variable: ${findings.join("; ")}.`
      };
    }

    return {
      name,
      severity,
      status: "pass",
      evidence: `Scanned ${trackedFiles.length} tracked file(s) under src/, scripts/, and config — no literal secret-like assignment found (heuristic regex, see source comment for limits).`
    };
  } catch (error) {
    return {
      name,
      severity,
      status: "fail",
      evidence: `Could not run the secret scan: ${errorMessage(error)}.`
    };
  }
}

// ---------------------------------------------------------------------------
// 2. .env not tracked by git (critical)
// ---------------------------------------------------------------------------

export function checkEnvNotTracked(
  rootDir = process.cwd()
): SecurityCheckResult {
  const name = ".env not tracked by git";
  const severity: CheckSeverity = "critical";

  try {
    const output = execFileSync("git", ["ls-files"], {
      cwd: rootDir,
      encoding: "utf8"
    });
    const trackedEnvFiles = output
      .split("\n")
      .filter(Boolean)
      .filter((file) => file === ".env" || file.endsWith("/.env"));

    if (trackedEnvFiles.length > 0) {
      return {
        name,
        severity,
        status: "fail",
        evidence: `.env file(s) are tracked by git: ${trackedEnvFiles.join(", ")}.`
      };
    }

    return {
      name,
      severity,
      status: "pass",
      evidence:
        "git ls-files does not include any .env file (only .env.example is tracked)."
    };
  } catch (error) {
    return {
      name,
      severity,
      status: "fail",
      evidence: `Could not run "git ls-files": ${errorMessage(error)}.`
    };
  }
}

// ---------------------------------------------------------------------------
// 3. Password hashing is modern (argon2id) (critical)
// ---------------------------------------------------------------------------

/**
 * NOTE: this deliberately does NOT grep `src/lib/auth/password.ts` for the
 * literal string `"argon2id"` — that string does not appear anywhere in the
 * file. `hashPassword` calls `Bun.password.hash(password)` with no explicit
 * algorithm argument, relying on Bun's documented default
 * (`node_modules/bun-types/bun.d.ts`: `@default "argon2id"` on the
 * `algorithm` option). A literal grep would therefore always report a false
 * "fail" against genuinely-secure, working code. Instead this calls the
 * real `hashPassword()` function and inspects the actual hash it produces —
 * a stronger, "real, verifiable signal" than a grep, and immune to Bun
 * changing its default in a way source-grepping wouldn't catch either.
 */
export async function checkPasswordHashingModern(): Promise<SecurityCheckResult> {
  const name = "Password hashing is modern (argon2id)";
  const severity: CheckSeverity = "critical";

  try {
    const hash = await hashPassword("security-readiness-synthetic-check");

    if (hash.startsWith("$argon2id$")) {
      return {
        name,
        severity,
        status: "pass",
        evidence: `hashPassword() produced a $argon2id$ hash (Bun.password.hash's documented default algorithm).`
      };
    }

    return {
      name,
      severity,
      status: "fail",
      evidence: `hashPassword() produced a hash that is not argon2id: "${hash.slice(0, 16)}...".`
    };
  } catch (error) {
    return {
      name,
      severity,
      status: "fail",
      evidence: `Could not call hashPassword(): ${errorMessage(error)}.`
    };
  }
}

// ---------------------------------------------------------------------------
// 4. Login lockout is implemented (critical)
// ---------------------------------------------------------------------------

export function checkLoginLockoutImplemented(): SecurityCheckResult {
  const name = "Login lockout is implemented";
  const severity: CheckSeverity = "critical";
  const now = new Date("2026-01-01T00:00:00.000Z");
  const maxFailedAttempts = 5;

  // Synthetic "5th consecutive failed attempt" input: identity already has
  // 4 recorded failures; one more invalid password attempt should push the
  // count to 5 (== maxFailedAttempts) and trigger a lockout.
  const result = evaluateLoginAttempt({
    now,
    tenantStatus: "active",
    identity: { status: "active", failedLoginCount: 4, lockedUntil: null },
    tenantUserStatus: "active",
    passwordMatches: false,
    maxFailedAttempts,
    lockoutMinutes: 15
  });

  const lockedOut =
    result.outcome === "deny" &&
    result.failedLoginCount === maxFailedAttempts &&
    result.lockedUntil instanceof Date;

  if (lockedOut) {
    return {
      name,
      severity,
      status: "pass",
      evidence: `evaluateLoginAttempt() with 5 consecutive failed attempts (maxFailedAttempts=5) returns outcome="deny" with a lockedUntil timestamp.`
    };
  }

  return {
    name,
    severity,
    status: "fail",
    evidence: `evaluateLoginAttempt() did not lock out at the configured threshold; result=${JSON.stringify(result)}.`
  };
}

// ---------------------------------------------------------------------------
// 5. RLS enabled on tenant-scoped tables (critical)
// ---------------------------------------------------------------------------

/**
 * Tables that are intentionally RLS-free because they are not tenant-scoped
 * (no per-tenant row ownership) — derived by inspecting `sql/*.sql`
 * directly, not guessed:
 *
 * - `awcms_mini_schema_migrations` (sql/001) — migration bookkeeping.
 * - `awcms_mini_modules` (sql/001) — global module registry, no `tenant_id`.
 * - `awcms_mini_tenants` (sql/002) — the tenant table itself; each row IS a
 *   tenant, it doesn't belong to one.
 * - `awcms_mini_permissions` (sql/005) — global `module.activity.action`
 *   permission catalog, shared by all tenants.
 * - `awcms_mini_setup_state` (sql/006) — global singleton setup lock that
 *   exists before any tenant does.
 * - `awcms_mini_module_dependencies`, `awcms_mini_module_navigation`,
 *   `awcms_mini_module_jobs`, `awcms_mini_module_health_checks` (sql/025) —
 *   code-derived module registry metadata (dependency graph, admin nav,
 *   job/command catalog, instance-level health check history), synced from
 *   trusted descriptors, never tenant-writable. Same reasoning as
 *   `awcms_mini_modules` above.
 * - `awcms_mini_idn_region_datasets`, `awcms_mini_idn_admin_regions`
 *   (sql/054, Issue #657, epic #654) — Indonesia administrative region
 *   master data sourced from the third-party `cahyadsn/wilayah` dataset.
 *   Identical for every tenant (a region hierarchy doesn't vary per
 *   tenant), so this is global reference data, not tenant-scoped — same
 *   reasoning as `awcms_mini_permissions` above. See
 *   `.claude/skills/awcms-mini-idn-admin-regions/SKILL.md`.
 */
const RLS_FREE_TABLES = new Set([
  "awcms_mini_schema_migrations",
  "awcms_mini_modules",
  "awcms_mini_tenants",
  "awcms_mini_permissions",
  "awcms_mini_setup_state",
  "awcms_mini_module_dependencies",
  "awcms_mini_module_navigation",
  "awcms_mini_module_jobs",
  "awcms_mini_module_health_checks",
  "awcms_mini_idn_region_datasets",
  "awcms_mini_idn_admin_regions"
]);

export async function checkRlsEnabled(): Promise<SecurityCheckResult> {
  const name = "RLS enabled AND forced on tenant-scoped tables";
  const severity: CheckSeverity = "critical";

  try {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is not set.");
    }

    const sql = getDatabaseClient();
    const rows = await sql<
      {
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }[]
    >`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relname LIKE 'awcms_mini_%' AND relkind = 'r'
      ORDER BY relname
    `;

    if (rows.length === 0) {
      return {
        name,
        severity,
        status: "fail",
        evidence:
          "No awcms_mini_% tables found in pg_class — has `bun run db:migrate` been run against this database?"
      };
    }

    const tenantScoped = rows.filter(
      (row) => !RLS_FREE_TABLES.has(row.relname)
    );
    // Both flags are required for real enforcement: relrowsecurity turns RLS on,
    // but without relforcerowsecurity the *table owner* still bypasses it
    // (migration 013 adds FORCE for exactly this reason).
    const notEnforced = tenantScoped.filter(
      (row) => !row.relrowsecurity || !row.relforcerowsecurity
    );
    const excludedFound = [...RLS_FREE_TABLES].filter((table) =>
      rows.some((row) => row.relname === table)
    );

    if (notEnforced.length > 0) {
      return {
        name,
        severity,
        status: "fail",
        evidence: `Tenant-scoped table(s) not fully enforced (need relrowsecurity AND relforcerowsecurity): ${notEnforced
          .map(
            (row) =>
              `${row.relname}(rls=${row.relrowsecurity},force=${row.relforcerowsecurity})`
          )
          .join(", ")}.`
      };
    }

    return {
      name,
      severity,
      status: "pass",
      evidence: `${tenantScoped.length} tenant-scoped table(s) all have relrowsecurity=true AND relforcerowsecurity=true. Excluded as documented RLS-free (non-tenant-scoped): ${excludedFound.join(", ")}.`
    };
  } catch (error) {
    return {
      name,
      severity,
      status: "fail",
      evidence: `Could not connect to the database to verify RLS: ${errorMessage(error)}.`
    };
  }
}

/**
 * FORCE ROW LEVEL SECURITY still does not apply to a SUPERUSER or a role with
 * BYPASSRLS. So the *connection role the app actually uses* must be neither —
 * otherwise RLS is bypassed no matter how the tables are configured. This
 * check inspects the role of the current connection (DATABASE_URL), which is
 * the app's real posture; run security:readiness with the app's DATABASE_URL,
 * not a privileged migration URL, for a meaningful result.
 */
export async function checkAppDbUserNotSuperuser(): Promise<SecurityCheckResult> {
  const name = "App DB connection role does not bypass RLS";
  const severity: CheckSeverity = "critical";

  try {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is not set.");
    }

    const sql = getDatabaseClient();
    const rows = await sql<
      { rolname: string; rolsuper: boolean; rolbypassrls: boolean }[]
    >`
      SELECT rolname, rolsuper, rolbypassrls
      FROM pg_roles WHERE rolname = current_user
    `;
    const role = rows[0];

    if (!role) {
      return {
        name,
        severity,
        status: "fail",
        evidence: "Could not resolve the current connection role."
      };
    }

    if (role.rolsuper || role.rolbypassrls) {
      return {
        name,
        severity,
        status: "fail",
        evidence: `The app connects as "${role.rolname}" which is ${role.rolsuper ? "a SUPERUSER" : "BYPASSRLS"} — it bypasses RLS entirely, so tenant isolation is not enforced at the database. Connect as a least-privilege role (e.g. awcms_mini_app).`
      };
    }

    return {
      name,
      severity,
      status: "pass",
      evidence: `The app connects as "${role.rolname}" (rolsuper=false, rolbypassrls=false) — RLS policies are enforced for this role.`
    };
  } catch (error) {
    return {
      name,
      severity,
      status: "fail",
      evidence: `Could not verify the connection role: ${errorMessage(error)}.`
    };
  }
}

/**
 * Issue #683 (epic #679) — the exact approved grant matrix from
 * `sql/045_awcms_mini_db_role_separation.sql`'s header, restricted to the
 * GLOBAL (non-RLS) tables in `RLS_FREE_TABLES` above (9 as of Issue #683,
 * plus 2 more added by Issue #657 — see `RLS_FREE_TABLES`'s own doc comment
 * for the up-to-date membership). Tenant-scoped tables
 * are deliberately out of scope here — RLS/FORCE RLS is the real boundary
 * for those (see `checkRlsEnabled`), and the existing `ALTER DEFAULT
 * PRIVILEGES` convenience is meant to auto-grant `awcms_mini_app` on every
 * FUTURE tenant-scoped table without a matching migration edit each time.
 * This allowlist exists specifically to catch the failure mode that
 * convenience doesn't cover: a future migration adding a new NON-RLS global
 * table that inherits the same blanket default-privileges grant.
 */
const ALLOWED_GLOBAL_TABLE_GRANTS: Record<string, Record<string, string[]>> = {
  awcms_mini_permissions: {
    awcms_mini_app: ["SELECT"],
    awcms_mini_setup: ["SELECT"]
  },
  awcms_mini_schema_migrations: {
    awcms_mini_app: ["SELECT"]
  },
  awcms_mini_setup_state: {
    // INSERT/UPDATE (not just SELECT) stay on awcms_mini_app: the setup
    // route falls back to this role when SETUP_DATABASE_URL isn't
    // configured (src/lib/database/client.ts) — see sql/045's header note
    // on role 2 for the full trade-off. Only DELETE is narrowed (nothing,
    // dedicated role or fallback, ever deletes this singleton row).
    awcms_mini_app: ["SELECT", "INSERT", "UPDATE"],
    awcms_mini_setup: ["SELECT", "INSERT", "UPDATE"]
  },
  awcms_mini_tenants: {
    // Same fallback reasoning as awcms_mini_setup_state above — INSERT is
    // kept alongside the pre-existing UPDATE (PATCH /api/v1/settings).
    awcms_mini_app: ["SELECT", "INSERT", "UPDATE"],
    awcms_mini_worker: ["SELECT"],
    // SELECT is required alongside INSERT because bootstrapPlatformTenant's
    // INSERT ... RETURNING id needs it (Postgres requires SELECT on a
    // column for it to appear in RETURNING) — see sql/045's header.
    awcms_mini_setup: ["INSERT", "SELECT"]
  },
  awcms_mini_modules: {
    awcms_mini_app: ["SELECT", "INSERT", "UPDATE", "DELETE"]
  },
  awcms_mini_module_dependencies: {
    awcms_mini_app: ["SELECT", "INSERT", "UPDATE", "DELETE"]
  },
  awcms_mini_module_navigation: {
    awcms_mini_app: ["SELECT", "INSERT", "UPDATE", "DELETE"]
  },
  awcms_mini_module_jobs: {
    awcms_mini_app: ["SELECT", "INSERT", "UPDATE", "DELETE"]
  },
  awcms_mini_module_health_checks: {
    awcms_mini_app: ["SELECT", "INSERT", "UPDATE", "DELETE"]
  },
  // Issue #657 (epic #654) — schema-only, no runtime code path reads or
  // writes either table yet (import is #660, activate/rollback is #661,
  // the read-only lookup API is #662). `sql/054` REVOKEs the blanket
  // default-privileges grant `awcms_mini_app` would otherwise inherit, so
  // it has zero access here. Future issues each add exactly the grant
  // their own new code path needs, in their own migration.
  awcms_mini_idn_region_datasets: {},
  awcms_mini_idn_admin_regions: {}
};

/**
 * Reads the REAL grants (`pg_class.relacl` via `aclexplode`, not a static
 * assumption) for `awcms_mini_app`/`awcms_mini_worker`/`awcms_mini_setup` on
 * every `awcms_mini_%` table, keeps only the global (non-RLS) ones (see
 * `RLS_FREE_TABLES` above for the current membership), and
 * flags any grant not in `ALLOWED_GLOBAL_TABLE_GRANTS` above. `pg_class` is
 * readable by any role (same reasoning `checkRlsEnabled` already relies on),
 * so this works whichever role `DATABASE_URL` connects as — it does not
 * require a privileged/owner connection to see other roles' grants, unlike
 * `information_schema.role_table_grants` (which only shows grants where the
 * connected role is grantor/grantee/a member of the grantee role).
 */
export async function checkRuntimeRoleGlobalTableGrants(): Promise<SecurityCheckResult> {
  const name =
    "Runtime roles (app/worker/setup) have no unexpected grants on global tables";
  const severity: CheckSeverity = "critical";

  try {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is not set.");
    }

    const sql = getDatabaseClient();
    const rows = await sql<
      { table_name: string; grantee: string; privilege: string }[]
    >`
      SELECT c.relname AS table_name, a.rolname AS grantee, p.privilege_type AS privilege
      FROM pg_class c
      CROSS JOIN LATERAL aclexplode(c.relacl) AS p
      JOIN pg_roles a ON a.oid = p.grantee
      WHERE c.relname LIKE 'awcms_mini_%' AND c.relkind = 'r'
        AND a.rolname IN ('awcms_mini_app', 'awcms_mini_worker', 'awcms_mini_setup')
      ORDER BY c.relname, a.rolname, p.privilege_type
    `;

    const globalRows = rows.filter((row) =>
      RLS_FREE_TABLES.has(row.table_name)
    );
    const unexpected: string[] = [];

    for (const row of globalRows) {
      const allowedForTable = ALLOWED_GLOBAL_TABLE_GRANTS[row.table_name] ?? {};
      const allowedForRole = allowedForTable[row.grantee] ?? [];

      if (!allowedForRole.includes(row.privilege)) {
        unexpected.push(
          `${row.grantee} has unexpected ${row.privilege} on ${row.table_name}`
        );
      }
    }

    if (unexpected.length > 0) {
      return {
        name,
        severity,
        status: "fail",
        evidence: `Unexpected grant(s) on global (non-RLS) table(s) — see sql/045_awcms_mini_db_role_separation.sql's header for the approved matrix: ${unexpected.join("; ")}.`
      };
    }

    return {
      name,
      severity,
      status: "pass",
      evidence: `Checked ${globalRows.length} grant(s) across ${RLS_FREE_TABLES.size} global table(s) for awcms_mini_app/awcms_mini_worker/awcms_mini_setup — all match the approved allowlist (sql/045_awcms_mini_db_role_separation.sql).`
    };
  } catch (error) {
    return {
      name,
      severity,
      status: "fail",
      evidence: `Could not verify runtime role grants on global tables: ${errorMessage(error)}.`
    };
  }
}

// ---------------------------------------------------------------------------
// 6. ABAC default-deny works (critical)
// ---------------------------------------------------------------------------

export function checkAbacDefaultDeny(): SecurityCheckResult {
  const name = "ABAC default-deny works";
  const severity: CheckSeverity = "critical";

  const decision = evaluateAccess(
    {
      tenantId: "00000000-0000-0000-0000-000000000000",
      tenantUserId: "00000000-0000-0000-0000-0000000000aa",
      identityId: "00000000-0000-0000-0000-0000000000bb",
      roles: []
    },
    {
      moduleKey: "identity_access",
      activityCode: "user_management",
      action: "read"
    },
    new Set()
  );

  if (decision.allowed === false && decision.matchedPolicy === "default_deny") {
    return {
      name,
      severity,
      status: "pass",
      evidence: `evaluateAccess() with an empty granted-permission set returns allowed=false (matchedPolicy="default_deny").`
    };
  }

  return {
    name,
    severity,
    status: "fail",
    evidence: `evaluateAccess() with an empty granted-permission set unexpectedly allowed access: ${JSON.stringify(decision)}.`
  };
}

// ---------------------------------------------------------------------------
// 7. Audit log table exists and reachable (critical)
// ---------------------------------------------------------------------------

export async function checkAuditLogTableReachable(): Promise<SecurityCheckResult> {
  const name = "Audit log table exists and reachable";
  const severity: CheckSeverity = "critical";

  try {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is not set.");
    }

    const sql = getDatabaseClient();
    const rows = await sql<{ to_regclass: string | null }[]>`
      SELECT to_regclass('awcms_mini_audit_events') AS to_regclass
    `;
    const value = rows[0]?.to_regclass ?? null;

    if (value) {
      return {
        name,
        severity,
        status: "pass",
        evidence: `to_regclass('awcms_mini_audit_events') = ${value}.`
      };
    }

    return {
      name,
      severity,
      status: "fail",
      evidence:
        "to_regclass('awcms_mini_audit_events') returned null — the audit table does not exist."
    };
  } catch (error) {
    return {
      name,
      severity,
      status: "fail",
      evidence: `Could not query the database for the audit table: ${errorMessage(error)}.`
    };
  }
}

// ---------------------------------------------------------------------------
// 8. Soft delete/restore/purge permissions seeded and audited (warning)
// ---------------------------------------------------------------------------

const SOFT_DELETE_ACTIONS = ["delete", "restore", "purge"] as const;

const SOFT_DELETE_AUDITED_FILES = [
  "src/pages/api/v1/profiles/[id].ts",
  "src/pages/api/v1/profiles/[id]/restore.ts",
  "src/pages/api/v1/profiles/[id]/purge.ts"
];

export async function checkSoftDeletePermissionsSeededAndAudited(
  rootDir = process.cwd()
): Promise<SecurityCheckResult> {
  const name = "Soft delete/restore/purge permissions are seeded and audited";
  const severity: CheckSeverity = "warning";
  const problems: string[] = [];

  try {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is not set.");
    }

    const sql = getDatabaseClient();
    const rows = await sql<{ action: string }[]>`
      SELECT action FROM awcms_mini_permissions
      WHERE module_key = 'profile_identity'
        AND activity_code = 'profile_management'
        AND action IN ('delete', 'restore', 'purge')
    `;
    const seededActions = new Set(rows.map((row) => row.action));

    for (const action of SOFT_DELETE_ACTIONS) {
      if (!seededActions.has(action)) {
        problems.push(
          `permission profile_identity.profile_management.${action} not seeded`
        );
      }
    }
  } catch (error) {
    problems.push(
      `could not query awcms_mini_permissions: ${errorMessage(error)}`
    );
  }

  for (const file of SOFT_DELETE_AUDITED_FILES) {
    try {
      const content = await readFile(path.join(rootDir, file), "utf8");

      if (!content.includes("recordAuditEvent")) {
        problems.push(`${file} does not appear to call recordAuditEvent`);
      }
    } catch (error) {
      problems.push(`could not read ${file}: ${errorMessage(error)}`);
    }
  }

  if (problems.length > 0) {
    return {
      name,
      severity,
      status: "fail",
      evidence: problems.join("; ") + "."
    };
  }

  return {
    name,
    severity,
    status: "pass",
    evidence:
      "delete/restore/purge permissions are seeded (migrations 005/011) and all 3 profile lifecycle endpoints call recordAuditEvent."
  };
}

// ---------------------------------------------------------------------------
// 9. Sync HMAC secret is not left at its documented default (warning/info)
// ---------------------------------------------------------------------------

const SYNC_SECRET_PLACEHOLDER = "change-me"; // literal default from .env.example

export function checkSyncHmacSecretNotDefault(
  env: NodeJS.ProcessEnv = process.env
): SecurityCheckResult {
  const name = "Sync HMAC secret is not left at its documented default";

  if (env.AWCMS_MINI_SYNC_ENABLED !== "true") {
    return {
      name,
      severity: "info",
      status: "pass",
      evidence: `AWCMS_MINI_SYNC_ENABLED is not "true" — sync is disabled by design, so its HMAC secret is not a live risk (not checked).`
    };
  }

  const secret = env.AWCMS_MINI_SYNC_HMAC_SECRET;

  if (!secret || secret === SYNC_SECRET_PLACEHOLDER) {
    return {
      name,
      severity: "warning",
      status: "fail",
      evidence: `AWCMS_MINI_SYNC_ENABLED=true but AWCMS_MINI_SYNC_HMAC_SECRET is unset or still the documented placeholder ("${SYNC_SECRET_PLACEHOLDER}").`
    };
  }

  return {
    name,
    severity: "warning",
    status: "pass",
    evidence:
      "AWCMS_MINI_SYNC_ENABLED=true and AWCMS_MINI_SYNC_HMAC_SECRET has been changed from its documented placeholder."
  };
}

// ---------------------------------------------------------------------------
// 9b. Email provider configuration is complete when enabled (critical —
// Issue #499)
// ---------------------------------------------------------------------------

/**
 * Reuses `checkEmailConfig` from `validate-env.ts` (Issue #493) verbatim —
 * same "don't reimplement the same conditional check a second, divergent
 * way" rule `checkSyncConfig` already follows for the sync HMAC secret.
 * Unlike the sync HMAC check (`warning` — a stale placeholder is a security
 * hygiene issue, not an outage), this is `critical`: the issue's own
 * acceptance criterion is "Readiness command blocks go-live when email is
 * enabled but provider config is incomplete." `production:preflight`
 * already gets this for free as its very first stage
 * (`bun run config:validate`) — this is the same signal surfaced a second
 * time, inside `security:readiness`'s own report/gate, for an operator who
 * runs `security:readiness` on its own rather than the full preflight.
 */
export function checkEmailProviderConfigReady(
  env: NodeJS.ProcessEnv = process.env
): SecurityCheckResult {
  const name = "Email provider configuration is complete when enabled";
  const severity: CheckSeverity = "critical";
  const results = checkEmailConfig(env);
  const failed = results.filter((result) => result.status === "fail");

  if (failed.length > 0) {
    return {
      name,
      severity,
      status: "fail",
      evidence: `EMAIL_ENABLED=true but config is incomplete: ${failed
        .map((result) => result.detail)
        .join(" ")}`
    };
  }

  if (env.EMAIL_ENABLED !== "true") {
    return {
      name,
      severity,
      status: "pass",
      evidence: 'EMAIL_ENABLED is not "true" — email config not required.'
    };
  }

  return {
    name,
    severity,
    status: "pass",
    evidence: `EMAIL_ENABLED=true and all ${results.length} conditional email config check(s) pass (provider=${env.EMAIL_PROVIDER}).`
  };
}

// ---------------------------------------------------------------------------
// 9c. Full-online auth security hardening gate is correctly configured
// (critical when misconfigured, informational when disabled — Issue #587)
// ---------------------------------------------------------------------------

/**
 * Reuses `checkOnlineAuthSecurityConfig` from `validate-env.ts` verbatim —
 * same "don't reimplement the same conditional check a second, divergent
 * way" rule `checkEmailProviderConfigReady` above already follows. Severity
 * is `critical` even for the "disabled" branch (matching that function's
 * pattern): the value describes how bad a genuine misconfiguration would
 * be, not this run's outcome — `status` alone is what "disabled ->
 * informational pass, not a failure" (the issue's own acceptance criterion)
 * actually means here. #588 (Turnstile) and #589 (MFA/TOTP) now exist and
 * have their own `checkTurnstileReady`/`checkMfaReady` checks below;
 * #590-#592 (Google login/generic SSO/admin policy UI) still don't, so
 * there is nothing else for this particular check to verify beyond the
 * shared gate itself.
 */
export function checkOnlineAuthSecurityReady(
  env: NodeJS.ProcessEnv = process.env
): SecurityCheckResult {
  const name =
    "Full-online auth security hardening gate is correctly configured";
  const severity: CheckSeverity = "critical";
  const results = checkOnlineAuthSecurityConfig(env);
  const failed = results.filter((result) => result.status === "fail");

  if (failed.length > 0) {
    return {
      name,
      severity,
      status: "fail",
      evidence: `AUTH_ONLINE_SECURITY_ENABLED=true but config is invalid: ${failed
        .map((result) => result.detail)
        .join(" ")}`
    };
  }

  if (env.AUTH_ONLINE_SECURITY_ENABLED !== "true") {
    return {
      name,
      severity,
      status: "pass",
      evidence:
        'AUTH_ONLINE_SECURITY_ENABLED is not "true" — full-online auth hardening (Turnstile/MFA/Google login/SSO) is disabled; local/offline/LAN deployments are unaffected.'
    };
  }

  return {
    name,
    severity,
    status: "pass",
    evidence:
      "AUTH_ONLINE_SECURITY_ENABLED=true and AUTH_ONLINE_SECURITY_PROFILE=full_online — full-online auth hardening gate is active."
  };
}

// ---------------------------------------------------------------------------
// 9d. Cloudflare Turnstile configuration is complete when enabled (critical
// when misconfigured, informational when disabled — Issue #588)
// ---------------------------------------------------------------------------

/**
 * Reuses `checkTurnstileConfig` from `validate-env.ts` verbatim — same
 * pattern as `checkEmailProviderConfigReady`/`checkOnlineAuthSecurityReady`
 * above. Deliberately does NOT check whether the #587 gate
 * (`isFullOnlineSecurityActive`) is also active: `TURNSTILE_ENABLED=true`
 * with incomplete `TURNSTILE_SITE_KEY`/`_SECRET_KEY` is a real
 * misconfiguration worth flagging even if the outer gate happens to be off
 * right now (an operator plausibly enables Turnstile credentials before
 * flipping the outer gate on) — `checkOnlineAuthSecurityReady` above
 * already covers the outer gate's own correctness independently.
 */
export function checkTurnstileReady(
  env: NodeJS.ProcessEnv = process.env
): SecurityCheckResult {
  const name = "Turnstile configuration is complete when enabled";
  const severity: CheckSeverity = "critical";
  const results = checkTurnstileConfig(env);
  const failed = results.filter((result) => result.status === "fail");

  if (failed.length > 0) {
    return {
      name,
      severity,
      status: "fail",
      evidence: `TURNSTILE_ENABLED=true but config is incomplete: ${failed
        .map((result) => result.detail)
        .join(" ")}`
    };
  }

  if (env.TURNSTILE_ENABLED !== "true") {
    return {
      name,
      severity,
      status: "pass",
      evidence:
        'TURNSTILE_ENABLED is not "true" — Turnstile config not required.'
    };
  }

  return {
    name,
    severity,
    status: "pass",
    evidence:
      "TURNSTILE_ENABLED=true and all conditional Turnstile config check(s) pass."
  };
}

/**
 * Reuses `checkMfaConfig` from `validate-env.ts` verbatim — same pattern and
 * same rationale as `checkTurnstileReady` above (checked independently of
 * the #587 outer gate; an incomplete `AUTH_MFA_SECRET_ENCRYPTION_KEY` is
 * worth flagging even if the outer gate is currently off).
 */
export function checkMfaReady(
  env: NodeJS.ProcessEnv = process.env
): SecurityCheckResult {
  const name = "MFA/TOTP configuration is complete when enabled";
  const severity: CheckSeverity = "critical";
  const results = checkMfaConfig(env);
  const failed = results.filter((result) => result.status === "fail");

  if (failed.length > 0) {
    return {
      name,
      severity,
      status: "fail",
      evidence: `AUTH_MFA_ENABLED=true but config is incomplete: ${failed
        .map((result) => result.detail)
        .join(" ")}`
    };
  }

  if (env.AUTH_MFA_ENABLED !== "true") {
    return {
      name,
      severity,
      status: "pass",
      evidence: 'AUTH_MFA_ENABLED is not "true" — MFA config not required.'
    };
  }

  return {
    name,
    severity,
    status: "pass",
    evidence:
      "AUTH_MFA_ENABLED=true and all conditional MFA config check(s) pass."
  };
}

/**
 * Reuses `checkGoogleOidcConfig` from `validate-env.ts` verbatim — same
 * pattern and rationale as `checkTurnstileReady`/`checkMfaReady` above.
 */
export function checkGoogleOidcReady(
  env: NodeJS.ProcessEnv = process.env
): SecurityCheckResult {
  const name = "Google OIDC configuration is complete when enabled";
  const severity: CheckSeverity = "critical";
  const results = checkGoogleOidcConfig(env);
  const failed = results.filter((result) => result.status === "fail");

  if (failed.length > 0) {
    return {
      name,
      severity,
      status: "fail",
      evidence: `AUTH_GOOGLE_LOGIN_ENABLED=true but config is incomplete: ${failed
        .map((result) => result.detail)
        .join(" ")}`
    };
  }

  if (env.AUTH_GOOGLE_LOGIN_ENABLED !== "true") {
    return {
      name,
      severity,
      status: "pass",
      evidence:
        'AUTH_GOOGLE_LOGIN_ENABLED is not "true" — Google OIDC config not required.'
    };
  }

  return {
    name,
    severity,
    status: "pass",
    evidence:
      "AUTH_GOOGLE_LOGIN_ENABLED=true and all conditional Google OIDC config check(s) pass."
  };
}

/**
 * Reuses `checkSsoConfig` from `validate-env.ts` verbatim — same pattern
 * and rationale as `checkTurnstileReady`/`checkMfaReady`/
 * `checkGoogleOidcReady` above (Issue #591, epic: full-online auth
 * hardening).
 */
export function checkSsoReady(
  env: NodeJS.ProcessEnv = process.env
): SecurityCheckResult {
  const name = "Tenant OIDC SSO configuration is complete when enabled";
  const severity: CheckSeverity = "critical";
  const results = checkSsoConfig(env);
  const failed = results.filter((result) => result.status === "fail");

  if (failed.length > 0) {
    return {
      name,
      severity,
      status: "fail",
      evidence: `AUTH_SSO_ENABLED=true but config is incomplete: ${failed
        .map((result) => result.detail)
        .join(" ")}`
    };
  }

  if (env.AUTH_SSO_ENABLED !== "true") {
    return {
      name,
      severity,
      status: "pass",
      evidence: 'AUTH_SSO_ENABLED is not "true" — SSO config not required.'
    };
  }

  return {
    name,
    severity,
    status: "pass",
    evidence:
      "AUTH_SSO_ENABLED=true and all conditional SSO config check(s) pass."
  };
}

// ---------------------------------------------------------------------------
// 9e. Tenant auth policies requiring SSO/no-password-login still have a
// currently-eligible break-glass owner (critical when misconfigured —
// Issue #593)
// ---------------------------------------------------------------------------

/**
 * `saveTenantAuthPolicy` (Issue #591, `tenant-auth-policy.ts`) already
 * refuses to PERSIST a policy with `sso_required=true` or
 * `password_login_enabled=false` unless at least one break-glass identity is
 * eligible (active identity + active tenant membership) at the moment the
 * policy is saved. That is a save-time guarantee only: a break-glass
 * identity that was eligible then can become ineligible LATER (deactivated,
 * membership revoked, or removed from a role) via an unrelated action,
 * without the policy row itself ever being re-saved — silently leaving the
 * tenant with `sso_required=true`/`password_login_enabled=false` and zero
 * remaining way back into local password login if its SSO provider ever has
 * an outage. This is exactly the residual gap Issue #593 asks
 * `security:readiness` to close (distinct from Issue #605's admin-UI
 * break-glass picker/data-hygiene concern, which stays its own separate open
 * issue).
 *
 * Re-derives eligibility from a FRESH read at readiness/go-live time by
 * reusing `countEligibleBreakGlassIdentities`/`getTenantAuthPolicy` VERBATIM
 * from `tenant-auth-policy.ts` — same "don't re-derive the same rule a
 * second, divergent way" convention every other `checkXxxReady` in this file
 * already follows for `validate-env.ts`'s `checkXxxConfig` functions.
 *
 * Iterates tenants from `awcms_mini_tenants` (RLS-free, migration 002,
 * `status = 'active'` only — a suspended/inactive tenant's login is already
 * blocked at the tenant level, so its break-glass state is not a live go-live
 * risk) and, for each, opens a short transaction that `SET LOCAL
 * app.current_tenant_id` exactly like `withTenant()` does. This makes the
 * check exercise the SAME RLS-scoped path a real request takes regardless of
 * whether `security:readiness` happens to run with a privileged or
 * least-privilege `DATABASE_URL` — it never needs its own RLS-bypassing
 * connection to see across tenants.
 */
export async function checkSsoBreakGlassReady(): Promise<SecurityCheckResult> {
  const name =
    "Tenant auth policies requiring SSO/no-password-login have a valid break-glass owner";
  const severity: CheckSeverity = "critical";

  try {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is not set.");
    }

    const sql = getDatabaseClient();
    const tenants = (await sql<{ id: string }[]>`
      SELECT id FROM awcms_mini_tenants WHERE status = 'active'
    `) as { id: string }[];

    const atRiskTenantIds: string[] = [];
    const erroredTenants: string[] = [];

    for (const tenant of tenants) {
      const tenantId = assertUuid(tenant.id);

      try {
        await sql.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);

          const policy = await getTenantAuthPolicy(tx, tenantId);

          if (policy.passwordLoginEnabled && !policy.ssoRequired) {
            return;
          }

          const eligibleCount = await countEligibleBreakGlassIdentities(
            tx,
            tenantId,
            policy.breakGlassIdentityIds
          );

          if (eligibleCount === 0) {
            atRiskTenantIds.push(tenantId);
          }
        });
      } catch (error) {
        // One tenant's query failing (corrupt data, transient error, ...)
        // must not hide a genuine at-risk finding for every OTHER tenant —
        // isolate it here instead of letting it escape to the outer catch,
        // which would otherwise abort the whole check after only a partial
        // scan and report it as an inconclusive error rather than surfacing
        // whichever tenants were already confirmed at-risk.
        erroredTenants.push(`${tenantId} (${errorMessage(error)})`);
      }
    }

    if (atRiskTenantIds.length > 0 || erroredTenants.length > 0) {
      const parts: string[] = [];

      if (atRiskTenantIds.length > 0) {
        parts.push(
          `${atRiskTenantIds.length} tenant(s) have sso_required=true or password_login_enabled=false with ZERO currently-eligible break-glass identity: ${atRiskTenantIds.join(", ")}. A break-glass identity may have been deactivated (identity/tenant-user membership) after the policy was saved — saveTenantAuthPolicy only validates eligibility at the moment of save, not continuously.`
        );
      }

      if (erroredTenants.length > 0) {
        parts.push(
          `${erroredTenants.length} tenant(s) could not be checked: ${erroredTenants.join("; ")}.`
        );
      }

      return { name, severity, status: "fail", evidence: parts.join(" ") };
    }

    return {
      name,
      severity,
      status: "pass",
      evidence: `${tenants.length} active tenant(s) checked — none have sso_required=true/password_login_enabled=false without a currently-eligible break-glass identity.`
    };
  } catch (error) {
    return {
      name,
      severity,
      status: "fail",
      evidence: `Could not verify tenant auth policy break-glass eligibility: ${errorMessage(error)}.`
    };
  }
}

// ---------------------------------------------------------------------------
// 9f. Visitor analytics privacy/retention posture (Issue #624, epic: visitor
// analytics #617-#624)
// ---------------------------------------------------------------------------

/**
 * `scripts/validate-env.ts`'s `checkVisitorAnalyticsConfig` (Issue #617)
 * only validates SHAPE — `VISITOR_ANALYTICS_MODE` is a known enum value,
 * the four retention/window vars are positive integers when set. It
 * intentionally has no cross-field rule (its own file header comment
 * §10 says so explicitly), because at the time it was written no other
 * visitor-analytics var existed to cross-check against and no rollup/purge
 * job existed yet to make the retention numbers operationally meaningful.
 *
 * The checks below are cross-field SAFETY judgment calls — "is this
 * combination of flags actually safe to go live with", not "is this one
 * var shaped correctly" — the same split `checkOnlineAuthSecurityReady`/
 * `checkTurnstileReady`/etc. above already draw between `validate-env.ts`
 * (shape) and this file (posture/severity). They all reuse
 * `resolveVisitorAnalyticsConfig` (Issue #617) rather than re-reading
 * `process.env.VISITOR_ANALYTICS_*` a second, divergent way.
 */

function isVisitorAnalyticsRetentionUnsafe(
  rawDetailRetentionDays: number,
  eventRetentionDays: number
): boolean {
  return rawDetailRetentionDays > eventRetentionDays;
}

/**
 * Issue #624 bullet 1: `VISITOR_ANALYTICS_RAW_IP_ENABLED=true` without safe
 * retention must fail readiness. "Safe" here means the raw-detail retention
 * window (which governs how long `awcms_mini_visitor_sessions.ip_address`
 * survives before `purgeVisitorAnalyticsData` clears it) does not outlive
 * the general event retention window — raw IP is the single most sensitive
 * column this module stores, so it must never be the longest-lived data
 * class. `critical`: this is real, currently-active PII collection, not a
 * hypothetical/reserved flag.
 */
export function checkVisitorAnalyticsRawIpRetentionReady(
  env: NodeJS.ProcessEnv = process.env
): SecurityCheckResult {
  const name =
    "Visitor analytics raw IP retention is safe when enabled (Issue #624)";
  const severity: CheckSeverity = "critical";
  const config = resolveVisitorAnalyticsConfig(env);

  if (!config.rawIpEnabled) {
    return {
      name,
      severity,
      status: "pass",
      evidence:
        'VISITOR_ANALYTICS_RAW_IP_ENABLED is not "true" — raw IP is never stored; retention ordering is not a live risk.'
    };
  }

  if (
    isVisitorAnalyticsRetentionUnsafe(
      config.rawDetailRetentionDays,
      config.eventRetentionDays
    )
  ) {
    return {
      name,
      severity,
      status: "fail",
      evidence: `VISITOR_ANALYTICS_RAW_IP_ENABLED=true but VISITOR_ANALYTICS_RAW_DETAIL_RETENTION_DAYS (${config.rawDetailRetentionDays}) exceeds VISITOR_ANALYTICS_EVENT_RETENTION_DAYS (${config.eventRetentionDays}) — raw IP would outlive the event window it is meant to support. Lower the raw-detail retention below (or equal to) the event retention.`
    };
  }

  return {
    name,
    severity,
    status: "pass",
    evidence: `VISITOR_ANALYTICS_RAW_IP_ENABLED=true and VISITOR_ANALYTICS_RAW_DETAIL_RETENTION_DAYS (${config.rawDetailRetentionDays}) does not exceed VISITOR_ANALYTICS_EVENT_RETENTION_DAYS (${config.eventRetentionDays}).`
  };
}

/**
 * Issue #624 bullet 2: `VISITOR_ANALYTICS_RAW_USER_AGENT_ENABLED=true`
 * without safe retention should warn/fail "according to severity" — chosen
 * `warning`, not `critical`, because this flag is currently a documented
 * no-op (`src/modules/visitor-analytics/README.md` §Collector,
 * `docs/awcms-mini/18_configuration_env_reference.md`): no raw-user-agent
 * column exists yet (migration 039 only has `user_agent_hash` +
 * `user_agent_parsed`), so setting it `true` today changes nothing about
 * what is actually stored. It is still checked (rather than ignored
 * outright) so the same retention-ordering rule is already enforced for
 * the day a future issue wires this flag to a real column.
 */
export function checkVisitorAnalyticsRawUserAgentRetentionReady(
  env: NodeJS.ProcessEnv = process.env
): SecurityCheckResult {
  const name =
    "Visitor analytics raw user-agent retention is safe when enabled (Issue #624)";
  const severity: CheckSeverity = "warning";
  const config = resolveVisitorAnalyticsConfig(env);
  const noOpNote =
    "VISITOR_ANALYTICS_RAW_USER_AGENT_ENABLED is currently a documented no-op — no raw-user-agent column exists yet, so nothing extra is stored regardless of this check's outcome.";

  if (!config.rawUserAgentEnabled) {
    return {
      name,
      severity,
      status: "pass",
      evidence: `VISITOR_ANALYTICS_RAW_USER_AGENT_ENABLED is not "true". ${noOpNote}`
    };
  }

  if (
    isVisitorAnalyticsRetentionUnsafe(
      config.rawDetailRetentionDays,
      config.eventRetentionDays
    )
  ) {
    return {
      name,
      severity,
      status: "fail",
      evidence: `VISITOR_ANALYTICS_RAW_USER_AGENT_ENABLED=true but VISITOR_ANALYTICS_RAW_DETAIL_RETENTION_DAYS (${config.rawDetailRetentionDays}) exceeds VISITOR_ANALYTICS_EVENT_RETENTION_DAYS (${config.eventRetentionDays}). ${noOpNote}`
    };
  }

  return {
    name,
    severity,
    status: "pass",
    evidence: `VISITOR_ANALYTICS_RAW_USER_AGENT_ENABLED=true and retention ordering is safe. ${noOpNote}`
  };
}

/**
 * Issue #624 bullet 3: `VISITOR_ANALYTICS_GEO_ENABLED=true` without a
 * trusted source must fail. `domain/geo-enrichment.ts` (Issue #623)
 * already gates real enrichment behind BOTH `VISITOR_ANALYTICS_GEO_ENABLED`
 * AND `VISITOR_ANALYTICS_TRUST_CLOUDFLARE` — leaving the latter off is
 * fail-safe at runtime (every geo field stays `null`), so this is not a
 * live data-leak. It is still `critical`, matching the issue's own
 * wording, because it means the operator's stated intent ("I want geo
 * enrichment") is silently unmet — shipping to production in that state
 * would look configured but produce nothing, which is exactly the kind of
 * silent misconfiguration a go-live gate exists to catch.
 */
export function checkVisitorAnalyticsGeoTrustedSourceReady(
  env: NodeJS.ProcessEnv = process.env
): SecurityCheckResult {
  const name =
    "Visitor analytics geolocation has a trusted source when enabled (Issue #624)";
  const severity: CheckSeverity = "critical";
  const config = resolveVisitorAnalyticsConfig(env);

  if (!config.geoEnabled) {
    return {
      name,
      severity,
      status: "pass",
      evidence:
        'VISITOR_ANALYTICS_GEO_ENABLED is not "true" — geolocation enrichment is disabled.'
    };
  }

  if (!config.trustCloudflare) {
    return {
      name,
      severity,
      status: "fail",
      evidence:
        "VISITOR_ANALYTICS_GEO_ENABLED=true but VISITOR_ANALYTICS_TRUST_CLOUDFLARE is not \"true\" — geo enrichment has no trusted header source and will silently resolve every field to null (fail-safe, but not the operator's stated intent). Set VISITOR_ANALYTICS_TRUST_CLOUDFLARE=true only if this deployment is only reachable through Cloudflare's edge."
    };
  }

  return {
    name,
    severity,
    status: "pass",
    evidence:
      "VISITOR_ANALYTICS_GEO_ENABLED=true and VISITOR_ANALYTICS_TRUST_CLOUDFLARE=true — geolocation enrichment has a trusted header source."
  };
}

/**
 * Issue #624 bullets 5-6: retention ORDERING, independent of whether raw
 * IP/UA collection is actually enabled (`checkVisitorAnalyticsRawIpRetentionReady`/
 * `checkVisitorAnalyticsRawUserAgentRetentionReady` above already cover the
 * flag-gated, higher-stakes version of the raw-detail-vs-event half of this
 * rule). `warning`, not `critical`, for both halves — this is a data-hygiene/
 * config-sanity concern (doc's own retention-ordering principle: raw detail
 * < event < rollup), not by itself a live security compromise; the issue's
 * own wording ("should not... unless explicitly justified") is advisory,
 * not a hard block.
 */
export function checkVisitorAnalyticsRetentionOrderingReady(
  env: NodeJS.ProcessEnv = process.env
): SecurityCheckResult {
  const name =
    "Visitor analytics retention windows are correctly ordered (Issue #624)";
  const severity: CheckSeverity = "warning";
  const config = resolveVisitorAnalyticsConfig(env);
  const problems: string[] = [];

  if (
    isVisitorAnalyticsRetentionUnsafe(
      config.rawDetailRetentionDays,
      config.eventRetentionDays
    )
  ) {
    problems.push(
      `VISITOR_ANALYTICS_RAW_DETAIL_RETENTION_DAYS (${config.rawDetailRetentionDays}) exceeds VISITOR_ANALYTICS_EVENT_RETENTION_DAYS (${config.eventRetentionDays})`
    );
  }

  if (config.rollupRetentionDays < config.eventRetentionDays) {
    problems.push(
      `VISITOR_ANALYTICS_ROLLUP_RETENTION_DAYS (${config.rollupRetentionDays}) is shorter than VISITOR_ANALYTICS_EVENT_RETENTION_DAYS (${config.eventRetentionDays})`
    );
  }

  if (problems.length > 0) {
    return {
      name,
      severity,
      status: "fail",
      evidence: `${problems.join("; ")}. Expected ordering: raw detail retention <= event retention <= rollup retention, unless explicitly justified for this deployment.`
    };
  }

  return {
    name,
    severity,
    status: "pass",
    evidence: `Retention windows are correctly ordered: raw detail (${config.rawDetailRetentionDays}d) <= event (${config.eventRetentionDays}d) <= rollup (${config.rollupRetentionDays}d).`
  };
}

/**
 * Issue #624 bullet 7: `VISITOR_ANALYTICS_HASH_SALT` should be required or
 * strongly warned when "stable hashing" is enabled. Stable hashing
 * (`hashVisitorKey`/`hashIpAddress`/`hashUserAgent`, Issue #619,
 * HMAC-SHA256 keyed by this salt) runs on every collected request whenever
 * the module's master switch is on — it is not gated by any of the raw-*
 * flags (those gate whether the RAW value is *also* stored, not whether
 * it's hashed). `warning`, not `critical`/required: an empty salt (the
 * default every existing deployment already runs with) still produces a
 * valid, internally-consistent keyed hash — it is only weaker against an
 * attacker correlating hashes across deployments via a precomputed table,
 * not a functional break. Making this `critical` would fail every
 * currently-passing default-configuration deployment for a defense-in-depth
 * concern, which is why "strongly warned" (not "required") is the chosen
 * severity, per the issue's own wording.
 */
export function checkVisitorAnalyticsHashSaltReady(
  env: NodeJS.ProcessEnv = process.env
): SecurityCheckResult {
  const name =
    "Visitor analytics hash salt is configured for stable hashing (Issue #624)";
  const severity: CheckSeverity = "warning";
  const config = resolveVisitorAnalyticsConfig(env);

  if (!config.enabled) {
    return {
      name,
      severity,
      status: "pass",
      evidence:
        'VISITOR_ANALYTICS_ENABLED is not "true" — no visitor/IP/user-agent hashing occurs.'
    };
  }

  if (config.hashSalt.trim().length === 0) {
    return {
      name,
      severity,
      status: "fail",
      evidence:
        "VISITOR_ANALYTICS_ENABLED=true but VISITOR_ANALYTICS_HASH_SALT is empty — visitor/IP/user-agent hashes are still valid and internally consistent, but a deployment-specific salt is strongly recommended to prevent cross-deployment hash correlation via a precomputed table."
    };
  }

  return {
    name,
    severity,
    status: "pass",
    evidence:
      "VISITOR_ANALYTICS_ENABLED=true and VISITOR_ANALYTICS_HASH_SALT is set."
  };
}

/**
 * Issue #624 repository audit addendum (2026-07-11): the anonymous
 * `awcms_mini_visitor_key` cookie used to have a hardcoded ~2-year
 * lifetime; it is now operator-configurable
 * (`VISITOR_ANALYTICS_VISITOR_KEY_COOKIE_TTL_DAYS`, 30-day default).
 * `warning`, not `critical` — an overly long TTL widens the window a
 * single anonymous visitor stays linkable across sessions, but the
 * value stored behind it is still a pseudonymous cookie value (never
 * raw PII by itself), so this is a hygiene/minimization concern, not a
 * live data leak. The 400-day ceiling mirrors the same order of
 * magnitude as common cookie-lifetime guidance (e.g. the EU ePrivacy
 * Directive's commonly-cited ~13-month/396-day maximum for consent
 * cookies) — a deployment that deliberately needs longer for a
 * documented reason can still accept the warning (only `critical`
 * blocks go-live).
 */
const VISITOR_KEY_COOKIE_TTL_WARNING_THRESHOLD_DAYS = 400;

export function checkVisitorAnalyticsVisitorKeyCookieTtlReady(
  env: NodeJS.ProcessEnv = process.env
): SecurityCheckResult {
  const name =
    "Visitor analytics anonymous cookie lifetime is short-lived (Issue #624)";
  const severity: CheckSeverity = "warning";
  const config = resolveVisitorAnalyticsConfig(env);

  if (!config.enabled) {
    return {
      name,
      severity,
      status: "pass",
      evidence:
        'VISITOR_ANALYTICS_ENABLED is not "true" — no visitor-key cookie is ever set.'
    };
  }

  if (
    config.visitorKeyCookieTtlDays >
    VISITOR_KEY_COOKIE_TTL_WARNING_THRESHOLD_DAYS
  ) {
    return {
      name,
      severity,
      status: "fail",
      evidence: `VISITOR_ANALYTICS_VISITOR_KEY_COOKIE_TTL_DAYS (${config.visitorKeyCookieTtlDays}) exceeds ${VISITOR_KEY_COOKIE_TTL_WARNING_THRESHOLD_DAYS} days — the anonymous visitor-key cookie stays linkable for an unusually long time. Prefer a shorter, privacy-minimizing lifetime unless explicitly justified for this deployment.`
    };
  }

  return {
    name,
    severity,
    status: "pass",
    evidence: `VISITOR_ANALYTICS_VISITOR_KEY_COOKIE_TTL_DAYS (${config.visitorKeyCookieTtlDays}) is within the recommended range.`
  };
}

// ---------------------------------------------------------------------------
// 10. Errors don't leak stack traces (warning/info, best-effort)
// ---------------------------------------------------------------------------

const STACK_TRACE_TELLTALES = [
  /at Object\./,
  /at Module\._compile/,
  /\.ts:\d+:\d+/,
  /\/home\//,
  /node_modules\//
];

export async function checkErrorsDontLeakStackTraces(
  baseUrl: string = resolveAppBaseUrl()
): Promise<SecurityCheckResult> {
  const name = "Errors don't leak stack traces";
  const url = new URL("/api/v1/sync/push", baseUrl).toString();

  let response: Response;

  try {
    // Deliberately malformed: POSTs to an HMAC-guarded endpoint without any
    // of the required X-AWCMS-Mini-* auth headers, which should produce a
    // clean 4xx JSON error, never a raw stack trace.
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [] })
    });
  } catch (error) {
    return {
      name,
      severity: "info",
      status: "pass",
      evidence: `Not checked — no server reachable at ${baseUrl} (${errorMessage(error)}). Verify manually or via "bun run production:preflight" against a running server.`
    };
  }

  let body: unknown;

  try {
    body = await response.json();
  } catch (error) {
    return {
      name,
      severity: "warning",
      status: "fail",
      evidence: `Response from ${url} was not valid JSON: ${errorMessage(error)}.`
    };
  }

  const errorField = (body as { error?: { message?: unknown } })?.error
    ?.message;
  const text =
    typeof errorField === "string" ? errorField : JSON.stringify(body);
  const leaked = STACK_TRACE_TELLTALES.some((pattern) => pattern.test(text));

  if (leaked) {
    return {
      name,
      severity: "warning",
      status: "fail",
      evidence: `Error body from ${url} appears to contain a stack-trace-like substring: "${text.slice(0, 200)}".`
    };
  }

  return {
    name,
    severity: "warning",
    status: "pass",
    evidence: `POST ${url} without required sync auth headers returned HTTP ${response.status} with a clean error body (best-effort — single endpoint/request shape only).`
  };
}

// ---------------------------------------------------------------------------
// 11. Security response headers present (warning, best-effort — Issue #437)
// ---------------------------------------------------------------------------

const REQUIRED_SECURITY_HEADERS = [
  "content-security-policy",
  "x-content-type-options",
  "x-frame-options",
  "referrer-policy",
  "permissions-policy"
];

/**
 * Live, best-effort check (same pattern as `checkErrorsDontLeakStackTraces`
 * above): hits a running server and inspects the *actual* response headers,
 * rather than only unit-testing `buildSecurityHeaders()` in isolation —
 * that would prove the builder function works but not that the app
 * actually sets these on a real response. `content-security-policy` here
 * comes from Astro's own `security.csp` feature (`astro.config.mjs`), a
 * real response header for this SSR build (verified live — see that
 * config's comment) — the other four come from
 * `src/lib/security/security-headers.ts` via `src/middleware.ts`.
 */
export async function checkSecurityHeadersPresent(
  baseUrl: string = resolveAppBaseUrl()
): Promise<SecurityCheckResult> {
  const name = "Security response headers present (CSP/X-Frame-Options/etc.)";
  const url = new URL("/login", baseUrl).toString();

  let response: Response;

  try {
    response = await fetch(url);
  } catch (error) {
    return {
      name,
      severity: "info",
      status: "pass",
      evidence: `Not checked — no server reachable at ${baseUrl} (${errorMessage(error)}). Verify manually or via "bun run production:preflight" against a running server.`
    };
  }

  const missing = REQUIRED_SECURITY_HEADERS.filter(
    (header) => !response.headers.has(header)
  );

  if (missing.length > 0) {
    return {
      name,
      severity: "warning",
      status: "fail",
      evidence: `GET ${url} response is missing header(s): ${missing.join(", ")}.`
    };
  }

  return {
    name,
    severity: "warning",
    status: "pass",
    evidence: `GET ${url} response included all of: ${REQUIRED_SECURITY_HEADERS.join(", ")}.`
  };
}

// ---------------------------------------------------------------------------
// 12. Login rate limiting is implemented (warning — Issue #437)
// ---------------------------------------------------------------------------

/**
 * Complementary to `checkLoginLockoutImplemented` (critical, per-identity):
 * this exercises the source-scoped volumetric limiter
 * (`src/lib/security/rate-limit.ts`) wired into `POST /api/v1/auth/login`.
 * Marked `warning`, not `critical` — it's defense-in-depth against
 * cross-identity enumeration/volumetric abuse, not the primary access
 * control (which is the per-identity lockout, already gated as critical).
 */
export function checkLoginRateLimitImplemented(): SecurityCheckResult {
  const name = "Login rate limiting is implemented (source+tenant volumetric)";
  const severity: CheckSeverity = "warning";
  const key = `security-readiness-synthetic-rate-limit-check-${crypto.randomUUID()}`;
  const config = { maxAttempts: 3, windowMs: 60_000 };
  const now = 1_000_000;

  checkRateLimit(key, config, now);
  checkRateLimit(key, config, now + 1);
  checkRateLimit(key, config, now + 2);
  const fourth = checkRateLimit(key, config, now + 3);

  if (!fourth.allowed) {
    return {
      name,
      severity,
      status: "pass",
      evidence: `checkRateLimit() with maxAttempts=3 denies the 4th call within the same window (retryAfterSec=${fourth.retryAfterSec}).`
    };
  }

  return {
    name,
    severity,
    status: "fail",
    evidence: `checkRateLimit() did not deny the 4th call after exceeding maxAttempts=3; result=${JSON.stringify(fourth)}.`
  };
}

// ---------------------------------------------------------------------------
// 12. News portal full-online R2-only preset readiness (critical/warning —
//     Issue #632, epic `news_portal` #631-#642/#649)
// ---------------------------------------------------------------------------

/**
 * Critical: once a tenant/deployment has opted in (`NEWS_PORTAL_ENABLED=true`),
 * every activation precondition (`NEWS_PORTAL_PROFILE=full_online_r2`,
 * complete `NEWS_MEDIA_R2_*` config, config separated from sync-storage's
 * own `R2_*`) must hold — reuses
 * `evaluateNewsPortalFullOnlineR2Readiness` (domain, pure) rather than
 * re-deriving the same checks a second way. Passes trivially when the
 * feature isn't opted into at all (the default for every existing
 * offline/LAN or non-news deployment).
 */
export function checkNewsPortalFullOnlineR2PresetReady(
  env: NodeJS.ProcessEnv = process.env
): SecurityCheckResult {
  const name = "News portal full-online R2-only preset readiness (Issue #632)";
  const severity: CheckSeverity = "critical";

  if (env.NEWS_PORTAL_ENABLED !== "true") {
    return {
      name,
      severity,
      status: "pass",
      evidence:
        'NEWS_PORTAL_ENABLED is not "true" — the news_portal_full_online_r2 preset is not in use.'
    };
  }

  const readiness = evaluateNewsPortalFullOnlineR2Readiness(env);

  if (readiness.ready) {
    return {
      name,
      severity,
      status: "pass",
      evidence:
        "NEWS_PORTAL_ENABLED=true, NEWS_PORTAL_PROFILE=full_online_r2, and NEWS_MEDIA_R2_* config is complete and separated from sync-storage's R2_* config."
    };
  }

  return {
    name,
    severity,
    status: "fail",
    evidence: readiness.detail.join(" ")
  };
}

/**
 * Warning (not critical): `image/svg+xml` is excluded from the default
 * `NEWS_MEDIA_R2_ALLOWED_MIME_TYPES` allow-list on purpose (SVG can embed
 * `<script>`/event handlers — architecture doc §9). An operator CAN
 * override the allow-list to include it, but that should be a deliberate,
 * reviewed decision paired with a sanitization pipeline — not an
 * accidental broadening. This check flags the override, it does not block
 * go-live on its own.
 */
export function checkNewsMediaR2SvgNotAllowed(
  env: NodeJS.ProcessEnv = process.env
): SecurityCheckResult {
  const name = "News media R2 allow-list excludes image/svg+xml by default";
  const severity: CheckSeverity = "warning";

  if (env.NEWS_MEDIA_R2_ENABLED !== "true") {
    return {
      name,
      severity,
      status: "pass",
      evidence:
        'NEWS_MEDIA_R2_ENABLED is not "true" — no MIME allow-list in effect.'
    };
  }

  if (allowsSvgMimeType(env)) {
    return {
      name,
      severity,
      status: "fail",
      evidence:
        "NEWS_MEDIA_R2_ALLOWED_MIME_TYPES includes image/svg+xml — verify this is a deliberate override paired with a real SVG sanitization pipeline, not an accidental broadening of the default allow-list (XSS risk via embedded <script>/event handlers)."
    };
  }

  return {
    name,
    severity,
    status: "pass",
    evidence: "NEWS_MEDIA_R2_ALLOWED_MIME_TYPES does not include image/svg+xml."
  };
}

/**
 * Issue #635, architecture doc §11: production must use a real custom
 * domain for `NEWS_MEDIA_R2_PUBLIC_BASE_URL`, never the `r2.dev` default
 * (unstable for production, no caching/branding control) or a loopback
 * host. Deliberately gated on `APP_ENV === "production"` — non-production
 * deployments may legitimately point at a dev/staging bucket without a
 * custom domain yet, and this check must never weaken the production
 * default to accommodate that (Issue #635 acceptance criteria).
 */
export function checkNewsMediaR2PublicBaseUrlProductionSafe(
  env: NodeJS.ProcessEnv = process.env
): SecurityCheckResult {
  const name = "News media R2 public base URL is production-safe";
  const severity: CheckSeverity = "critical";

  if (env.NEWS_MEDIA_R2_ENABLED !== "true") {
    return {
      name,
      severity,
      status: "pass",
      evidence:
        'NEWS_MEDIA_R2_ENABLED is not "true" — no public base URL in effect.'
    };
  }

  if (env.APP_ENV !== "production") {
    return {
      name,
      severity,
      status: "pass",
      evidence: `APP_ENV is "${env.APP_ENV ?? "(unset)"}", not "production" — non-production deployments may use a non-custom-domain public base URL (documented separately, Issue #635).`
    };
  }

  const publicBaseUrl = resolveNewsMediaR2Config(env).publicBaseUrl;
  const reason =
    findNewsMediaR2PublicBaseUrlProductionUnsafeReason(publicBaseUrl);

  if (reason === null) {
    return {
      name,
      severity,
      status: "pass",
      evidence:
        "NEWS_MEDIA_R2_PUBLIC_BASE_URL uses a custom domain, not the r2.dev default or a loopback host."
    };
  }

  const reasonText: Record<NonNullable<typeof reason>, string> = {
    r2_dev_default_domain:
      "uses Cloudflare R2's default *.r2.dev domain — map a custom domain to the bucket instead (architecture doc §11: r2.dev is not stable for production and does not support caching/branding control).",
    loopback_host:
      "points at a loopback host (localhost/127.0.0.1) — not reachable by real visitors in production.",
    unparseable_url: "is not a valid absolute URL."
  };

  return {
    name,
    severity,
    status: "fail",
    evidence: `APP_ENV=production but NEWS_MEDIA_R2_PUBLIC_BASE_URL ${reasonText[reason]}`
  };
}

/**
 * Issue #635 (tracked as "masih terbuka" in
 * `docs/awcms-mini/news-portal/r2-security-checklist.md` §7 after #632-634
 * landed): `awcms_mini_news_media_objects` rows stuck in `pending_upload`
 * past `NEWS_MEDIA_R2_PENDING_TTL_MINUTES` mean the automatic cleanup
 * `r2-backup-lifecycle.md` §2 requires has not run — one of the layered
 * mitigations for "a valid `pending` object_key is already publicly
 * reachable in R2 regardless of Postgres status" (architecture doc §8) is
 * silently not in effect. `warning`, not `critical`: this is a housekeeping
 * gap (no cleanup job exists in this codebase yet — §2's own text notes
 * the job itself is a separate, not-yet-implemented piece of work), not
 * proof of an active exposure by itself.
 *
 * Same RLS-respecting per-tenant scan pattern as `checkSsoBreakGlassReady`
 * above — iterates `awcms_mini_tenants` and opens one short transaction per
 * tenant with `SET LOCAL app.current_tenant_id`, so this works correctly
 * regardless of whether `security:readiness` runs with a privileged or
 * least-privilege `DATABASE_URL`.
 */
export async function checkNewsMediaR2NoStalePendingObjects(
  env: NodeJS.ProcessEnv = process.env
): Promise<SecurityCheckResult> {
  const name =
    "No stale pending_upload news media objects past their TTL (Issue #635)";
  const severity: CheckSeverity = "warning";

  if (env.NEWS_MEDIA_R2_ENABLED !== "true") {
    return {
      name,
      severity,
      status: "pass",
      evidence:
        'NEWS_MEDIA_R2_ENABLED is not "true" — no news media object registry in use.'
    };
  }

  const pendingTtlMinutes = resolveNewsMediaR2Config(env).pendingTtlMinutes;

  try {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is not set.");
    }

    const sql = getDatabaseClient();
    const tenants = (await sql<{ id: string }[]>`
      SELECT id FROM awcms_mini_tenants WHERE status = 'active'
    `) as { id: string }[];

    let staleCount = 0;
    const erroredTenants: string[] = [];

    for (const tenant of tenants) {
      const tenantId = assertUuid(tenant.id);

      try {
        await sql.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);

          const rows = (await tx`
            SELECT count(*)::int AS count
            FROM awcms_mini_news_media_objects
            WHERE status = 'pending_upload'
              AND created_at < now() - (${pendingTtlMinutes} || ' minutes')::interval
          `) as { count: number }[];

          staleCount += rows[0]?.count ?? 0;
        });
      } catch (error) {
        erroredTenants.push(`${tenantId} (${errorMessage(error)})`);
      }
    }

    if (staleCount > 0 || erroredTenants.length > 0) {
      const parts: string[] = [];

      if (staleCount > 0) {
        parts.push(
          `${staleCount} object(s) across all tenants are still "pending_upload" past their ${pendingTtlMinutes}-minute TTL — "bun run news-media:reconcile" (Issue #690, r2-backup-lifecycle.md §2) is not scheduled, not running, or not keeping up. Run "bun run news-media:reconcile --dry-run" to preview the exact cleanup, then schedule it (daily via cron/systemd timer) if it is not already.`
        );
      }

      if (erroredTenants.length > 0) {
        parts.push(
          `${erroredTenants.length} tenant(s) could not be checked: ${erroredTenants.join("; ")}.`
        );
      }

      return { name, severity, status: "fail", evidence: parts.join(" ") };
    }

    return {
      name,
      severity,
      status: "pass",
      evidence: `No pending_upload news media objects older than ${pendingTtlMinutes} minutes across ${tenants.length} active tenant(s).`
    };
  } catch (error) {
    return {
      name,
      severity,
      status: "fail",
      evidence: `Could not scan for stale pending_upload news media objects: ${errorMessage(error)}.`
    };
  }
}

/**
 * Social publishing provider readiness (Issue #643, epic `social_publishing`
 * #643-#647 — "Readiness check fails if enabled provider is missing required
 * credentials/scopes"). A no-op pass when `SOCIAL_PUBLISHING_ENABLED` is not
 * `"true"` (mirrors every other conditional-feature readiness check in this
 * file). When enabled, scans every active tenant's `connected`
 * `awcms_mini_social_accounts` rows for distinct `provider_key` values and
 * fails if ANY of them has no adapter registered in
 * `social-provider-registry.ts` — this foundation issue ships an EMPTY
 * registry, so as soon as any tenant connects a real account (via
 * `POST /api/v1/social-publishing/accounts`) before a real adapter (#644/
 * #645/#646) is deployed and registered, this check surfaces that gap
 * loudly rather than letting jobs silently pile up as
 * `provider_not_registered` failures with no readiness signal.
 */
export async function checkSocialPublishingProviderReadiness(
  env: NodeJS.ProcessEnv = process.env
): Promise<SecurityCheckResult> {
  const name =
    "Social publishing: every connected account's provider has a registered adapter (Issue #643)";
  const severity: CheckSeverity = "critical";

  if (!isSocialPublishingEnabled(env)) {
    return {
      name,
      severity,
      status: "pass",
      evidence:
        'SOCIAL_PUBLISHING_ENABLED is not "true" — social publishing is disabled, no provider adapter required.'
    };
  }

  try {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is not set.");
    }

    const sql = getDatabaseClient();
    const tenants = (await sql<{ id: string }[]>`
      SELECT id FROM awcms_mini_tenants WHERE status = 'active'
    `) as { id: string }[];

    const missingAdapterProviderKeys = new Set<string>();
    const erroredTenants: string[] = [];

    for (const tenant of tenants) {
      const tenantId = assertUuid(tenant.id);

      try {
        await sql.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);

          const rows = (await tx`
            SELECT DISTINCT provider_key FROM awcms_mini_social_accounts
            WHERE connection_status = 'connected'
          `) as { provider_key: string }[];

          for (const row of rows) {
            if (!getSocialProviderAdapter(row.provider_key)) {
              missingAdapterProviderKeys.add(row.provider_key);
            }
          }
        });
      } catch (error) {
        erroredTenants.push(`${tenantId} (${errorMessage(error)})`);
      }
    }

    if (missingAdapterProviderKeys.size > 0 || erroredTenants.length > 0) {
      const parts: string[] = [];

      if (missingAdapterProviderKeys.size > 0) {
        parts.push(
          `${missingAdapterProviderKeys.size} connected provider(s) have no registered adapter: ${Array.from(missingAdapterProviderKeys).join(", ")}. Every social publish job for these providers will fail as "provider_not_registered" until a real adapter is registered (social-provider-registry.ts's registerSocialProviderAdapter).`
        );
      }

      if (erroredTenants.length > 0) {
        parts.push(
          `${erroredTenants.length} tenant(s) could not be checked: ${erroredTenants.join("; ")}.`
        );
      }

      return { name, severity, status: "fail", evidence: parts.join(" ") };
    }

    return {
      name,
      severity,
      status: "pass",
      evidence: `Every connected social account's provider has a registered adapter across ${tenants.length} active tenant(s) (or no accounts are connected yet).`
    };
  } catch (error) {
    return {
      name,
      severity,
      status: "fail",
      evidence: `Could not verify social publishing provider readiness: ${errorMessage(error)}.`
    };
  }
}

const META_SOCIAL_PUBLISHING_PROVIDER_KEYS = [
  "meta_facebook_page",
  "meta_instagram"
];

/**
 * Meta adapter account-level readiness (Issue #644 acceptance criterion:
 * "Readiness check reports missing Meta config, missing scopes, expired
 * token, or unsupported account type"). The "missing Meta config" half is
 * `checkMetaSocialPublishingProviderConfig` (`bun run config:validate`) —
 * this is the OTHER half, which needs real tenant data (connected account
 * rows) `config:validate` never touches. No-op pass when
 * `SOCIAL_PUBLISHING_ENABLED` or `META_PROVIDER_ENABLED` isn't `"true"`,
 * same conditional-feature convention every other check in this file uses.
 */
export async function checkMetaSocialPublishingAccountReadiness(
  env: NodeJS.ProcessEnv = process.env
): Promise<SecurityCheckResult> {
  const name =
    "Social publishing: Meta connected accounts are configured and healthy (Issue #644)";
  const severity: CheckSeverity = "critical";

  if (!isSocialPublishingEnabled(env)) {
    return {
      name,
      severity,
      status: "pass",
      evidence:
        'SOCIAL_PUBLISHING_ENABLED is not "true" — social publishing is disabled, no Meta account readiness required.'
    };
  }

  if (!isMetaProviderEnabled(env)) {
    return {
      name,
      severity,
      status: "pass",
      evidence:
        'META_PROVIDER_ENABLED is not "true" — Meta adapter is disabled, no Meta account readiness required.'
    };
  }

  const config = loadMetaProviderConfig(env);

  if (!config) {
    return {
      name,
      severity,
      status: "fail",
      evidence:
        "META_PROVIDER_ENABLED=true but META_* config is missing/malformed — see checkMetaSocialPublishingProviderConfig (bun run config:validate)."
    };
  }

  try {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is not set.");
    }

    const sql = getDatabaseClient();
    const tenants = (await sql<{ id: string }[]>`
      SELECT id FROM awcms_mini_tenants WHERE status = 'active'
    `) as { id: string }[];

    const problems: string[] = [];
    const erroredTenants: string[] = [];

    for (const tenant of tenants) {
      const tenantId = assertUuid(tenant.id);

      try {
        await sql.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);

          const rows = (await tx`
            SELECT id, provider_key, provider_account_type, expires_at, scopes_json
            FROM awcms_mini_social_accounts
            WHERE connection_status = 'connected'
              AND provider_key = ANY(${tx.array(META_SOCIAL_PUBLISHING_PROVIDER_KEYS, "text")})
          `) as {
            id: string;
            provider_key: string;
            provider_account_type: string;
            expires_at: Date | null;
            scopes_json: unknown;
          }[];

          for (const row of rows) {
            const adapter = getSocialProviderAdapter(row.provider_key);

            if (
              adapter?.supportedAccountTypes &&
              !adapter.supportedAccountTypes.includes(
                row.provider_account_type as never
              )
            ) {
              problems.push(
                `account ${row.id} (tenant ${tenantId}): unsupported account type "${row.provider_account_type}" for provider "${row.provider_key}"`
              );
            }

            if (
              row.expires_at &&
              new Date(row.expires_at).getTime() < Date.now()
            ) {
              problems.push(
                `account ${row.id} (tenant ${tenantId}): token expired at ${new Date(row.expires_at).toISOString()}`
              );
            }

            const grantedScopes = Array.isArray(row.scopes_json)
              ? (row.scopes_json as unknown[]).filter(
                  (scope): scope is string => typeof scope === "string"
                )
              : [];
            const missingScopes = config.requiredScopes.filter(
              (scope) => !grantedScopes.includes(scope)
            );

            if (missingScopes.length > 0) {
              problems.push(
                `account ${row.id} (tenant ${tenantId}): missing required scope(s) ${missingScopes.join(", ")}`
              );
            }
          }
        });
      } catch (error) {
        erroredTenants.push(`${tenantId} (${errorMessage(error)})`);
      }
    }

    if (problems.length > 0 || erroredTenants.length > 0) {
      const parts: string[] = [];

      if (problems.length > 0) {
        parts.push(
          `${problems.length} Meta account readiness problem(s): ${problems.join("; ")}.`
        );
      }

      if (erroredTenants.length > 0) {
        parts.push(
          `${erroredTenants.length} tenant(s) could not be checked: ${erroredTenants.join("; ")}.`
        );
      }

      return { name, severity, status: "fail", evidence: parts.join(" ") };
    }

    return {
      name,
      severity,
      status: "pass",
      evidence: `Every connected Meta account across ${tenants.length} active tenant(s) has a supported account type, unexpired token, and all required scopes (or none are connected yet).`
    };
  } catch (error) {
    return {
      name,
      severity,
      status: "fail",
      evidence: `Could not verify Meta social publishing account readiness: ${errorMessage(error)}.`
    };
  }
}

export async function checkTelegramProviderReadiness(
  env: NodeJS.ProcessEnv = process.env
): Promise<SecurityCheckResult> {
  const name =
    "Telegram channel: every auto-publishing account has been verified (Issue #646)";
  const severity: CheckSeverity = "critical";

  if (!isTelegramProviderEnabled(env)) {
    return {
      name,
      severity,
      status: "pass",
      evidence:
        'TELEGRAM_PROVIDER_ENABLED is not "true" — Telegram channel publishing is disabled, no verification required.'
    };
  }

  try {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is not set.");
    }

    const sql = getDatabaseClient();
    const tenants = (await sql<{ id: string }[]>`
      SELECT id FROM awcms_mini_tenants WHERE status = 'active'
    `) as { id: string }[];

    let unverifiedCount = 0;
    const erroredTenants: string[] = [];

    for (const tenant of tenants) {
      const tenantId = assertUuid(tenant.id);

      try {
        await sql.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);

          const rows = (await tx`
            SELECT count(*)::int AS count
            FROM awcms_mini_social_accounts
            WHERE provider_key = 'telegram_channel'
              AND connection_status = 'connected'
              AND auto_publish_enabled = true
              AND last_verified_at IS NULL
          `) as { count: number }[];

          unverifiedCount += rows[0]?.count ?? 0;
        });
      } catch (error) {
        erroredTenants.push(`${tenantId} (${errorMessage(error)})`);
      }
    }

    if (unverifiedCount > 0 || erroredTenants.length > 0) {
      const parts: string[] = [];

      if (unverifiedCount > 0) {
        parts.push(
          `${unverifiedCount} connected telegram_channel account(s) have auto-publishing enabled but have never been verified via POST /api/v1/social-publishing/accounts/{id}/verify.`
        );
      }

      if (erroredTenants.length > 0) {
        parts.push(
          `${erroredTenants.length} tenant(s) could not be checked: ${erroredTenants.join("; ")}.`
        );
      }

      return { name, severity, status: "fail", evidence: parts.join(" ") };
    }

    return {
      name,
      severity,
      status: "pass",
      evidence: `Every auto-publishing telegram_channel account has been verified at least once across ${tenants.length} active tenant(s) (or none are connected yet).`
    };
  } catch (error) {
    return {
      name,
      severity,
      status: "fail",
      evidence: `Could not verify Telegram channel readiness: ${errorMessage(error)}.`
    };
  }
}

// ---------------------------------------------------------------------------
// Out-of-scope items — printed as their own report section, never silently
// dropped.
// ---------------------------------------------------------------------------

export const OUT_OF_SCOPE_ITEMS: OutOfScopeItem[] = [
  {
    name: "Tax data masking",
    reason:
      "No tax/Coretax module exists in this generic base — domain concern of a derived app (e.g. AWPOS)."
  },
  {
    name: "CRM opt-out respected",
    reason:
      "No CRM module exists in this generic base — domain concern of a derived app."
  },
  {
    name: "AI read-only",
    reason:
      "No AI analyst/tool-calling module exists in this generic base — domain concern of a derived app."
  },
  {
    name: "PostgreSQL not publicly exposed",
    reason:
      "Deployment-profile concern; `docker-compose.yml` (Issue 12.2) binds `db` to a firewalled/LAN host by operator configuration, not something this script can verify from source alone. Manual — check the actual deployed network exposure."
  },
  {
    name: "Least-privilege DB user",
    reason:
      "Deployment-profile concern (DB role/grants are provisioned at deploy time, not by this repo's code). Manual verification against the provisioned database."
  },
  {
    name: "Backup/restore tested",
    reason:
      "Requires a real backup/restore run against a provisioned environment using `deploy/backup/backup-postgres.sh` / `deploy/backup/restore-postgres.sh` (Issue 12.2; see skill `awcms-mini-production-preflight` §Backup & restore). Manual — run the scripts and verify a restored row count."
  },
  {
    name: "PostgreSQL version pinned",
    reason:
      "Deployment-profile concern — `docker-compose.yml` (Issue 12.2) pins `image: postgres:18.4`. Not independently re-verified here to avoid parsing YAML as a proxy for a real deployed version check; confirm the running server's version manually (`SELECT version();`)."
  }
];

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function runSecurityReadinessChecks(): Promise<
  SecurityCheckResult[]
> {
  return [
    await checkNoHardcodedSecret(),
    checkEnvNotTracked(),
    await checkPasswordHashingModern(),
    checkLoginLockoutImplemented(),
    await checkRlsEnabled(),
    await checkAppDbUserNotSuperuser(),
    await checkRuntimeRoleGlobalTableGrants(),
    checkAbacDefaultDeny(),
    await checkAuditLogTableReachable(),
    await checkSoftDeletePermissionsSeededAndAudited(),
    checkSyncHmacSecretNotDefault(),
    checkEmailProviderConfigReady(),
    checkOnlineAuthSecurityReady(),
    checkTurnstileReady(),
    checkMfaReady(),
    checkGoogleOidcReady(),
    checkSsoReady(),
    await checkSsoBreakGlassReady(),
    checkVisitorAnalyticsRawIpRetentionReady(),
    checkVisitorAnalyticsRawUserAgentRetentionReady(),
    checkVisitorAnalyticsGeoTrustedSourceReady(),
    checkVisitorAnalyticsRetentionOrderingReady(),
    checkVisitorAnalyticsHashSaltReady(),
    checkVisitorAnalyticsVisitorKeyCookieTtlReady(),
    checkNewsPortalFullOnlineR2PresetReady(),
    checkNewsMediaR2SvgNotAllowed(),
    checkNewsMediaR2PublicBaseUrlProductionSafe(),
    await checkNewsMediaR2NoStalePendingObjects(),
    await checkSocialPublishingProviderReadiness(),
    await checkMetaSocialPublishingAccountReadiness(),
    await checkTelegramProviderReadiness(),
    await checkErrorsDontLeakStackTraces(),
    await checkSecurityHeadersPresent(),
    checkLoginRateLimitImplemented()
  ];
}

function statusIcon(result: SecurityCheckResult): string {
  return result.status === "pass" ? "PASS" : "FAIL";
}

function printReport(results: SecurityCheckResult[]): boolean {
  console.log("security:readiness — production security readiness checklist");
  console.log("");

  for (const result of results) {
    console.log(
      `[${statusIcon(result)}] (${result.severity}) ${result.name}\n    ${result.evidence}`
    );
  }

  console.log("");
  console.log(
    "Out of scope for this generic base (documented, not silently dropped):"
  );

  for (const item of OUT_OF_SCOPE_ITEMS) {
    console.log(`  - ${item.name}: ${item.reason}`);
  }

  const criticalFailures = results.filter(
    (result) => result.severity === "critical" && result.status === "fail"
  );
  const warningFailures = results.filter(
    (result) => result.severity === "warning" && result.status === "fail"
  );

  console.log("");
  console.log(
    `Summary: ${results.length} check(s) run, ${criticalFailures.length} critical failure(s), ${warningFailures.length} warning failure(s).`
  );

  if (criticalFailures.length > 0) {
    console.log("GO-LIVE DIBLOKIR — critical finding(s) present:");
    for (const failure of criticalFailures) {
      console.log(`  - ${failure.name}: ${failure.evidence}`);
    }
    return false;
  }

  console.log("No critical findings — security:readiness passes.");
  return true;
}

async function main() {
  const results = await runSecurityReadinessChecks();
  const passed = printReport(results);

  if (!passed) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
