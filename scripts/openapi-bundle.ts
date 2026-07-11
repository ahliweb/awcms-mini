import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import prettier from "prettier";
import { parseDocument, stringify } from "yaml";

/**
 * Issue #695 (epic #679): the public OpenAPI contract is split into source
 * fragments -- one file per module/tag under `openapi/modules/*.yaml`, plus
 * a root fragment (`openapi/awcms-mini-public-api.src.yaml`) holding the
 * shared `info`/`servers`/`tags`/`security`/`components.securitySchemes`/
 * `components.parameters`/`components.responses`, and any schema shared by
 * 2+ modules (or referenced by none). This script merges every fragment
 * into the single published artifact at the SAME path every consumer
 * already uses, `openapi/awcms-mini-public-api.openapi.yaml` -- that file
 * is now GENERATED, never edited by hand (see `openapi/README.md`).
 *
 * Determinism: every fragment is loaded in a fixed, explicitly sorted order
 * (module files sorted by filename, not raw `readdir` order which the
 * filesystem does not guarantee is stable), and every merged object
 * (`paths`, `components.schemas`) has its keys re-sorted alphabetically
 * before serialization. Running this script twice against unchanged sources
 * produces byte-identical output (see
 * `tests/unit/openapi-bundle.test.ts`).
 *
 * Local/offline only: no network access, no external CLI -- just `yaml`
 * parse/stringify over files already in the repo.
 */

export const ROOT_SRC_PATH = "openapi/awcms-mini-public-api.src.yaml";
export const MODULES_DIR = "openapi/modules";
export const BUNDLED_PATH = "openapi/awcms-mini-public-api.openapi.yaml";

const BUNDLE_HEADER = `# GENERATED FILE -- do not edit by hand.
#
# This is the bundled, published OpenAPI contract, produced by
# \`bun run openapi:bundle\` (scripts/openapi-bundle.ts, Issue #695) from
# source fragments in ${ROOT_SRC_PATH} and ${MODULES_DIR}/*.yaml. Edit those
# files, then regenerate this one -- direct edits here are silently
# overwritten and never reviewed as the source of truth.
`;

type AnyRecord = Record<string, unknown>;

function sortObject<T>(obj: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(obj).sort((a, b) => a.localeCompare(b))) {
    out[key] = obj[key]!;
  }
  return out;
}

function asRecord(value: unknown): AnyRecord {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as AnyRecord;
  }
  return {};
}

async function readYaml(absolutePath: string): Promise<unknown> {
  const source = await readFile(absolutePath, "utf8");
  const document = parseDocument(source);

  if (document.errors.length > 0) {
    const messages = document.errors.map((error) => error.message).join("; ");
    throw new Error(`${absolutePath}: invalid YAML -- ${messages}`);
  }

  return document.toJSON();
}

/**
 * Reads every openapi/modules/*.yaml fragment (sorted by filename) and the
 * root fragment, and merges them into a single bundled OpenAPI document
 * (as a plain JS object -- not yet serialized). Exported for tests that
 * want to assert on structure without round-tripping through YAML text.
 */
export async function buildBundledDocument(
  rootDir = process.cwd()
): Promise<AnyRecord> {
  const rootPath = path.join(rootDir, ROOT_SRC_PATH);
  const modulesDir = path.join(rootDir, MODULES_DIR);

  const root = asRecord(await readYaml(rootPath));

  const entries = await readdir(modulesDir, { withFileTypes: true });
  const moduleFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".openapi.yaml"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  if (moduleFiles.length === 0) {
    throw new Error(`No module fragments found in ${MODULES_DIR}/`);
  }

  const mergedPaths: AnyRecord = {};
  const mergedSchemas: AnyRecord = asRecord(asRecord(root.components).schemas);

  for (const fileName of moduleFiles) {
    const modulePath = path.join(modulesDir, fileName);
    const moduleDoc = asRecord(await readYaml(modulePath));
    const modulePaths = asRecord(moduleDoc.paths);
    const moduleSchemas = asRecord(asRecord(moduleDoc.components).schemas);

    for (const [pathKey, pathItem] of Object.entries(modulePaths)) {
      if (Object.prototype.hasOwnProperty.call(mergedPaths, pathKey)) {
        throw new Error(
          `Duplicate path "${pathKey}" -- defined in ${fileName} and at least one other module fragment.`
        );
      }
      mergedPaths[pathKey] = pathItem;
    }

    for (const [schemaName, schemaDef] of Object.entries(moduleSchemas)) {
      if (Object.prototype.hasOwnProperty.call(mergedSchemas, schemaName)) {
        throw new Error(
          `Duplicate schema "${schemaName}" -- defined in ${fileName} and at least one other fragment (root or another module).`
        );
      }
      mergedSchemas[schemaName] = schemaDef;
    }
  }

  const rootComponents = asRecord(root.components);

  const bundled: AnyRecord = {
    openapi: root.openapi,
    info: root.info,
    ...(root.servers !== undefined ? { servers: root.servers } : {}),
    tags: root.tags,
    paths: sortObject(mergedPaths),
    ...(root["x-awcms-mini-soft-delete-pattern"] !== undefined
      ? {
          "x-awcms-mini-soft-delete-pattern":
            root["x-awcms-mini-soft-delete-pattern"]
        }
      : {}),
    components: {
      securitySchemes: rootComponents.securitySchemes,
      parameters: rootComponents.parameters,
      responses: rootComponents.responses,
      schemas: sortObject(mergedSchemas)
    },
    security: root.security
  };

  return bundled;
}

export async function bundleOpenApi(rootDir = process.cwd()): Promise<string> {
  const bundled = await buildBundledDocument(rootDir);
  const rawYaml = BUNDLE_HEADER + stringify(bundled, { lineWidth: 0 });

  // Format with the project's own Prettier config so the generated artifact
  // already satisfies `bun run lint` (Prettier checks every `.yaml` file) —
  // otherwise every regeneration would require a separate manual
  // `bun run format` pass, and the file would fail CI's lint gate as
  // committed. Deterministic given the same input (Prettier has no
  // randomness), so this doesn't break bundle-twice-is-byte-identical.
  const filepath = path.join(rootDir, BUNDLED_PATH);
  const config = (await prettier.resolveConfig(filepath)) ?? {};

  return prettier.format(rawYaml, { ...config, filepath, parser: "yaml" });
}

export async function writeBundledOpenApi(
  rootDir = process.cwd()
): Promise<string> {
  const yamlText = await bundleOpenApi(rootDir);

  await writeFile(path.join(rootDir, BUNDLED_PATH), yamlText, "utf8");

  return yamlText;
}

if (import.meta.main) {
  await writeBundledOpenApi();
  console.log(`openapi:bundle OK — wrote ${BUNDLED_PATH}`);
}
