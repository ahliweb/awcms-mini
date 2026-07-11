import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";

import { listModules } from "../src/modules";
import { bundleOpenApi } from "./openapi-bundle";

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

// Issue #695 (epic #679): a reviewed, explicit list of route files under
// `src/pages/api/v1/**` that are DELIBERATELY not part of the public OpenAPI
// contract (internal-only route, or gated behind a conditional/experimental
// feature flag not ready to be documented as a stable contract yet) — same
// pattern as `CONFIG_EXEMPTIONS` (Issue #689) and `DYNAMIC_KEY_FAMILIES`
// (Issue #694): one file everyone reviews, not an implicit heuristic. Format
// matches `checkRouteParity`'s normalized path keying (`METHOD /normalized/
// path/with/*/for/dynamic/segments`). Empty today — every existing route
// file has a matching OpenAPI operation; add an entry here (in the same PR
// that adds the route) if a genuinely internal/conditional route needs to
// exist without public documentation.
export const ROUTE_PARITY_EXEMPTIONS: readonly `${string} ${string}`[] = [];

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
    problems.push(...checkOperationIdUniqueness(openApi, OPENAPI_PATH));
    problems.push(...checkPathParameters(openApi, OPENAPI_PATH));
    problems.push(...checkStandardErrorSchema(openApi, OPENAPI_PATH));
    problems.push(...checkOperationSecurityMetadata(openApi, OPENAPI_PATH));
    problems.push(...(await checkBundleFreshness(rootDir, OPENAPI_PATH)));
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
 * PR #711 review (Issue #695, epic #679): per the OpenAPI 3.x spec, an
 * EMPTY security requirement object (`{}`) inside a `security` array means
 * "this alternative is satisfied with no credentials at all" — since an
 * operation only needs ONE array element to be satisfied, a `security`
 * array containing even one `{}` alongside other real requirements is
 * effectively unauthenticated, identical in practice to `security: []`.
 * Both `checkPublicOperationAllowlist` (empty-array form) and
 * `checkOperationSecurityMetadata` (per-scheme validation) need to treat
 * this the same way `security: []` is treated, or a `security: [{}]`
 * operation could merge as an undocumented, un-allow-listed public
 * endpoint without either check flagging it (security-auditor finding,
 * PR #711 review — confirmed zero such operations exist in the spec
 * today, but the checkers themselves had this gap).
 */
function hasEmptySecurityRequirement(security: unknown): boolean {
  if (!Array.isArray(security)) return false;

  return security.some((requirement) => {
    const requirementRecord = asRecord(requirement);
    return (
      requirementRecord !== undefined &&
      Object.keys(requirementRecord).length === 0
    );
  });
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
        (Array.isArray(operation.security) &&
          operation.security.length === 0) ||
        hasEmptySecurityRequirement(operation.security)
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
      if (specMethods.has(method)) continue;

      const key = `${method} ${normPath}` as `${string} ${string}`;

      if (ROUTE_PARITY_EXEMPTIONS.includes(key)) continue;

      problems.push({
        file,
        message: `Route file exports ${method} for ${normPath} (via src/pages/api/v1/**) but the OpenAPI spec has no matching operation. If this route is deliberately internal/conditional and not part of the public contract, add "${key}" to ROUTE_PARITY_EXEMPTIONS (scripts/api-spec-check.ts).`
      });
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

  for (const key of ROUTE_PARITY_EXEMPTIONS) {
    const [method, normPath] = key.split(" ") as [string, string];
    const routeMethods = routeMethodsByPath.get(normPath);
    const specMethods = specMethodsByPath.get(normPath);
    const stillUndocumented =
      routeMethods?.has(method) && !(specMethods?.has(method) ?? false);

    if (!stillUndocumented) {
      problems.push({
        file,
        message: `ROUTE_PARITY_EXEMPTIONS lists "${key}" (scripts/api-spec-check.ts) but that route is no longer undocumented (either the route file no longer exports it, or the OpenAPI spec now documents it) — remove it from the exemption list.`
      });
    }
  }

  return problems;
}

