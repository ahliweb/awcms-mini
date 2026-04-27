import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPostgresPoolConfig,
  resolvePostgresConnectionString,
  resolvePostgresConnectionTarget,
} from "../../src/db/client/postgres.mjs";
import { describeDatabaseHealthPosture } from "../../src/db/health.mjs";
import {
  DATABASE_ERROR_KIND,
  DATABASE_ERROR_REASON,
  classifyDatabaseError,
  describeDatabaseErrorReason,
  extractDatabaseErrorMessage,
  formatDatabaseErrorDiagnostic,
} from "../../src/db/errors.mjs";
import { defineTransactionStrategy, withTransaction } from "../../src/db/transactions.mjs";

function normalizeOptionalString(value) {
  if (typeof value !== "string") {
    return null;
  }

  const next = value.trim();
  return next.length > 0 ? next : null;
}

function readExpectedDatabasePostureFromEnv(env) {
  return {
    transport: normalizeOptionalString(env.HEALTHCHECK_EXPECT_DATABASE_TRANSPORT),
    hostname: normalizeOptionalString(env.HEALTHCHECK_EXPECT_DATABASE_HOSTNAME),
    sslmode: normalizeOptionalString(env.HEALTHCHECK_EXPECT_DATABASE_SSLMODE),
    binding: normalizeOptionalString(env.HEALTHCHECK_EXPECT_HYPERDRIVE_BINDING),
  };
}

function assertExpectedDatabasePosture(actual, expected) {
  const checks = [
    ["transport", expected.transport],
    ["hostname", expected.hostname],
    ["sslmode", expected.sslmode],
    ["binding", expected.binding],
  ].filter(([, expectedValue]) => expectedValue !== null);

  for (const [field, expectedValue] of checks) {
    if (actual[field] !== expectedValue) {
      throw new Error(`Healthcheck expected database ${field}=${expectedValue} but found ${actual[field] ?? "null"}`);
    }
  }
}

function createControlledTransactionRecorder() {
  const calls = [];

  const savepointTrx = {
    releaseSavepoint(name) {
      return {
        async execute() {
          calls.push(["releaseSavepoint", name]);
        },
      };
    },
    rollbackToSavepoint(name) {
      return {
        async execute() {
          calls.push(["rollbackToSavepoint", name]);
        },
      };
    },
  };

  const trx = {
    commit() {
      return {
        async execute() {
          calls.push(["commit"]);
        },
      };
    },
    rollback() {
      return {
        async execute() {
          calls.push(["rollback"]);
        },
      };
    },
    savepoint(name) {
      return {
        async execute() {
          calls.push(["savepoint", name]);
          return savepointTrx;
        },
      };
    },
  };

  return { trx, calls };
}

test("classifyDatabaseError identifies authentication failures", () => {
  const kind = classifyDatabaseError({ code: "28P01", message: "password authentication failed" });
  assert.equal(kind, DATABASE_ERROR_KIND.AUTHENTICATION);
});

test("classifyDatabaseError identifies missing relation failures", () => {
  const kind = classifyDatabaseError(new Error('relation "kysely_migration" does not exist'));
  assert.equal(kind, DATABASE_ERROR_KIND.NOT_FOUND);
});

test("describeDatabaseErrorReason identifies connection timeout failures", () => {
  const reason = describeDatabaseErrorReason(new Error("Connection terminated due to connection timeout"));
  assert.equal(reason, DATABASE_ERROR_REASON.CONNECTION_TIMEOUT);
});

test("describeDatabaseErrorReason identifies Hyperdrive binding failures", () => {
  const reason = describeDatabaseErrorReason(
    new Error("Hyperdrive transport requires the Cloudflare binding 'HYPERDRIVE' with a connectionString value."),
  );
  assert.equal(reason, DATABASE_ERROR_REASON.HYPERDRIVE_BINDING);
});

test("describeDatabaseErrorReason identifies DNS failures", () => {
  const reason = describeDatabaseErrorReason(new Error("getaddrinfo ENOTFOUND id1.ahlikoding.com"));
  assert.equal(reason, DATABASE_ERROR_REASON.DNS);
});

