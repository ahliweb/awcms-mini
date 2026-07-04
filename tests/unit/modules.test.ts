import { describe, expect, test } from "bun:test";
import { findUnknownModuleDependencies } from "../../src/modules/_shared/module-contract";
import { getModuleByKey, modules } from "../../src/modules";

describe("module registry", () => {
  test("registers foundation modules with complete dependencies", () => {
    expect(modules.length).toBeGreaterThan(0);
    expect(findUnknownModuleDependencies(modules)).toEqual([]);
  });

  test("can look up module by key", () => {
    expect(getModuleByKey("identity_access")?.name).toBe("Identity & Access");
  });
});
