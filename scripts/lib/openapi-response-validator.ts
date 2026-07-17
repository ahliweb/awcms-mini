/**
 * Dependency-free validator of a real response body against a published
 * OpenAPI schema (Issue #844, epic #818).
 *
 * WHY this exists — and why it is hand-written rather than `ajv`:
 *
 *   Repo policy is Bun-only (AGENTS.md rule 14). `ajv` leans on a Node-shaped
 *   surface (its own module resolution, code-gen `Function` compilation, and a
 *   draft dialect that treats `allOf` + `additionalProperties: false` strictly
 *   per-branch). The public contract here uses the loose, MERGE reading of
 *   `allOf` (the `ApiSuccess` envelope + an inline `{ data }` branch each carry
 *   `additionalProperties: false`, which ajv would reject as mutually
 *   exclusive). So we implement exactly the JSON-Schema subset the published
 *   spec actually uses — `$ref`, `allOf` (merge), `oneOf`/`anyOf`, `type`,
 *   `enum`, `const`, `required`, `additionalProperties: false`, `properties`,
 *   `items`, `nullable` — and nothing more. This is the same schema-walker
 *   shape the narrow parity test already proved works under Bun, generalised.
 *
 * This module VALIDATES DATA AGAINST A PARSED SCHEMA. It never greps schema
 * source text — a gate that only asserted `source.includes("naturalKeyField")`
 * would be satisfied by prose and catch nothing. Every check here runs the
 * real object graph through the real schema graph.
 */
import { readFileSync } from "node:fs";
import { parse } from "yaml";

export type JsonSchema = {
  $ref?: string;
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  allOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  nullable?: boolean;
  // Anything else (description, format, example, minimum, ...) is intentionally
  // ignored: format/bounds are not response-fidelity concerns for this gate.
  [key: string]: unknown;
};

export type OpenApiDocument = Record<string, unknown>;

export function loadOpenApiDocument(path: string): OpenApiDocument {
  return parse(readFileSync(path, "utf8")) as OpenApiDocument;
}

/**
 * Resolve a single `#/...` JSON-pointer `$ref` against the root document.
 * Handles the `~1`→`/` and `~0`→`~` pointer escapes. Throws on a dangling
 * ref so a renamed/removed schema surfaces loudly rather than validating
 * against `undefined`.
 */
function resolvePointer(doc: OpenApiDocument, ref: string): JsonSchema {
  if (!ref.startsWith("#/")) {
    throw new Error(`Only local #/ refs are supported, got: ${ref}`);
  }
  const tokens = ref
    .slice(2)
    .split("/")
    .map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));

  let node: unknown = doc;
  for (const token of tokens) {
    if (node === null || typeof node !== "object") {
      throw new Error(`Dangling $ref ${ref}: stopped at token "${token}".`);
    }
    node = (node as Record<string, unknown>)[token];
  }
  if (node === undefined) {
    throw new Error(`Dangling $ref ${ref}: resolved to undefined.`);
  }
  return node as JsonSchema;
}

/** Follow a chain of `$ref`s until the schema is a concrete node. */
function deref(schema: JsonSchema, doc: OpenApiDocument): JsonSchema {
  let current = schema;
  const seen = new Set<string>();
  while (current && typeof current.$ref === "string") {
    if (seen.has(current.$ref)) {
      throw new Error(`Cyclic $ref chain at ${current.$ref}.`);
    }
    seen.add(current.$ref);
    current = resolvePointer(doc, current.$ref);
  }
  return current;
}

/**
 * Merge an `allOf` list (plus the container schema's own inline constraints)
 * into a single effective object schema. This is the LOOSE reading the
 * published contract relies on: the union of every branch's properties, the
 * union of every branch's `required`, and `additionalProperties: false` iff
 * any branch closes — validated against the merged property set, not per
 * branch (which is why `ajv`'s strict per-branch reading is unusable here).
 */
function mergeAllOf(schema: JsonSchema, doc: OpenApiDocument): JsonSchema {
  const branches = [schema, ...(schema.allOf ?? [])].map((b) => deref(b, doc));

  const merged: JsonSchema = { type: "object", properties: {}, required: [] };
  const required = new Set<string>();
  let closes = false;

  for (const branch of branches) {
    if (branch.type && branch.type !== "object") merged.type = branch.type;
    for (const [key, propSchema] of Object.entries(branch.properties ?? {})) {
      merged.properties![key] = propSchema;
    }
    for (const key of branch.required ?? []) required.add(key);
    if (branch.additionalProperties === false) closes = true;
    if (branch.enum && !merged.enum) merged.enum = branch.enum;
    if (branch.items && !merged.items) merged.items = branch.items;
    if ("const" in branch && !("const" in merged)) merged.const = branch.const;
    if (branch.nullable) merged.nullable = true;
  }

  merged.required = [...required];
  if (closes) merged.additionalProperties = false;
  return merged;
}

