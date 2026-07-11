import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";

import { listModules } from "../src/modules";

type Problem = {
  file: string;
  message: string;
};

type AnyRecord = Record<string, unknown>;

export const OPENAPI_PATH = "openapi/awcms-mini-public-api.openapi.yaml";
export const ASYNCAPI_PATH = "asyncapi/awcms-mini-domain-events.asyncapi.yaml";
export const ROUTES_DIR = "src/pages/api/v1";

// Contract version (`info.version`) is independent SemVer, not the package
// version (ADR-0008) — this only enforces the *shape*, not a specific
// value, so a genuine contract bump never fails this check.
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

// Issue #685 (epic #679): operations that are DELIBERATELY documented as
// `security: []` (no auth required) — everything else inherits the global
// `bearerAuth` + `tenantHeader` requirement (see the spec's top-level
// `security:` block). This is a reviewed allow-list, not a derived value:
// adding a new public endpoint means editing this constant in the same PR
// as the OpenAPI change, so "a route silently became publicly documented"
// is always a visible diff, not something that slips in unnoticed.
export const ALLOWED_PUBLIC_OPERATIONS: readonly `${string} ${string}`[] = [
  "GET /api/v1/health",
  "GET /api/v1/database/pool/health",
  "GET /api/v1/setup/status",
  "POST /api/v1/setup/initialize"
];

export async function runApiSpecChecks(
  rootDir = process.cwd()
): Promise<Problem[]> {
  const openApiFile = path.join(rootDir, OPENAPI_PATH);
  const asyncApiFile = path.join(rootDir, ASYNCAPI_PATH);
  const problems: Problem[] = [];

  const openApi = await readYamlFile(openApiFile, OPENAPI_PATH, problems);
  const asyncApi = await readYamlFile(asyncApiFile, ASYNCAPI_PATH, problems);

  if (openApi) {
    problems.push(...checkOpenApi(openApi, OPENAPI_PATH));
    problems.push(...checkPublicOperationAllowlist(openApi, OPENAPI_PATH));
    problems.push(...(await checkRouteParity(openApi, rootDir, OPENAPI_PATH)));
  }

  if (asyncApi) {
    problems.push(...checkAsyncApi(asyncApi, ASYNCAPI_PATH));
    problems.push(...checkModuleEventChannels(asyncApi, ASYNCAPI_PATH));
  }

  return problems;
}

export function checkOpenApi(spec: unknown, file: string): Problem[] {
  const problems: Problem[] = [];
  const document = asRecord(spec);

  if (!document) {
    return [{ file, message: "OpenAPI document must be a YAML object." }];
  }

  if (typeof document.openapi !== "string") {
    problems.push({ file, message: "Missing OpenAPI version." });
  }

  const info = asRecord(document.info);

  if (!info) {
    problems.push({ file, message: "Missing OpenAPI info object." });
  } else if (
    typeof info.version !== "string" ||
    !SEMVER_PATTERN.test(info.version)
  ) {
    problems.push({
      file,
      message: "OpenAPI info.version must be a SemVer string (X.Y.Z)."
    });
  }

  const paths = asRecord(document.paths);

  if (!paths) {
    problems.push({ file, message: "Missing OpenAPI paths object." });
  } else if (!asRecord(paths["/api/v1/health"])?.get) {
    problems.push({ file, message: "Missing GET /api/v1/health path." });
  }

  const components = asRecord(document.components);
  const schemas = asRecord(components?.schemas);
  const securitySchemes = asRecord(components?.securitySchemes);
  const parameters = asRecord(components?.parameters);

  for (const schemaName of [
    "ApiSuccess",
    "ApiError",
    "ErrorDetail",
    "HealthResponse",
    "SoftDeleteQuery",
    "SoftDeleteRequest"
  ]) {
    if (!schemas?.[schemaName]) {
      problems.push({ file, message: `Missing shared schema ${schemaName}.` });
    }
  }

  for (const schemeName of ["bearerAuth", "tenantHeader", "syncHmac"]) {
    if (!securitySchemes?.[schemeName]) {
      problems.push({
        file,
        message: `Missing security scheme ${schemeName}.`
      });
    }
  }

  for (const parameterName of [
    "IdempotencyKey",
    "CorrelationId",
    "RequestId",
    "AcceptLanguage",
    "SyncNodeId",
    "SyncTimestamp",
    "SyncSignature"
  ]) {
    if (!parameters?.[parameterName]) {
      problems.push({
        file,
        message: `Missing header parameter ${parameterName}.`
      });
    }
  }

  const softDeleteSchema = asRecord(schemas?.SoftDeleteRequest);

  if (!softDeleteSchema?.properties) {
    problems.push({
      file,
      message: "SoftDeleteRequest must document delete_reason."
    });
  }

  return problems;
}

