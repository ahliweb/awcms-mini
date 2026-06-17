import test from "node:test";
import assert from "node:assert/strict";

import {
  resolvePostgresConnectionTarget,
  resolvePostgresPoolingMode,
  buildPostgresPoolConfig,
} from "../../src/db/client/postgres.mjs";

const DIRECT_URL = "postgres://app:secret@db.internal:5432/awcms_mini?sslmode=verify-full";
const POOLER_URL = "postgres://app:secret@pooler.internal:6432/awcms_mini?sslmode=require";

test("pooler: transport default direct memakai DATABASE_URL", () => {
  const target = resolvePostgresConnectionTarget({
    databaseUrl: DIRECT_URL,
    databaseTransport: "direct",
  });
  assert.equal(target.transport, "direct");
  assert.equal(target.source, "DATABASE_URL");
  assert.equal(target.connectionString, DIRECT_URL);
});

test("pooler: transport pooler + DATABASE_POOLER_URL memakai pooler", () => {
  const target = resolvePostgresConnectionTarget({
    databaseUrl: DIRECT_URL,
    databaseTransport: "pooler",
    databasePoolerUrl: POOLER_URL,
    databasePoolingMode: "session",
  });
  assert.equal(target.transport, "pooler");
  assert.equal(target.source, "DATABASE_POOLER_URL");
  assert.equal(target.connectionString, POOLER_URL);
  assert.equal(target.poolingMode, "session");
});

test("pooler: transport pooler tanpa poolerUrl fallback ke direct (aman)", () => {
  const target = resolvePostgresConnectionTarget({
    databaseUrl: DIRECT_URL,
    databaseTransport: "pooler",
    databasePoolerUrl: null,
  });
  assert.equal(target.transport, "direct");
  assert.equal(target.connectionString, DIRECT_URL);
});

test("pooler: resolvePostgresPoolingMode default session", () => {
  assert.equal(resolvePostgresPoolingMode({}), "session");
  assert.equal(resolvePostgresPoolingMode({ databasePoolingMode: "session" }), "session");
});

test("pooler: resolvePostgresPoolingMode transaction bila di-set", () => {
  assert.equal(resolvePostgresPoolingMode({ databasePoolingMode: "transaction" }), "transaction");
});

test("pooler: resolvePostgresPoolingMode nilai tak dikenal → session", () => {
  assert.equal(resolvePostgresPoolingMode({ databasePoolingMode: "weird" }), "session");
});

test("pooler: buildPostgresPoolConfig memakai pooler URL + SSL dari pooler URL", () => {
  const config = buildPostgresPoolConfig({
    databaseUrl: DIRECT_URL, // verify-full → rejectUnauthorized true
    databaseTransport: "pooler",
    databasePoolerUrl: POOLER_URL, // require → rejectUnauthorized false
    databasePoolingMode: "session",
    databaseConnectTimeoutMs: 8000,
  });
  assert.equal(config.connectionString, POOLER_URL);
  assert.equal(config.connectionTimeoutMillis, 8000);
  assert.equal(config.allowExitOnIdle, true);
  // SSL diturunkan dari pooler URL (require), bukan databaseUrl (verify-full)
  assert.deepEqual(config.ssl, { rejectUnauthorized: false });
});

test("pooler: buildPostgresPoolConfig direct tetap memakai DATABASE_URL + SSL-nya", () => {
  const config = buildPostgresPoolConfig({
    databaseUrl: DIRECT_URL,
    databaseTransport: "direct",
    databaseConnectTimeoutMs: 10000,
  });
  assert.equal(config.connectionString, DIRECT_URL);
  assert.deepEqual(config.ssl, { rejectUnauthorized: true });
});
