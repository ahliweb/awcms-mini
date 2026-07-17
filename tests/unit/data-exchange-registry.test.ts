/**
 * Exchange descriptor registry validation tests (Issue #752). Mirrors
 * `data-lifecycle`'s own registry test shape.
 */
import { describe, expect, test } from "bun:test";

import {
  collectExchangeDescriptors,
  formatExchangeRegistryIssue,
  validateExchangeRegistry
} from "../../src/modules/data-exchange/domain/exchange-registry";
import { listModules } from "../../src/modules";
import type {
  ExchangeDescriptor,
  ModuleDescriptor
} from "../../src/modules/_shared/module-contract";

function baseDescriptor(
  overrides: Partial<ExchangeDescriptor> = {}
): ExchangeDescriptor {
  return {
    key: "data_exchange.reference_items",
    ownerModuleKey: "data_exchange",
    direction: "both",
    formats: ["csv", "json"],
    schemaVersion: "1.0",
    limits: { maxFileBytes: 1024, maxRowCount: 100, maxFieldsPerRow: 10 },
    adapterRegistryKey: "reference_items",
    sensitiveFields: { fieldNames: [] },
    description: "test descriptor",
    ...overrides
  };
}

function fakeModule(descriptor: ExchangeDescriptor): ModuleDescriptor {
  return {
    key: "data_exchange",
    name: "Data Exchange",
    version: "0.1.0",
    status: "active",
    description: "test",
    dependencies: [],
    dataExchange: [descriptor]
  };
}

describe("validateExchangeRegistry — the REAL registry", () => {
  test("the real listModules() registry has zero validation issues", () => {
    const result = validateExchangeRegistry(listModules());
    expect(result.issues.map(formatExchangeRegistryIssue)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test("collectExchangeDescriptors finds the reference_items descriptor", () => {
    const descriptors = collectExchangeDescriptors(listModules());
    expect(
      descriptors.some((d) => d.key === "data_exchange.reference_items")
    ).toBe(true);
  });
});

describe("validateExchangeRegistry — synthetic invalid descriptors", () => {
  test("rejects an ownerModuleKey that does not match the declaring module", () => {
    const descriptor = baseDescriptor({ ownerModuleKey: "some_other_module" });
    const result = validateExchangeRegistry([fakeModule(descriptor)]);

    expect(result.valid).toBe(false);
    expect(
      result.issues.some((i) => i.message.includes("ownerModuleKey"))
    ).toBe(true);
  });

  test("rejects a malformed key", () => {
    const descriptor = baseDescriptor({ key: "NOT VALID" });
    const result = validateExchangeRegistry([fakeModule(descriptor)]);
    expect(result.valid).toBe(false);
  });

  test("rejects an empty formats array", () => {
    const descriptor = baseDescriptor({ formats: [] });
    const result = validateExchangeRegistry([fakeModule(descriptor)]);
    expect(result.valid).toBe(false);
  });

  test("rejects limits.maxRowCount exceeding the hard ceiling", () => {
    const descriptor = baseDescriptor({
      limits: { maxFileBytes: 1024, maxRowCount: 999_999, maxFieldsPerRow: 10 }
    });
    const result = validateExchangeRegistry([fakeModule(descriptor)]);
    expect(result.valid).toBe(false);
  });

  test("rejects limits.maxFileBytes exceeding the HTTP-layer hard ceiling", () => {
    const descriptor = baseDescriptor({
      limits: {
        maxFileBytes: 999_999_999,
        maxRowCount: 100,
        maxFieldsPerRow: 10
      }
    });
    const result = validateExchangeRegistry([fakeModule(descriptor)]);
    expect(result.valid).toBe(false);
  });

  test("rejects a missing adapterRegistryKey", () => {
    const descriptor = baseDescriptor({ adapterRegistryKey: "" });
    const result = validateExchangeRegistry([fakeModule(descriptor)]);
    expect(result.valid).toBe(false);
  });

  // Issue #820 Cacat 1: `sensitiveFields` used to be optional, and omitting
  // it made the preview route return every staged value raw with no
  // raw-value check at all — forgetting to declare it OPENED the data.
  test("rejects a descriptor that omits sensitiveFields entirely", () => {
    const descriptor = baseDescriptor();
    delete (descriptor as { sensitiveFields?: unknown }).sensitiveFields;
    const result = validateExchangeRegistry([fakeModule(descriptor)]);
    expect(result.valid).toBe(false);
    expect(
      result.issues.some((i) =>
        i.message.includes("sensitiveFields is required")
      )
    ).toBe(true);
  });

  test("accepts an explicit empty sensitiveFields.fieldNames (affirmatively non-sensitive)", () => {
    const result = validateExchangeRegistry([
      fakeModule(baseDescriptor({ sensitiveFields: { fieldNames: [] } }))
    ]);
    expect(result.valid).toBe(true);
  });

  test("rejects an empty sensitiveFields.naturalKeyField", () => {
    const descriptor = baseDescriptor({
      sensitiveFields: { fieldNames: [], naturalKeyField: "" }
    });
    const result = validateExchangeRegistry([fakeModule(descriptor)]);
    expect(result.valid).toBe(false);
  });

  test("rejects sensitiveFields with fieldNames but no rawValuePermission", () => {
    const descriptor = baseDescriptor({
      sensitiveFields: { fieldNames: ["ssn"] }
    });
    const result = validateExchangeRegistry([fakeModule(descriptor)]);
    expect(result.valid).toBe(false);
  });

  test("accepts sensitiveFields with fieldNames AND rawValuePermission", () => {
    const descriptor = baseDescriptor({
      sensitiveFields: {
        fieldNames: ["ssn"],
        rawValuePermission: "some_module.items.read_raw"
      }
    });
    const result = validateExchangeRegistry([fakeModule(descriptor)]);
    expect(result.valid).toBe(true);
  });

  test("rejects a malformed requiredPermission (not module.activity.action shape)", () => {
    const descriptor = baseDescriptor({
      requiredPermission: "not-a-valid-key"
    });
    const result = validateExchangeRegistry([fakeModule(descriptor)]);
    expect(result.valid).toBe(false);
    expect(
      result.issues.some((i) => i.message.includes("requiredPermission"))
    ).toBe(true);
  });

  test("accepts a well-formed requiredPermission", () => {
    const descriptor = baseDescriptor({
      requiredPermission: "reference_data.items.write"
    });
    const result = validateExchangeRegistry([fakeModule(descriptor)]);
    expect(result.valid).toBe(true);
  });

  test("rejects a malformed sensitiveFields.rawValuePermission shape", () => {
    const descriptor = baseDescriptor({
      sensitiveFields: { fieldNames: ["ssn"], rawValuePermission: "bad key" }
    });
    const result = validateExchangeRegistry([fakeModule(descriptor)]);
    expect(result.valid).toBe(false);
  });

  test("rejects a duplicate key across two modules", () => {
    const descriptorA = baseDescriptor({ ownerModuleKey: "module_a" });
    const descriptorB = baseDescriptor({ ownerModuleKey: "module_b" });
    const moduleA: ModuleDescriptor = {
      ...fakeModule(descriptorA),
      key: "module_a"
    };
    const moduleB: ModuleDescriptor = {
      ...fakeModule(descriptorB),
      key: "module_b"
    };

    const result = validateExchangeRegistry([moduleA, moduleB]);
    expect(result.valid).toBe(false);
    expect(
      result.issues.some((i) => i.message.includes("registered 2 times"))
    ).toBe(true);
  });
});