export function checkAsyncApi(spec: unknown, file: string): Problem[] {
  const problems: Problem[] = [];
  const document = asRecord(spec);

  if (!document) {
    return [{ file, message: "AsyncAPI document must be a YAML object." }];
  }

  if (typeof document.asyncapi !== "string") {
    problems.push({ file, message: "Missing AsyncAPI version." });
  }

  const info = asRecord(document.info);

  if (!info) {
    problems.push({ file, message: "Missing AsyncAPI info object." });
  } else if (
    typeof info.version !== "string" ||
    !SEMVER_PATTERN.test(info.version)
  ) {
    problems.push({
      file,
      message: "AsyncAPI info.version must be a SemVer string (X.Y.Z)."
    });
  }

  const channels = asRecord(document.channels);
  const components = asRecord(document.components);
  const messages = asRecord(components?.messages);
  const schemas = asRecord(components?.schemas);
  const securitySchemes = asRecord(components?.securitySchemes);

  if (!channels) {
    problems.push({ file, message: "Missing AsyncAPI channels object." });
  } else if (!channels["awcms-mini.sync.push.requested"]) {
    problems.push({
      file,
      message: "Missing baseline sync event channel."
    });
  }

  if (!messages?.DomainEvent) {
    problems.push({ file, message: "Missing DomainEvent message." });
  }

  if (!schemas?.DomainEventEnvelope) {
    problems.push({ file, message: "Missing DomainEventEnvelope schema." });
  }

  if (!securitySchemes?.syncHmac) {
    problems.push({ file, message: "Missing AsyncAPI syncHmac scheme." });
  }

  return problems;
}

/**
 * Issue #685 (epic #679): every operation must declare a security stance —
 * either explicit `security: []` (public, requires an entry in
 * `ALLOWED_PUBLIC_OPERATIONS`) or inherit the spec's global `bearerAuth` +
 * `tenantHeader` requirement. This catches an endpoint silently becoming
 * publicly documented (spec drift that would otherwise only be caught by
 * manual review) — adding a genuinely new public endpoint means updating
 * `ALLOWED_PUBLIC_OPERATIONS` in the same diff, making the change visible.
 * Also catches the allow-list going stale in the other direction (an entry
 * naming an operation that's no longer `security: []`), so the list can't
 * silently drift out of sync with the spec either.
 */
export function checkPublicOperationAllowlist(
  spec: unknown,
  file: string
): Problem[] {
  const problems: Problem[] = [];
  const paths = asRecord(asRecord(spec)?.paths);

  if (!paths) {
    return problems;
  }

  const actualPublic = new Set<string>();

  for (const [rawPath, opsValue] of Object.entries(paths)) {
    const ops = asRecord(opsValue);

    if (!ops) continue;

    for (const method of HTTP_METHODS) {
      const operation = asRecord(ops[method.toLowerCase()]);

      if (!operation) continue;

      if (
        Array.isArray(operation.security) &&
        operation.security.length === 0
      ) {
        actualPublic.add(`${method} ${rawPath}`);
      }
    }
  }

  for (const key of actualPublic) {
    if (!ALLOWED_PUBLIC_OPERATIONS.includes(key as `${string} ${string}`)) {
      problems.push({
        file,
        message: `${key} is documented as public (security: []) but is not in ALLOWED_PUBLIC_OPERATIONS (scripts/api-spec-check.ts) — add it there deliberately if this is intentional.`
      });
    }
  }

  for (const key of ALLOWED_PUBLIC_OPERATIONS) {
    if (!actualPublic.has(key)) {
      problems.push({
        file,
        message: `ALLOWED_PUBLIC_OPERATIONS lists ${key} but it is no longer documented as public (security: []) in the spec — remove it from the allow-list.`
      });
    }
  }

  return problems;
}

/**
 * Issue #685 (epic #679): route-method-operation parity between the actual
 * Astro API route files under `src/pages/api/v1/**` and the OpenAPI
 * `paths` they're supposed to document. Two directions, both checked:
 * a route file exporting a handler with no matching OpenAPI operation
 * (undocumented endpoint), and an OpenAPI operation with no corresponding
 * route file (stale/removed-endpoint documentation). Paths are compared
 * STRUCTURALLY (every dynamic segment — `[id]` in a route filename,
 * `{id}` in the OpenAPI path — normalized to a single wildcard token)
 * rather than by exact string match, since the two sides are free to use
 * different parameter names for the same segment.
 */
