import { readFile } from "node:fs/promises";
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

  if (!asRecord(document.info)) {
    problems.push({ file, message: "Missing OpenAPI info object." });
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

  if (!asRecord(document.info)) {
    problems.push({ file, message: "Missing AsyncAPI info object." });
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
