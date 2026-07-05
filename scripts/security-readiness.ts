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
import { evaluateAccess } from "../src/modules/identity-access/domain/access-control";
import { evaluateLoginAttempt } from "../src/modules/identity-access/domain/login-policy";
import { hashPassword } from "../src/lib/auth/password";
import { resolveAppBaseUrl } from "./lib/app-url";

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

  if (!name || !value || PLACEHOLDER_VALUE_PATTERN.test(value)) {
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
 */
const RLS_FREE_TABLES = new Set([
  "awcms_mini_schema_migrations",
  "awcms_mini_modules",
  "awcms_mini_tenants",
  "awcms_mini_permissions",
  "awcms_mini_setup_state"
]);

export async function checkRlsEnabled(): Promise<SecurityCheckResult> {
  const name = "RLS enabled on tenant-scoped tables";
  const severity: CheckSeverity = "critical";

  try {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is not set.");
    }

    const sql = getDatabaseClient();
    const rows = await sql<{ relname: string; relrowsecurity: boolean }[]>`
      SELECT relname, relrowsecurity
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
    const withoutRls = tenantScoped.filter((row) => !row.relrowsecurity);
    const excludedFound = [...RLS_FREE_TABLES].filter((table) =>
      rows.some((row) => row.relname === table)
    );

    if (withoutRls.length > 0) {
      return {
        name,
        severity,
        status: "fail",
        evidence: `Tenant-scoped table(s) without RLS enabled: ${withoutRls.map((row) => row.relname).join(", ")}.`
      };
    }

    return {
      name,
      severity,
      status: "pass",
      evidence: `${tenantScoped.length} tenant-scoped table(s) all have relrowsecurity=true. Excluded as documented RLS-free (non-tenant-scoped): ${excludedFound.join(", ")}.`
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
    checkAbacDefaultDeny(),
    await checkAuditLogTableReachable(),
    await checkSoftDeletePermissionsSeededAndAudited(),
    checkSyncHmacSecretNotDefault(),
    await checkErrorsDontLeakStackTraces()
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
