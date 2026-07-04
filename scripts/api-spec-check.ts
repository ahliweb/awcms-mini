/**
 * Validasi baseline OpenAPI/AsyncAPI + konsistensi registry modul (doc 05).
 * - openapi/: versi 3.x, info, paths, envelope error standard.
 * - asyncapi/: versi 3.x, channels.
 * - Cross-check: openApiPath/asyncApiPath tiap modul ada di disk;
 *   semua event `publishes` terdaftar sebagai channel AsyncAPI.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { modules, validateModuleRegistry } from "../src/modules/index";

const ROOT = join(import.meta.dirname, "..");
const OPENAPI_PATH = join(ROOT, "openapi", "awcms-mini-public-api.openapi.yaml");
const ASYNCAPI_PATH = join(ROOT, "asyncapi", "awcms-mini-domain-events.asyncapi.yaml");

const problems: string[] = [];

function check(condition: unknown, message: string): void {
  if (!condition) problems.push(message);
}

async function main(): Promise<void> {
  // Registry modul valid dulu.
  validateModuleRegistry();

  const openapi = parse(await readFile(OPENAPI_PATH, "utf8")) as Record<string, unknown>;
  check(
    typeof openapi.openapi === "string" && (openapi.openapi as string).startsWith("3."),
    "OpenAPI: field `openapi` harus versi 3.x"
  );
  const info = openapi.info as Record<string, unknown> | undefined;
  check(info?.title && info?.version, "OpenAPI: info.title dan info.version wajib");
  const paths = openapi.paths as Record<string, Record<string, unknown>> | undefined;
  check(paths && Object.keys(paths).length > 0, "OpenAPI: paths tidak boleh kosong");
  for (const [path, operations] of Object.entries(paths ?? {})) {
    check(path.startsWith("/"), `OpenAPI: path ${path} harus diawali '/'`);
    for (const [method, operation] of Object.entries(operations)) {
      if (!["get", "post", "patch", "put", "delete"].includes(method)) continue;
      const op = operation as Record<string, unknown>;
      check(op.responses, `OpenAPI: ${method.toUpperCase()} ${path} tanpa responses`);
      check(op.operationId, `OpenAPI: ${method.toUpperCase()} ${path} tanpa operationId`);
    }
  }
  const schemas = (openapi.components as Record<string, unknown> | undefined)?.schemas as
    | Record<string, unknown>
    | undefined;
  check(schemas?.ApiError, "OpenAPI: components.schemas.ApiError (envelope error) wajib ada");
  check(schemas?.ApiSuccess, "OpenAPI: components.schemas.ApiSuccess wajib ada");

  const asyncapi = parse(await readFile(ASYNCAPI_PATH, "utf8")) as Record<string, unknown>;
  check(
    typeof asyncapi.asyncapi === "string" && (asyncapi.asyncapi as string).startsWith("3."),
    "AsyncAPI: field `asyncapi` harus versi 3.x"
  );
  const channels = asyncapi.channels as Record<string, unknown> | undefined;
  check(channels && Object.keys(channels).length > 0, "AsyncAPI: channels tidak boleh kosong");

  for (const descriptor of modules) {
    if (descriptor.api) {
      check(
        existsSync(join(ROOT, descriptor.api.openApiPath)),
        `Modul ${descriptor.key}: openApiPath tidak ditemukan: ${descriptor.api.openApiPath}`
      );
    }
    if (descriptor.events?.asyncApiPath) {
      check(
        existsSync(join(ROOT, descriptor.events.asyncApiPath)),
        `Modul ${descriptor.key}: asyncApiPath tidak ditemukan: ${descriptor.events.asyncApiPath}`
      );
    }
    for (const eventType of descriptor.events?.publishes ?? []) {
      check(
        channels && Object.hasOwn(channels, eventType),
        `Modul ${descriptor.key}: event '${eventType}' belum terdaftar di AsyncAPI channels`
      );
    }
  }

  if (problems.length > 0) {
    console.error("api:spec:check GAGAL:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log("api:spec:check OK — OpenAPI/AsyncAPI baseline valid & konsisten dengan registry modul.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
