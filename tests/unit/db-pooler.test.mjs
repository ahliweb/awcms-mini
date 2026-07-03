import test from "node:test";
import assert from "node:assert/strict";

import {
  resolvePostgresConnectionTarget,
  resolvePostgresPoolingMode,
  buildPostgresPoolConfig,
  setHyperdriveConnectionString,
  applyHyperdriveBindingFromEnv,
  getInjectedHyperdriveConnectionString,
} from "../../src/db/client/postgres.mjs";

const DIRECT_URL = "postgres://app:secret@db.internal:5432/awcms_mini?sslmode=verify-full";
const POOLER_URL = "postgres://app:secret@pooler.internal:6432/awcms_mini?sslmode=require";
const HYPERDRIVE_URL = "postgres://app:secret@127.0.0.1:6432/awcms_mini";

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

// --- Hyperdrive (planet-scale via Cloudflare) ---

test("hyperdrive: transport hyperdrive memakai connection string statis (config)", () => {
  setHyperdriveConnectionString(null); // pastikan tidak ada injeksi
  const target = resolvePostgresConnectionTarget({
    databaseUrl: DIRECT_URL,
    databaseTransport: "hyperdrive",
    databaseHyperdriveUrl: HYPERDRIVE_URL,
  });
  assert.equal(target.transport, "hyperdrive");
  assert.equal(target.source, "HYPERDRIVE");
  assert.equal(target.connectionString, HYPERDRIVE_URL);
  assert.equal(target.poolingMode, "transaction", "Hyperdrive pooling di sisi server → klien transaction mode");
});

test("hyperdrive: connection string yang di-inject dari binding diprioritaskan", () => {
  const injectedUrl = "postgres://inj:secret@127.0.0.1:6432/awcms_mini";
  setHyperdriveConnectionString(injectedUrl);
  try {
    const target = resolvePostgresConnectionTarget({
      databaseUrl: DIRECT_URL,
      databaseTransport: "hyperdrive",
      databaseHyperdriveUrl: HYPERDRIVE_URL, // kalah prioritas dari injeksi
    });
    assert.equal(target.source, "HYPERDRIVE");
    assert.equal(target.connectionString, injectedUrl);
  } finally {
    setHyperdriveConnectionString(null);
  }
});

test("hyperdrive: opsi eksplisit menang atas injeksi dan config", () => {
  setHyperdriveConnectionString("postgres://inj:secret@127.0.0.1:6432/awcms_mini");
  try {
    const explicit = "postgres://opt:secret@127.0.0.1:6432/awcms_mini";
    const target = resolvePostgresConnectionTarget(
      { databaseTransport: "hyperdrive", databaseHyperdriveUrl: HYPERDRIVE_URL },
      { hyperdriveConnectionString: explicit },
    );
    assert.equal(target.connectionString, explicit);
  } finally {
    setHyperdriveConnectionString(null);
  }
});

test("hyperdrive: tanpa connection string → fallback aman ke direct (bukan crash)", () => {
  setHyperdriveConnectionString(null);
  const target = resolvePostgresConnectionTarget({
    databaseUrl: DIRECT_URL,
    databaseTransport: "hyperdrive",
    databaseHyperdriveUrl: null,
  });
  assert.equal(target.transport, "direct");
  assert.equal(target.connectionString, DIRECT_URL);
});

test("hyperdrive: applyHyperdriveBindingFromEnv membaca env.HYPERDRIVE.connectionString", () => {
  try {
    const result = applyHyperdriveBindingFromEnv({ HYPERDRIVE: { connectionString: HYPERDRIVE_URL } });
    assert.equal(result, HYPERDRIVE_URL);
    assert.equal(getInjectedHyperdriveConnectionString(), HYPERDRIVE_URL);
  } finally {
    setHyperdriveConnectionString(null);
  }
});

test("hyperdrive: applyHyperdriveBindingFromEnv tanpa binding = no-op (null)", () => {
  setHyperdriveConnectionString(null);
  assert.equal(applyHyperdriveBindingFromEnv({}), null);
  assert.equal(applyHyperdriveBindingFromEnv(undefined), null);
  assert.equal(getInjectedHyperdriveConnectionString(), null);
});

test("hyperdrive: buildPostgresPoolConfig memakai Hyperdrive URL (tanpa SSL paksa)", () => {
  setHyperdriveConnectionString(null);
  const config = buildPostgresPoolConfig({
    databaseUrl: DIRECT_URL, // verify-full → tidak dipakai
    databaseTransport: "hyperdrive",
    databaseHyperdriveUrl: HYPERDRIVE_URL, // tanpa sslmode → ssl undefined (Hyperdrive terminasi TLS ke origin)
    databaseConnectTimeoutMs: 10000,
  });
  assert.equal(config.connectionString, HYPERDRIVE_URL);
  assert.equal(config.ssl, undefined);
});
