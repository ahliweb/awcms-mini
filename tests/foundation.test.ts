import { describe, expect, test } from "bun:test";

import { ok } from "../src/modules/_shared/api-response";
import {
  activeRecordPredicate,
  deletedRecordPredicate,
  shouldIncludeDeleted,
  shouldOnlyListDeleted,
} from "../src/modules/_shared/soft-delete";
import { getModuleByKey, listModules } from "../src/modules";
import {
  computeMigrationChecksum,
  redactDatabaseUrl,
  stripOptionalTransactionWrapper,
  validateAppliedChecksums,
} from "../scripts/db-migrate";
import {
  checkAsyncApi,
  checkOpenApi,
  runApiSpecChecks,
} from "../scripts/api-spec-check";

describe("api response helper", () => {
  test("ok() returns standardized JSON response", async () => {
    const response = ok({ status: "ok" }, { requestId: "req-1" });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: { status: "ok" },
      meta: { requestId: "req-1" },
    });
  });
});

describe("soft delete helper", () => {
  test("defaults to active records only", () => {
    expect(shouldIncludeDeleted()).toBe(false);
    expect(shouldOnlyListDeleted()).toBe(false);
    expect(activeRecordPredicate()).toBe("deleted_at IS NULL");
    expect(deletedRecordPredicate("table.deleted_at")).toBe(
      "table.deleted_at IS NOT NULL",
    );
  });

  test("includeDeleted and onlyDeleted are explicit", () => {
    expect(shouldIncludeDeleted({ includeDeleted: true })).toBe(true);
    expect(shouldIncludeDeleted({ onlyDeleted: true })).toBe(true);
    expect(shouldOnlyListDeleted({ includeDeleted: true })).toBe(false);
    expect(shouldOnlyListDeleted({ onlyDeleted: true })).toBe(true);
  });
});

describe("module registry", () => {
  test("foundation starts with no active modules", () => {
    expect(listModules()).toEqual([]);
    expect(getModuleByKey("tenant_admin")).toBeUndefined();
  });
});

describe("database migration runner helpers", () => {
  test("checksum is stable and prefixed", () => {
    const sql = "CREATE TABLE awcms_mini_example (id uuid PRIMARY KEY);";

    expect(computeMigrationChecksum(sql)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(computeMigrationChecksum(sql)).toBe(computeMigrationChecksum(sql));
  });

  test("optional BEGIN/COMMIT wrapper is stripped before runner transaction", () => {
    expect(stripOptionalTransactionWrapper("BEGIN;\nSELECT 1;\nCOMMIT;\n")).toBe(
      "SELECT 1;"
    );
  });

  test("applied checksum mismatch fails fast", () => {
    expect(() =>
      validateAppliedChecksums(
        [
          {
            name: "001_awcms_mini_foundation_schema.sql",
            path: "sql/001_awcms_mini_foundation_schema.sql",
            sql: "SELECT 1;",
            checksum: "sha256:new",
          },
        ],
        [
          {
            migration_name: "001_awcms_mini_foundation_schema.sql",
            checksum: "sha256:old",
          },
        ]
      )
    ).toThrow("Checksum mismatch");
  });

  test("database url redaction removes password-bearing url", () => {
    const databaseUrl =
      "postgres://awcms-mini:secret-password@localhost:5432/awcms-mini";

    expect(redactDatabaseUrl(`failed for ${databaseUrl}`, databaseUrl)).toBe(
      "failed for [redacted DATABASE_URL]"
    );
  });
});

describe("api contract baseline", () => {
  test("OpenAPI and AsyncAPI baseline files pass spec checks", async () => {
    await expect(runApiSpecChecks()).resolves.toEqual([]);
  });

  test("OpenAPI checker requires shared response schema", () => {
    expect(
      checkOpenApi(
        {
          openapi: "3.1.0",
          info: {},
          paths: { "/api/v1/health": { get: {} } },
          components: {
            schemas: {},
            securitySchemes: {},
            parameters: {},
          },
        },
        "openapi/test.yaml"
      ).some((problem) => problem.message.includes("ApiSuccess"))
    ).toBe(true);
  });

  test("AsyncAPI checker requires domain event envelope", () => {
    expect(
      checkAsyncApi(
        {
          asyncapi: "3.0.0",
          info: {},
          channels: {},
          components: { messages: {}, schemas: {}, securitySchemes: {} },
        },
        "asyncapi/test.yaml"
      ).some((problem) => problem.message.includes("DomainEventEnvelope"))
    ).toBe(true);
  });
});
