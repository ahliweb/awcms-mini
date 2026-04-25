import { sql } from "kysely";

import {
  applyLocalCloudflareRuntimeEnv,
  loadLocalEnvFiles,
} from "./_local-env.mjs";
import { describeDatabaseHealthPosture } from "../src/db/health.mjs";
import { createDatabase } from "../src/db/index.mjs";

const DEFAULT_DISALLOWED_USERS = ["postgres"];

function normalizeOptionalString(value) {
  if (typeof value !== "string") {
    return null;
  }

  const next = value.trim();
  return next.length > 0 ? next : null;
}

function normalizeList(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }

  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return entries.length > 0 ? entries : fallback;
}

function readExpectedRolePolicy() {
  return {
    disallowedUsers: normalizeList(
      process.env.DATABASE_ROLE_AUDIT_DISALLOWED_USERS,
      DEFAULT_DISALLOWED_USERS,
    ),
  };
}

function getFirstRow(result) {
  const [row] = result.rows;

  if (!row) {
    throw new Error("Database role audit query returned no rows");
  }

  return row;
}

async function readRuntimeRole(db) {
  const identity = getFirstRow(
    await sql`
      select
        current_user as current_user,
        session_user as session_user,
        current_database() as database_name
    `.execute(db),
  );

  const privileges = getFirstRow(
    await sql`
      select
        rolsuper,
        rolcreaterole,
        rolcreatedb,
        rolreplication,
        rolbypassrls
      from pg_roles
      where rolname = current_user
    `.execute(db),
  );

  return {
    currentUser: identity.current_user ?? null,
    sessionUser: identity.session_user ?? null,
    databaseName: identity.database_name ?? null,
    privileges: {
      superuser: Boolean(privileges.rolsuper),
      createRole: Boolean(privileges.rolcreaterole),
      createDatabase: Boolean(privileges.rolcreatedb),
      replication: Boolean(privileges.rolreplication),
      bypassRls: Boolean(privileges.rolbypassrls),
    },
  };
}

function collectFindings(role, policy) {
  const findings = [];

  if (policy.disallowedUsers.includes(role.currentUser)) {
    findings.push({
      severity: "high",
      code: "database-disallowed-runtime-user",
      message:
        "The active database runtime user is disallowed for AWCMS Mini application access.",
    });
  }

  if (role.privileges.superuser) {
    findings.push({
      severity: "high",
      code: "database-runtime-superuser",
      message: "The active database runtime user is a PostgreSQL superuser.",
    });
  }

  if (role.privileges.createRole) {
    findings.push({
      severity: "medium",
      code: "database-runtime-create-role",
      message: "The active database runtime user can create roles.",
    });
  }

  if (role.privileges.createDatabase) {
    findings.push({
      severity: "medium",
      code: "database-runtime-create-database",
      message: "The active database runtime user can create databases.",
    });
  }

  if (role.privileges.replication) {
    findings.push({
      severity: "medium",
      code: "database-runtime-replication",
      message: "The active database runtime user has replication privileges.",
    });
  }

  if (role.privileges.bypassRls) {
    findings.push({
      severity: "medium",
      code: "database-runtime-bypass-rls",
      message:
        "The active database runtime user can bypass row-level security.",
    });
  }

  return findings;
}

async function main() {
  loadLocalEnvFiles();
  applyLocalCloudflareRuntimeEnv();

  const db = createDatabase();

  try {
    const policy = readExpectedRolePolicy();
    const role = await readRuntimeRole(db);
    const findings = collectFindings(role, policy);
    const result = {
      ok: findings.length === 0,
      service: "database-role-posture",
      posture: describeDatabaseHealthPosture(),
      role,
      expected: policy,
      findings,
      redaction:
        "DATABASE_URL, passwords, tokens, and connection strings are intentionally omitted.",
      timestamp: new Date().toISOString(),
    };

    console.log(JSON.stringify(result, null, 2));

    if (!result.ok) {
      process.exitCode = 1;
    }
  } finally {
    await db.destroy();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        service: "database-role-posture",
        error: {
          message:
            error instanceof Error
              ? error.message
              : "database role audit failed",
        },
        redaction:
          "DATABASE_URL, passwords, tokens, and connection strings are intentionally omitted.",
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