test("classifyDatabaseError identifies aggregate ETIMEDOUT failures as connection blockers", () => {
  const error = new Error("AggregateError [ETIMEDOUT]: ");

  assert.equal(classifyDatabaseError(error), DATABASE_ERROR_KIND.CONNECTION);
  assert.equal(describeDatabaseErrorReason(error), DATABASE_ERROR_REASON.CONNECTION_TIMEOUT);
});

test("classifyDatabaseError identifies malformed SCRAM credential input as authentication-related", () => {
  const error = new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string");
  assert.equal(classifyDatabaseError(error), DATABASE_ERROR_KIND.AUTHENTICATION);
  assert.equal(describeDatabaseErrorReason(error), DATABASE_ERROR_REASON.CREDENTIAL_FORMAT);
});

test("extractDatabaseErrorMessage falls back to the first stack line when message is empty", () => {
  const error = new Error("");
  error.stack = "Error: SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string\n    at fake:1:1";

  assert.equal(extractDatabaseErrorMessage(error), "SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string");
});

test("formatDatabaseErrorDiagnostic returns non-secret operator diagnostics", () => {
  const diagnostic = formatDatabaseErrorDiagnostic(new Error("Connection terminated due to connection timeout"));

  assert.deepEqual(diagnostic, {
    kind: DATABASE_ERROR_KIND.CONNECTION,
    reason: DATABASE_ERROR_REASON.CONNECTION_TIMEOUT,
    message: "Connection terminated due to connection timeout",
  });
});

test("formatDatabaseErrorDiagnostic preserves stack-derived messages for malformed credential errors", () => {
  const error = new Error("");
  error.stack = "Error: SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string\n    at fake:1:1";

  const diagnostic = formatDatabaseErrorDiagnostic(error);

  assert.deepEqual(diagnostic, {
    kind: DATABASE_ERROR_KIND.AUTHENTICATION,
    reason: DATABASE_ERROR_REASON.CREDENTIAL_FORMAT,
    message: "SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string",
  });
});

test("buildPostgresPoolConfig keeps DATABASE_URL as the transport source of truth", () => {
  const config = buildPostgresPoolConfig({
    databaseUrl: "postgres://awcms_mini_app:secret@id1.ahlikoding.com:5432/awcms_mini?sslmode=verify-full",
    databaseTransport: "direct",
    databaseConnectTimeoutMs: 10000,
  });

  assert.deepEqual(config, {
    connectionString: "postgres://awcms_mini_app:secret@id1.ahlikoding.com:5432/awcms_mini?sslmode=verify-full",
    connectionTimeoutMillis: 10000,
    allowExitOnIdle: true,
  });
});

test("buildPostgresPoolConfig preserves reviewed interim SSL modes when explicitly configured", () => {
  const config = buildPostgresPoolConfig({
    databaseUrl: "postgres://awcms_mini_app:secret@db.example.internal:5432/awcms_mini?sslmode=require",
    databaseTransport: "direct",
    databaseConnectTimeoutMs: 5000,
  });

  assert.equal(config.connectionString, "postgres://awcms_mini_app:secret@db.example.internal:5432/awcms_mini?sslmode=require");
   assert.equal(config.connectionTimeoutMillis, 5000);
   assert.equal(config.allowExitOnIdle, true);
});

test("resolvePostgresConnectionString uses the reviewed Hyperdrive binding when transport is enabled", () => {
  const connectionString = resolvePostgresConnectionString(
    {
      databaseUrl: "postgres://unused-local-default",
      databaseTransport: "hyperdrive",
      hyperdriveBinding: "HYPERDRIVE",
    },
    {
      workersEnv: {
        HYPERDRIVE: {
          connectionString: "postgres://hyperdrive-user:secret@hyperdrive.cloudflare.example:5432/awcms_mini",
        },
      },
    },
  );

  assert.equal(connectionString, "postgres://hyperdrive-user:secret@hyperdrive.cloudflare.example:5432/awcms_mini");
});

