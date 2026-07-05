import { describe, expect, test } from "bun:test";

import { ok } from "../src/modules/_shared/api-response";
import {
  activeRecordPredicate,
  deletedRecordPredicate,
  shouldIncludeDeleted,
  shouldOnlyListDeleted,
} from "../src/modules/_shared/soft-delete";
import { getModuleByKey, listModules } from "../src/modules";

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