/**
 * Issue #695 (epic #679): every `operationId` in the bundled spec must be
 * globally unique. Duplicate `operationId`s break codegen (client SDK
 * generators key off this field) and, more importantly here, would have
 * silently defeated the module split's schema-ownership computation had one
 * existed before Issue #695 — this is a permanent guard against a duplicate
 * being reintroduced (accidental copy-paste of a whole operation block into
 * a new module fragment is the most likely cause going forward).
 */
export function checkOperationIdUniqueness(
  spec: unknown,
  file: string
): Problem[] {
  const problems: Problem[] = [];
  const paths = asRecord(asRecord(spec)?.paths);

  if (!paths) {
    return problems;
  }

  const locationsByOperationId = new Map<string, string[]>();

  for (const [rawPath, opsValue] of Object.entries(paths)) {
    const ops = asRecord(opsValue);

    if (!ops) continue;

    for (const method of HTTP_METHODS) {
      const operation = asRecord(ops[method.toLowerCase()]);

      if (!operation || typeof operation.operationId !== "string") continue;

      const locations = locationsByOperationId.get(operation.operationId) ?? [];

      locations.push(`${method} ${rawPath}`);
      locationsByOperationId.set(operation.operationId, locations);
    }
  }

  for (const [operationId, locations] of locationsByOperationId) {
    if (locations.length > 1) {
      problems.push({
        file,
        message: `Duplicate operationId "${operationId}" used by ${locations.join(" AND ")} — operationId must be globally unique.`
      });
    }
  }

  return problems;
}

/**
 * Issue #695 (epic #679): every `{param}` token in a path template must have
 * exactly one matching `parameters` entry with `in: path`, `required: true`
 * on every operation for that path (and vice versa — no declared path
 * parameter that isn't actually in the URL). Parameters may be declared
 * inline or via `$ref` into `components.parameters`; both are resolved.
 */