test("resolvePostgresConnectionString falls back to the local Hyperdrive compatibility env when no binding is present", () => {
  const connectionString = resolvePostgresConnectionString(
    {
      databaseUrl: "postgres://unused-local-default",
      databaseTransport: "hyperdrive",
      hyperdriveBinding: "HYPERDRIVE",
    },
    {
      workersEnv: {},
      env: {
        CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE:
          "postgres://hyperdrive-local-user:secret@localhost:55432/awcms_mini_dev",
      },
    },
  );

  assert.equal(connectionString, "postgres://hyperdrive-local-user:secret@localhost:55432/awcms_mini_dev");
});

test("resolvePostgresConnectionTarget describes the local Hyperdrive compatibility fallback", () => {
  const target = resolvePostgresConnectionTarget(
    {
      databaseUrl: "postgres://unused-local-default",
      databaseTransport: "hyperdrive",
      hyperdriveBinding: "HYPERDRIVE",
    },
    {
      workersEnv: {},
      env: {
        CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE:
          "postgres://hyperdrive-local-user:secret@localhost:55432/awcms_mini_dev",
      },
    },
  );

  assert.deepEqual(target, {
    transport: "hyperdrive",
    source: "Local Hyperdrive compatibility env",
    binding: "HYPERDRIVE",
    localConnectionStringVariable: "CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE",
    connectionString: "postgres://hyperdrive-local-user:secret@localhost:55432/awcms_mini_dev",
  });
});

test("resolvePostgresConnectionString fails clearly when Hyperdrive transport is selected without a binding", () => {
  assert.throws(
    () =>
      resolvePostgresConnectionString(
        {
          databaseUrl: "postgres://unused-local-default",
          databaseTransport: "hyperdrive",
          hyperdriveBinding: "HYPERDRIVE",
        },
        { workersEnv: {} },
      ),
    /Hyperdrive transport requires the Cloudflare binding 'HYPERDRIVE'/,
  );
});

test("describeDatabaseHealthPosture reports direct transport without exposing credentials", () => {
  const posture = describeDatabaseHealthPosture({
    databaseUrl: "postgres://awcms_mini_app:secret@id1.ahlikoding.com:5432/awcms_mini?sslmode=verify-full",
    databaseTransport: "direct",
    runtimeTarget: "cloudflare",
  });

  assert.deepEqual(posture, {
    transport: "direct",
    runtimeTarget: "cloudflare",
    source: "DATABASE_URL",
    hostname: "id1.ahlikoding.com",
    port: 5432,
    database: "awcms_mini",
    sslmode: "verify-full",
  });
});

test("describeDatabaseHealthPosture reports Hyperdrive binding posture without a connection string", () => {
  const posture = describeDatabaseHealthPosture({
    databaseUrl: "postgres://unused-local-default",
    databaseTransport: "hyperdrive",
    hyperdriveBinding: "HYPERDRIVE",
    runtimeTarget: "cloudflare",
  });

  assert.deepEqual(posture, {
    transport: "hyperdrive",
    runtimeTarget: "cloudflare",
    source: "Cloudflare Hyperdrive binding",
    binding: "HYPERDRIVE",
  });
});

test("describeDatabaseHealthPosture reports local Hyperdrive compatibility posture distinctly", () => {
  const posture = describeDatabaseHealthPosture(
    {
      databaseUrl: "postgres://unused-local-default",
      databaseTransport: "hyperdrive",
      hyperdriveBinding: "HYPERDRIVE",
      runtimeTarget: "cloudflare",
    },
    {
      workersEnv: {},
      env: {
        CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE:
          "postgres://hyperdrive-local-user:secret@localhost:55432/awcms_mini_dev",
      },
    },
  );

  assert.deepEqual(posture, {
    transport: "hyperdrive",
    runtimeTarget: "cloudflare",
    source: "Local Hyperdrive compatibility env",
    binding: "HYPERDRIVE",
    localConnectionStringVariable: "CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE",
  });
});