export async function checkRouteParity(
  spec: unknown,
  rootDir: string,
  file: string
): Promise<Problem[]> {
  const problems: Problem[] = [];
  const paths = asRecord(asRecord(spec)?.paths);

  if (!paths) {
    return problems;
  }

  const routesDir = path.join(rootDir, ROUTES_DIR);
  const routeFiles = await walkRouteFiles(routesDir);
  const routeMethodsByPath = new Map<string, Set<string>>();

  for (const absoluteFile of routeFiles) {
    const relative = path.relative(routesDir, absoluteFile);
    const apiPath = normalizeApiPath(routeFileToApiPath(relative));
    const content = await readFile(absoluteFile, "utf8");
    const methods = new Set<string>();

    for (const method of HTTP_METHODS) {
      if (new RegExp(`^export const ${method}\\b`, "m").test(content)) {
        methods.add(method);
      }
    }

    if (methods.size === 0) {
      continue;
    }

    const existing = routeMethodsByPath.get(apiPath) ?? new Set<string>();

    for (const m of methods) existing.add(m);

    routeMethodsByPath.set(apiPath, existing);
  }

  const specMethodsByPath = new Map<string, Set<string>>();

  for (const [rawPath, opsValue] of Object.entries(paths)) {
    const ops = asRecord(opsValue);

    if (!ops) continue;

    const normPath = normalizeApiPath(rawPath);
    const methods = new Set<string>(
      Object.keys(ops)
        .map((m) => m.toUpperCase())
        .filter((m) => (HTTP_METHODS as readonly string[]).includes(m))
    );

    specMethodsByPath.set(normPath, methods);
  }

  for (const [normPath, methods] of routeMethodsByPath) {
    const specMethods = specMethodsByPath.get(normPath) ?? new Set<string>();

    for (const method of methods) {
      if (!specMethods.has(method)) {
        problems.push({
          file,
          message: `Route file exports ${method} for ${normPath} (via src/pages/api/v1/**) but the OpenAPI spec has no matching operation.`
        });
      }
    }
  }

  for (const [normPath, methods] of specMethodsByPath) {
    const routeMethods = routeMethodsByPath.get(normPath) ?? new Set<string>();

    for (const method of methods) {
      if (!routeMethods.has(method)) {
        problems.push({
          file,
          message: `OpenAPI spec documents ${method} ${normPath} but no route file under src/pages/api/v1/** exports a matching handler.`
        });
      }
    }
  }

  return problems;
}

async function walkRouteFiles(dir: string): Promise<string[]> {
  let entries;

  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await walkRouteFiles(full)));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }

  return files;
}

function routeFileToApiPath(relativeFromRoutesDir: string): string {
  const withoutExt = relativeFromRoutesDir.replace(/\.ts$/, "");
  const withoutIndex = withoutExt.replace(/\/index$/, "");

  return `/api/v1/${withoutIndex}`;
}

function normalizeApiPath(apiPath: string): string {
  return apiPath
    .split("/")
    .map((segment) => {
      const isOpenApiParam = segment.startsWith("{") && segment.endsWith("}");
      const isRouteParam = segment.startsWith("[") && segment.endsWith("]");

      return isOpenApiParam || isRouteParam ? "*" : segment;
    })
    .join("/");
}

export function checkModuleEventChannels(
  asyncApi: unknown,
  file: string
): Problem[] {
  const channels = asRecord(asRecord(asyncApi)?.channels);
  const problems: Problem[] = [];

  if (!channels) {
    return problems;
  }

  for (const module of listModules()) {
    for (const eventName of module.events?.publishes ?? []) {
      if (!channels[eventName]) {
        problems.push({
          file,
          message: `Module ${module.key} publishes ${eventName}, but channel is missing.`
        });
      }
    }
  }

  return problems;
}

async function readYamlFile(
  absolutePath: string,
  displayPath: string,
  problems: Problem[]
): Promise<unknown | undefined> {
  try {
    const source = await readFile(absolutePath, "utf8");
    const document = parseDocument(source);

    for (const error of document.errors) {
      problems.push({ file: displayPath, message: error.message });
    }

    if (document.errors.length > 0) {
      return undefined;
    }

    return document.toJSON();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    problems.push({ file: displayPath, message });
    return undefined;
  }
}

function asRecord(input: unknown): AnyRecord | undefined {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as AnyRecord;
  }

  return undefined;
}

if (import.meta.main) {
  const problems = await runApiSpecChecks();

  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`${problem.file}: ${problem.message}`);
    }

    process.exitCode = 1;
  } else {
    console.log("api:spec:check OK — OpenAPI and AsyncAPI baseline valid.");
  }
}