export function checkPathParameters(spec: unknown, file: string): Problem[] {
  const problems: Problem[] = [];
  const document = asRecord(spec);
  const paths = asRecord(document?.paths);
  const componentParameters = asRecord(
    asRecord(document?.components)?.parameters
  );

  if (!paths) {
    return problems;
  }

  function resolveParameter(param: unknown): AnyRecord | undefined {
    const record = asRecord(param);

    if (!record) return undefined;

    if (typeof record.$ref === "string") {
      const match = record.$ref.match(/^#\/components\/parameters\/(.+)$/);

      return match ? asRecord(componentParameters?.[match[1]!]) : undefined;
    }

    return record;
  }

  for (const [rawPath, opsValue] of Object.entries(paths)) {
    const ops = asRecord(opsValue);

    if (!ops) continue;

    const urlParams = new Set(
      [...rawPath.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!)
    );

    for (const method of HTTP_METHODS) {
      const operation = asRecord(ops[method.toLowerCase()]);

      if (!operation) continue;

      const declaredPathParams = new Set<string>();
      const parameters = Array.isArray(operation.parameters)
        ? operation.parameters
        : [];

      for (const param of parameters) {
        const resolved = resolveParameter(param);

        if (!resolved || resolved.in !== "path") continue;

        if (resolved.required !== true) {
          problems.push({
            file,
            message: `${method} ${rawPath}: path parameter "${String(resolved.name)}" must declare required: true.`
          });
        }

        if (typeof resolved.name === "string") {
          declaredPathParams.add(resolved.name);
        }
      }

      for (const name of urlParams) {
        if (!declaredPathParams.has(name)) {
          problems.push({
            file,
            message: `${method} ${rawPath}: path segment "{${name}}" has no matching parameters entry (in: path, required: true, name: ${name}).`
          });
        }
      }

      for (const name of declaredPathParams) {
        if (!urlParams.has(name)) {
          problems.push({
            file,
            message: `${method} ${rawPath}: declares path parameter "${name}" but it does not appear as {${name}} in the path template.`
          });
        }
      }
    }
  }

  return problems;
}

/**
 * Issue #695 (epic #679): every non-2xx/3xx response across every operation
 * must resolve — directly, via `$ref` into `components.responses`, or
 * through `allOf`/`oneOf`/`anyOf` — to the shared `ApiError` schema (`src/
 * modules/_shared/api-response.ts`'s `fail()` envelope), not an ad-hoc
 * inline error shape. A `oneOf` alongside another schema (e.g. `POST /auth/
 * login`'s 401, which can also be `LoginMfaRequiredResponse`) still counts
 * as long as `ApiError` is one of the alternatives — the endpoint may
 * legitimately overload the status code with a non-error variant, but the
 * standard error shape must still be documented as possible.
 */
export function checkStandardErrorSchema(
  spec: unknown,
  file: string
): Problem[] {
  const problems: Problem[] = [];
  const document = asRecord(spec);
  const paths = asRecord(document?.paths);
  const responseComponents = asRecord(
    asRecord(document?.components)?.responses
  );

  if (!paths) {
    return problems;
  }

  function schemaReferencesApiError(schema: unknown, depth = 0): boolean {
    if (depth > 8) return false;

    const record = asRecord(schema);

    if (!record) return false;

    if (record.$ref === "#/components/schemas/ApiError") return true;

    for (const key of ["allOf", "oneOf", "anyOf"] as const) {
      const variants = record[key];

      if (
        Array.isArray(variants) &&
        variants.some((v) => schemaReferencesApiError(v, depth + 1))
      ) {
        return true;
      }
    }

    return false;
  }

  function resolvesToApiError(responseValue: unknown, depth = 0): boolean {
    if (depth > 8) return false;

    const record = asRecord(responseValue);

    if (!record) return false;

    if (typeof record.$ref === "string") {
      const match = record.$ref.match(/^#\/components\/responses\/(.+)$/);

      return match
        ? resolvesToApiError(responseComponents?.[match[1]!], depth + 1)
        : false;
    }

    const schema = asRecord(
      asRecord(record.content)?.["application/json"]
    )?.schema;

    return schemaReferencesApiError(schema);
  }

  for (const [rawPath, opsValue] of Object.entries(paths)) {
    const ops = asRecord(opsValue);

    if (!ops) continue;

    for (const method of HTTP_METHODS) {
      const operation = asRecord(ops[method.toLowerCase()]);
      const responses = asRecord(operation?.responses);

      if (!responses) continue;

      for (const [status, responseValue] of Object.entries(responses)) {
        const code = Number(status);
        const isErrorStatus =
          status === "default" || (Number.isFinite(code) && code >= 400);

        if (!isErrorStatus) continue;

        if (!resolvesToApiError(responseValue)) {
          problems.push({
            file,
            message: `${method} ${rawPath}: response "${status}" does not resolve to the shared ApiError schema (components.schemas.ApiError) — use $ref to a components.responses/* entry or reference ApiError directly instead of an ad-hoc error shape.`
          });
        }
      }
    }
  }

  return problems;
}

/**
 * Issue #695 (epic #679): extends `checkPublicOperationAllowlist` (Issue
 * #685) — that check only handles operations with EXPLICIT
 * `security: []`. This one covers the other gap: an operation that omits
 * `security` entirely (which, per the OpenAPI spec, silently inherits the
 * document's global `security:` default instead of failing) and isn't in
 * `ALLOWED_PUBLIC_OPERATIONS` either. Every operation in this contract
 * today declares `security` explicitly (checked, zero exceptions) — this
 * keeps it that way so "does this endpoint require auth" is always
 * answerable by reading the operation itself, never by cross-referencing
 * the document-level default. Also validates every named scheme inside an
 * operation's `security` requirement actually exists in
 * `components.securitySchemes` (catches a typo'd scheme name, which
 * `checkOpenApi`'s existence check for the schemes themselves doesn't
 * catch).
 */
export function checkOperationSecurityMetadata(
  spec: unknown,
  file: string
): Problem[] {
  const problems: Problem[] = [];
  const document = asRecord(spec);
  const paths = asRecord(document?.paths);
  const securitySchemes = asRecord(
    asRecord(document?.components)?.securitySchemes
  );

  if (!paths) {
    return problems;
  }

  for (const [rawPath, opsValue] of Object.entries(paths)) {
    const ops = asRecord(opsValue);

    if (!ops) continue;

    for (const method of HTTP_METHODS) {
      const operation = asRecord(ops[method.toLowerCase()]);

      if (!operation) continue;

      const key = `${method} ${rawPath}`;

      if (operation.security === undefined) {
        if (!ALLOWED_PUBLIC_OPERATIONS.includes(key as `${string} ${string}`)) {
          problems.push({
            file,
            message: `${key} declares no security requirement at all (inherits the document's global default) and is not in ALLOWED_PUBLIC_OPERATIONS — declare security explicitly (either the real requirement, or security: [] plus an allow-list entry if it is genuinely public).`
          });
        }
        continue;
      }

      if (!Array.isArray(operation.security)) continue;

      if (
        hasEmptySecurityRequirement(operation.security) &&
        !ALLOWED_PUBLIC_OPERATIONS.includes(key as `${string} ${string}`)
      ) {
        problems.push({
          file,
          message: `${key}: security requirement includes an empty alternative ({}), which OpenAPI treats as "satisfied without credentials" — this operation is effectively public and is not in ALLOWED_PUBLIC_OPERATIONS. Remove the empty requirement, or add an allow-list entry if it is genuinely public.`
        });
      }

      for (const requirement of operation.security) {
        const requirementRecord = asRecord(requirement);

        if (!requirementRecord) continue;

        for (const schemeName of Object.keys(requirementRecord)) {
          if (!securitySchemes?.[schemeName]) {
            problems.push({
              file,
              message: `${key}: security requirement references undefined scheme "${schemeName}" (not in components.securitySchemes).`
            });
          }
        }
      }
    }
  }

  return problems;
}

/**
 * Issue #695 (epic #679): the bundled artifact
 * (`openapi/awcms-mini-public-api.openapi.yaml`) is now GENERATED from
 * source fragments (`openapi/awcms-mini-public-api.src.yaml` +
 * `openapi/modules/*.yaml`) by `bun run openapi:bundle`
 * (scripts/openapi-bundle.ts). This check catches the drift where someone
 * edits a source fragment but forgets to regenerate (or hand-edits the
 * generated file directly, which then gets silently overwritten the next
 * time someone DOES run the bundler) — it re-bundles in memory and requires
 * the result to match the committed file byte-for-byte (the bundler is
 * deterministic, see `tests/unit/openapi-bundle.test.ts`).
 */
export async function checkBundleFreshness(
  rootDir: string,
  file: string
): Promise<Problem[]> {
  const committedPath = path.join(rootDir, file);

  let committed: string;

  try {
    committed = await readFile(committedPath, "utf8");
  } catch {
    return [{ file, message: "Bundled OpenAPI file is missing." }];
  }

  let fresh: string;

  try {
    fresh = await bundleOpenApi(rootDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return [
      {
        file,
        message: `Failed to regenerate bundle for freshness check: ${message}`
      }
    ];
  }

  if (fresh !== committed) {
    return [
      {
        file,
        message:
          "Bundled OpenAPI file is stale relative to openapi/awcms-mini-public-api.src.yaml and openapi/modules/*.yaml — run `bun run openapi:bundle` and commit the result."
      }
    ];
  }

  return [];
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
