/**
 * `GET /api/v1/data-exchange/descriptors` serves the module registry's
 * descriptors more or less verbatim, so the TypeScript descriptor shape and
 * the published `DataExchangeDescriptor` schema are two hand-maintained copies
 * of one contract — with nothing tying them together.
 *
 * They already drifted once: `sensitiveFields.naturalKeyField` (Issue #820)
 * was added to the descriptor type and set by the default
 * `data_exchange.reference_items` descriptor, while the schema kept
 * `additionalProperties: false` listing only `fieldNames`/`rawValuePermission`
 * — so the endpoint's real response violated its own published contract, and
 * every gate stayed green. `api:spec:check` only proves the BUNDLE is fresh
 * relative to its sources; it never compares a response, or the data a
 * response is built from, against a schema. Nothing else in the repo does
 * either (no ajv, no runtime schema validation anywhere).
 *
 * This validates the REAL registry descriptors against the REAL schema, so a
 * new descriptor property cannot ship without the schema learning about it.
 * Narrow by design: it covers the drift that actually happened rather than
 * standing in for general response-vs-schema contract validation, which is
 * tracked separately as Issue #844.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

import { listModules } from "../../src/modules";
import { collectExchangeDescriptors } from "../../src/modules/data-exchange/domain/exchange-registry";

const SPEC_PATH = "openapi/modules/data-exchange.openapi.yaml";

type SchemaNode = {
  type?: string;
  properties?: Record<string, SchemaNode>;
  additionalProperties?: boolean;
  required?: string[];
};

function loadSchema(name: string): SchemaNode {
  const spec = parse(readFileSync(SPEC_PATH, "utf8")) as {
    components?: { schemas?: Record<string, SchemaNode> };
  };
  const schema = spec.components?.schemas?.[name];
  if (!schema) {
    throw new Error(
      `${SPEC_PATH} has no components.schemas.${name} — the schema this test pins was renamed or removed.`
    );
  }
  return schema;
}

/**
 * Every key present on `value` must be declared in `schema.properties` when
 * the schema is closed (`additionalProperties: false`). Returns the offending
 * paths rather than throwing, so one failure can report every drifted key at
 * once instead of only the first.
 */
function undeclaredKeys(
  value: Record<string, unknown>,
  schema: SchemaNode,
  path: string
): string[] {
  if (schema.additionalProperties !== false) return [];

  const declared = new Set(Object.keys(schema.properties ?? {}));
  const problems: string[] = [];

  for (const [key, child] of Object.entries(value)) {
    if (!declared.has(key)) {
      problems.push(`${path}.${key}`);
      continue;
    }

    const childSchema = schema.properties?.[key];
    if (
      childSchema &&
      child !== null &&
      typeof child === "object" &&
      !Array.isArray(child)
    ) {
      problems.push(
        ...undeclaredKeys(
          child as Record<string, unknown>,
          childSchema,
          `${path}.${key}`
        )
      );
    }
  }

  return problems;
}

describe("data-exchange descriptor contract parity", () => {
  const descriptors = collectExchangeDescriptors(listModules());

  test("the registry actually has descriptors to check -- an empty list would make every assertion below vacuous", () => {
    expect(descriptors.length).toBeGreaterThan(0);
  });

  test("no registered descriptor carries a property the published DataExchangeDescriptor schema does not declare", () => {
    const schema = loadSchema("DataExchangeDescriptor");
    const problems = descriptors.flatMap((descriptor) =>
      undeclaredKeys(
        descriptor as unknown as Record<string, unknown>,
        schema,
        descriptor.key
      )
    );

    expect(problems).toEqual([]);
  });

  test("naturalKeyField specifically is declared -- the exact key that drifted (Issue #820)", () => {
    const schema = loadSchema("DataExchangeDescriptor");
    const sensitiveFields = schema.properties?.sensitiveFields;

    expect(sensitiveFields).toBeDefined();
    expect(Object.keys(sensitiveFields!.properties ?? {})).toContain(
      "naturalKeyField"
    );
  });

  test("the parity check is load-bearing: an undeclared property IS reported", () => {
    const schema = loadSchema("DataExchangeDescriptor");
    const problems = undeclaredKeys(
      { key: "x", somethingUndeclared: 1 },
      schema,
      "synthetic"
    );

    // Without this, a closed-schema check that silently passed everything
    // would look identical to a clean run.
    expect(problems).toEqual(["synthetic.somethingUndeclared"]);
  });
});
