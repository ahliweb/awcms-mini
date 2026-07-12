/**
 * Unit tests for the DR/chaos drill safety interlock (Issue #699, epic
 * #679). Pure functions, no DB/network — must always run as part of
 * `bun test`/`bun run check`, proving the "production-like target
 * detection blocks execution by default" acceptance criterion
 * deterministically and without any real infrastructure.
 */
import { describe, expect, test } from "bun:test";

import {
  authorizeDrDrill,
  isProductionLikeTarget
} from "../../src/lib/resilience/target-guard";

describe("isProductionLikeTarget", () => {
  test("treats an unset DATABASE_URL as production-like (default-deny)", () => {
    const result = isProductionLikeTarget(undefined);
    expect(result.likely).toBe(true);
  });

  test("treats an unparsable DATABASE_URL as production-like", () => {
    const result = isProductionLikeTarget("not a url");
    expect(result.likely).toBe(true);
  });

  test("treats localhost as not production-like", () => {
    expect(
      isProductionLikeTarget("postgres://user:pass@localhost:5432/db").likely
    ).toBe(false);
  });

  test("treats 127.0.0.1 as not production-like", () => {
    expect(
      isProductionLikeTarget("postgres://user:pass@127.0.0.1:25515/db").likely
    ).toBe(false);
  });

  test("treats an RDS-style hostname as production-like even with a database name like 'test'", () => {
    expect(
      isProductionLikeTarget(
        "postgres://user:pass@mydb.abc123.us-east-1.rds.amazonaws.com:5432/test"
      ).likely
    ).toBe(true);
  });

  test("treats a hostname containing 'prod' as production-like", () => {
    expect(
      isProductionLikeTarget("postgres://user:pass@prod-db.internal:5432/db")
        .likely
    ).toBe(true);
  });

  test("treats an unrecognized hostname as production-like by default (not just known-safe or known-bad)", () => {
    expect(
      isProductionLikeTarget(
        "postgres://user:pass@some-random-internal-host:5432/db"
      ).likely
    ).toBe(true);
  });
});

describe("authorizeDrDrill", () => {
  const safeDatabaseUrl = "postgres://user:pass@localhost:25515/db";

  test("refuses APP_ENV=production unconditionally, even with a matching --confirm-non-production", () => {
    const result = authorizeDrDrill({
      appEnv: "production",
      databaseUrl: safeDatabaseUrl,
      confirmNonProduction: "production"
    });

    expect(result.ok).toBe(false);
  });

  test("refuses a production-like database host even when APP_ENV is not production", () => {
    const result = authorizeDrDrill({
      appEnv: "test",
      databaseUrl: "postgres://user:pass@prod-db.internal:5432/db",
      confirmNonProduction: "test"
    });

    expect(result.ok).toBe(false);
  });

  test("refuses when --confirm-non-production is missing", () => {
    const result = authorizeDrDrill({
      appEnv: "test",
      databaseUrl: safeDatabaseUrl,
      confirmNonProduction: null
    });

    expect(result.ok).toBe(false);
  });

  test("refuses when --confirm-non-production does not match APP_ENV (typo-catcher)", () => {
    const result = authorizeDrDrill({
      appEnv: "test",
      databaseUrl: safeDatabaseUrl,
      confirmNonProduction: "development"
    });

    expect(result.ok).toBe(false);
  });

  test("authorizes when everything lines up: non-production APP_ENV, safe host, matching confirmation", () => {
    const result = authorizeDrDrill({
      appEnv: "test",
      databaseUrl: safeDatabaseUrl,
      confirmNonProduction: "test"
    });

    expect(result.ok).toBe(true);
  });

  test("refuses an unset APP_ENV even with a safe host and a plausible confirmation value", () => {
    const result = authorizeDrDrill({
      appEnv: undefined,
      databaseUrl: safeDatabaseUrl,
      confirmNonProduction: "development"
    });

    expect(result.ok).toBe(false);
  });
});