function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value; // object | string | number | boolean | undefined
}

function typeMatches(schemaType: string, value: unknown): boolean {
  const actual = jsonTypeOf(value);
  if (schemaType === "integer") {
    return typeof value === "number" && Number.isInteger(value);
  }
  if (schemaType === "number") return typeof value === "number";
  return actual === schemaType;
}

/**
 * Validate `value` against `schema` (resolved within `doc`). Returns a list of
 * human-readable violation paths — EMPTY means valid. Returning rather than
 * throwing lets a single run report every drifted key at once.
 */
export function validateAgainstSchema(
  value: unknown,
  schema: JsonSchema,
  doc: OpenApiDocument,
  path = "$"
): string[] {
  let effective = deref(schema, doc);

  // allOf: merge every branch into one effective object schema, then continue.
  if (effective.allOf && effective.allOf.length > 0) {
    effective = mergeAllOf(effective, doc);
  }

  // oneOf / anyOf: valid if at least one branch validates cleanly.
  const union = effective.oneOf ?? effective.anyOf;
  if (union && union.length > 0) {
    const branchProblems = union.map((branch) =>
      validateAgainstSchema(value, branch, doc, path)
    );
    if (branchProblems.some((p) => p.length === 0)) return [];
    return [`${path}: matched none of ${union.length} allowed schemas`];
  }

  // nullable (OpenAPI 3.0): null is acceptable when declared nullable.
  if (value === null) {
    if (effective.nullable) return [];
    if (!effective.type) return [];
    return [`${path}: null is not allowed here`];
  }

  const problems: string[] = [];

  // const / enum.
  if ("const" in effective && value !== effective.const) {
    problems.push(`${path}: expected const ${JSON.stringify(effective.const)}`);
  }
  if (effective.enum && !effective.enum.includes(value)) {
    problems.push(
      `${path}: ${JSON.stringify(value)} not in enum ${JSON.stringify(effective.enum)}`
    );
  }

  // type.
  const types = effective.type
    ? Array.isArray(effective.type)
      ? effective.type
      : [effective.type]
    : [];
  if (types.length > 0 && !types.some((t) => typeMatches(t, value))) {
    problems.push(
      `${path}: expected type ${types.join("|")}, got ${jsonTypeOf(value)}`
    );
    // Type mismatch makes deeper structural checks meaningless.
    return problems;
  }

  // object.
  if (jsonTypeOf(value) === "object") {
    const obj = value as Record<string, unknown>;
    const declared = effective.properties ?? {};

    for (const key of effective.required ?? []) {
      if (!(key in obj)) problems.push(`${path}.${key}: required but missing`);
    }

    for (const [key, child] of Object.entries(obj)) {
      const childSchema = declared[key];
      if (childSchema) {
        problems.push(
          ...validateAgainstSchema(child, childSchema, doc, `${path}.${key}`)
        );
      } else if (effective.additionalProperties === false) {
        problems.push(`${path}.${key}: undeclared property (schema is closed)`);
      } else if (
        effective.additionalProperties &&
        typeof effective.additionalProperties === "object"
      ) {
        problems.push(
          ...validateAgainstSchema(
            child,
            effective.additionalProperties,
            doc,
            `${path}.${key}`
          )
        );
      }
    }
  }

  // array.
  if (jsonTypeOf(value) === "array" && effective.items) {
    (value as unknown[]).forEach((item, index) => {
      problems.push(
        ...validateAgainstSchema(
          item,
          effective.items!,
          doc,
          `${path}[${index}]`
        )
      );
    });
  }

  return problems;
}

/**
 * Navigate to the response schema for one operation. `contentType` defaults to
 * JSON. Throws (not returns) when the path/method/status/content is absent, so
 * a route that quietly lost its documented success response fails the gate
 * instead of validating against nothing.
 */
export function getResponseSchema(
  doc: OpenApiDocument,
  args: {
    path: string;
    method: string;
    status: string;
    contentType?: string;
  }
): JsonSchema {
  const contentType = args.contentType ?? "application/json";
  const paths = doc.paths as Record<string, unknown> | undefined;
  const pathItem = paths?.[args.path] as Record<string, unknown> | undefined;
  const operation = pathItem?.[args.method.toLowerCase()] as
    Record<string, unknown> | undefined;
  const responses = operation?.responses as Record<string, unknown> | undefined;
  let response = responses?.[args.status] as JsonSchema | undefined;
  if (response?.$ref) response = deref(response, doc);

  const content = (response as Record<string, unknown> | undefined)?.content as
    Record<string, unknown> | undefined;
  const media = content?.[contentType] as Record<string, unknown> | undefined;
  const schema = media?.schema as JsonSchema | undefined;

  if (!schema) {
    throw new Error(
      `No ${args.method} ${args.path} -> ${args.status} ${contentType} schema found in the OpenAPI document.`
    );
  }
  return schema;
}