test("healthcheck expected posture parsing keeps unset assertions optional", () => {
  assert.deepEqual(readExpectedDatabasePostureFromEnv({}), {
    transport: null,
    hostname: null,
    sslmode: null,
    binding: null,
  });
});

test("healthcheck expected posture accepts matching direct posture", () => {
  const actual = describeDatabaseHealthPosture({
    databaseUrl: "postgres://awcms_mini_app:secret@id1.ahlikoding.com:5432/awcms_mini?sslmode=verify-full",
    databaseTransport: "direct",
    runtimeTarget: "cloudflare",
  });
  const expected = readExpectedDatabasePostureFromEnv({
    HEALTHCHECK_EXPECT_DATABASE_TRANSPORT: "direct",
    HEALTHCHECK_EXPECT_DATABASE_HOSTNAME: "id1.ahlikoding.com",
    HEALTHCHECK_EXPECT_DATABASE_SSLMODE: "verify-full",
  });

  assert.doesNotThrow(() => assertExpectedDatabasePosture(actual, expected));
});

test("healthcheck expected posture rejects mismatched Hyperdrive binding", () => {
  const actual = describeDatabaseHealthPosture({
    databaseUrl: "postgres://unused-local-default",
    databaseTransport: "hyperdrive",
    hyperdriveBinding: "HYPERDRIVE",
    runtimeTarget: "cloudflare",
  });
  const expected = readExpectedDatabasePostureFromEnv({
    HEALTHCHECK_EXPECT_DATABASE_TRANSPORT: "hyperdrive",
    HEALTHCHECK_EXPECT_HYPERDRIVE_BINDING: "OTHER_BINDING",
  });

  assert.throws(() => assertExpectedDatabasePosture(actual, expected), /database binding=OTHER_BINDING/);
});

test("defineTransactionStrategy validates supported strategies", () => {
  assert.deepEqual(defineTransactionStrategy("reuse"), { nested: "reuse" });
  assert.throws(() => defineTransactionStrategy("invalid"), /Unsupported transaction strategy/);
});

test("withTransaction commits root transaction on success", async () => {
  const { trx, calls } = createControlledTransactionRecorder();
  const db = {
    startTransaction() {
      return {
        async execute() {
          calls.push(["startTransaction"]);
          return trx;
        },
      };
    },
  };

  const result = await withTransaction(db, async (executor) => {
    assert.equal(executor, trx);
    calls.push(["callback"]);
    return "ok";
  });

  assert.equal(result, "ok");
  assert.deepEqual(calls, [["startTransaction"], ["callback"], ["commit"]]);
});

test("withTransaction rolls back root transaction on failure", async () => {
  const { trx, calls } = createControlledTransactionRecorder();
  const db = {
    startTransaction() {
      return {
        async execute() {
          calls.push(["startTransaction"]);
          return trx;
        },
      };
    },
  };

  await assert.rejects(
    () =>
      withTransaction(db, async () => {
        calls.push(["callback"]);
        throw new Error("boom");
      }),
    /boom/,
  );

  assert.deepEqual(calls, [["startTransaction"], ["callback"], ["rollback"]]);
});

test("withTransaction reuses nested controlled transaction by default", async () => {
  const { trx, calls } = createControlledTransactionRecorder();

  const result = await withTransaction(trx, async (executor) => {
    assert.equal(executor, trx);
    calls.push(["callback"]);
    return "nested";
  });

  assert.equal(result, "nested");
  assert.deepEqual(calls, [["callback"]]);
});

test("withTransaction supports nested savepoint strategy", async () => {
  const { trx, calls } = createControlledTransactionRecorder();

  const result = await withTransaction(
    trx,
    async (executor) => {
      calls.push(["callback", executor !== trx]);
      return "savepoint";
    },
    { nested: "savepoint", savepointName: "unit_test" },
  );

  assert.equal(result, "savepoint");
  assert.deepEqual(calls, [
    ["savepoint", "unit_test"],
    ["callback", true],
    ["releaseSavepoint", "unit_test"],
  ]);
});
