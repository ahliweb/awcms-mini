import { checkDatabaseHealth, describeDatabaseHealthPosture } from "../src/db/health.mjs";
import { loadLocalEnvFiles } from "./_local-env.mjs";

function normalizeOptionalString(value) {
  if (typeof value !== "string") {
    return null;
  }

  const next = value.trim();
  return next.length > 0 ? next : null;
}

function readExpectedDatabasePosture() {
  return {
    transport: normalizeOptionalString(process.env.HEALTHCHECK_EXPECT_DATABASE_TRANSPORT),
    hostname: normalizeOptionalString(process.env.HEALTHCHECK_EXPECT_DATABASE_HOSTNAME),
    sslmode: normalizeOptionalString(process.env.HEALTHCHECK_EXPECT_DATABASE_SSLMODE),
  };
}

function assertExpectedDatabasePosture(actual, expected) {
  const checks = [
    ["transport", expected.transport],
    ["hostname", expected.hostname],
    ["sslmode", expected.sslmode],
  ].filter(([, expectedValue]) => expectedValue !== null);

  for (const [field, expectedValue] of checks) {
    if (actual[field] !== expectedValue) {
      throw new Error(`Healthcheck expected database ${field}=${expectedValue} but found ${actual[field] ?? "null"}`);
    }
  }
}

async function main() {
  loadLocalEnvFiles();
  const database = await checkDatabaseHealth();
  const databasePosture = describeDatabaseHealthPosture();
  const expectedDatabasePosture = readExpectedDatabasePosture();

  if (database.ok) {
    assertExpectedDatabasePosture(databasePosture, expectedDatabasePosture);
  }

  const result = {
    ok: database.ok,
    service: "awcms-mini",
    checks: {
      app: {
        ok: true,
        message: "runtime validation script executed",
      },
      database: {
        ...database,
        posture: databasePosture,
        expected: expectedDatabasePosture,
      },
    },
    timestamp: new Date().toISOString(),
  };

  console.log(JSON.stringify(result, null, 2));

  if (!database.ok) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
