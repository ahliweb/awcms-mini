/**
 * extension-check.ts — `bun run extension:check`.
 *
 * Issue #741 (epic #738 `platform-evolution`, Wave 1, ADR-0015). The
 * ONLY I/O boundary for the derived-application compatibility manifest
 * mechanism — every check itself is a pure function in
 * `src/modules/module-management/domain/extension-compatibility.ts`, this
 * script's sole job is to assemble the plain-data
 * `ExtensionCompatibilityFacts` that engine needs (this repository's own
 * `package.json` version, `MODULE_CONTRACT_VERSION`,
 * `CAPABILITY_CONTRACT_VERSIONS`, real migration file checksums, and the
 * actual OpenAPI/AsyncAPI `info.version`), load + structurally validate a
 * manifest file if one exists, and print/exit accordingly.
 *
 * ## Runs identically in this base repository AND in an external derived
 * repository
 *
 * A derived repository forks/vendors this base repository (ADR-0013 §5,
 * ADR-0014) — this script (and every file it imports:
 * `module-composition.ts`, `extension-compatibility.ts`,
 * `module-contract.ts`, `capability-contract-versions.ts`,
 * `db-migrate.ts`) ships as part of that fork, unmodified. The base
 * repository's own build never commits an `extension.manifest.json` (no
 * derived repository to describe) — running this with zero arguments
 * here always finds no manifest and passes trivially (see "no manifest
 * found" case below), the exact same "absent = no constraint declared,
 * not a failure" convention `application-registry.ts`/`minAppVersion`/
 * `migrationNamespace` already use. A derived repository publishes its
 * own `extension.manifest.json` at its repository root and this exact
 * same command becomes meaningful — no separate "test kit" package to
 * install.
 *
 * ## Security boundary
 *
 * No network access, no package download, no dynamic `import()` of a
 * manifest-supplied or CLI-supplied path, no `eval`/`Function()`. Manifest
 * content is parsed with `JSON.parse`/the already-a-dependency `yaml`
 * package's `parseDocument`, then run through
 * `parseExtensionManifest`'s schema-bounded structural validator — every
 * manifest string is compared as inert data (module keys, filenames,
 * version strings), never executed or resolved as a filesystem path
 * outside the caller-controlled `--migrations-dir` root. `--manifest=`/
 * `--migrations-dir=`/`--report=` are CLI flags a developer or CI job
 * supplies (the same trust boundary as any other `bun run <script> --
 * <flag>` invocation already in this repo, e.g. `production-
 * preflight.ts`'s `--json-output=`) — never tenant/runtime input.
 *
 * ## Where this actually gates something (not just a standalone report)
 *
 * Wired into `bun run check` (`package.json`), `.github/workflows/
 * ci.yml`'s `quality` job as an explicit named step, and
 * `scripts/production-preflight.ts`'s stage list (the same three places
 * `modules:compose:check` was wired for the same "a derived repository's
 * own deployment is exactly the scenario this matters for" reasoning,
 * PR #769's own security-auditor-driven fix) — see this repo's changeset
 * for this issue for the full list. `release.yml`'s `validate` job runs
 * `bun run check` verbatim, so a tagged release is covered without a
 * separate edit there.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";

import { listBaseModules } from "../src/modules";
import { applicationModuleRegistry } from "../src/modules/application-registry";
import { CAPABILITY_CONTRACT_VERSIONS } from "../src/modules/_shared/capability-contract-versions";
import { MODULE_CONTRACT_VERSION } from "../src/modules/_shared/module-contract";
import {
  evaluateExtensionCompatibility,
  formatExtensionManifestIssue,
  formatModuleCompositionIssue,
  parseExtensionManifest,
  type ExtensionCompatibilityFacts,
  type ExtensionCompatibilityReport
} from "../src/modules/module-management/domain/extension-compatibility";
import { safeErrorDetail } from "../src/lib/logging/error-sanitizer";
import {
  computeMigrationChecksum,
  stripOptionalTransactionWrapper
} from "./db-migrate";
import { ASYNCAPI_PATH, OPENAPI_PATH } from "./api-spec-check";

const DEFAULT_MANIFEST_CANDIDATES = [
  "extension.manifest.json",
  "extension.manifest.yaml",
  "extension.manifest.yml"
];

type CliArgs = {
  manifestPath?: string;
  migrationsDir: string;
  reportPath?: string;
};

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { migrationsDir: "sql" };

  for (const arg of argv) {
    if (arg.startsWith("--manifest=")) {
      args.manifestPath = arg.slice("--manifest=".length);
    } else if (arg.startsWith("--migrations-dir=")) {
      args.migrationsDir = arg.slice("--migrations-dir=".length);
    } else if (arg.startsWith("--report=")) {
      args.reportPath = arg.slice("--report=".length);
    }
  }

  return args;
}

type ManifestLocation =
  | { found: true; path: string }
  | { found: false; explicit: false }
  | { found: false; explicit: true; path: string };

async function resolveManifestPath(
  explicitRelativePath: string | undefined,
  rootDir: string
): Promise<ManifestLocation> {
  if (explicitRelativePath) {
    const resolved = path.join(rootDir, explicitRelativePath);
    if (await Bun.file(resolved).exists()) {
      return { found: true, path: resolved };
    }
    return { found: false, explicit: true, path: resolved };
  }

  for (const candidate of DEFAULT_MANIFEST_CANDIDATES) {
    const resolved = path.join(rootDir, candidate);
    if (await Bun.file(resolved).exists()) {
      return { found: true, path: resolved };
    }
  }

  return { found: false, explicit: false };
}

async function loadManifestSource(manifestPath: string): Promise<unknown> {
  const raw = await readFile(manifestPath, "utf8");

  if (manifestPath.endsWith(".json")) {
    return JSON.parse(raw);
  }

  const document = parseDocument(raw);
  if (document.errors.length > 0) {
    throw new Error(document.errors.map((e) => e.message).join("; "));
  }
  return document.toJSON();
}

const MIGRATION_FILE_PATTERN = /^\d+_.*\.sql$/;

/**
 * Permissive, naming-convention-agnostic migration discovery — this
 * deliberately does NOT reuse `db-migrate.ts`'s own `discoverMigrationFiles`,
 * whose `MIGRATION_FILE_PATTERN` hardcodes `_awcms_mini_` in the filename
 * (correct for THIS repository's own `sql/`, wrong for a derived
 * repository's own differently-named migrations, e.g.
 * `900_awpos_sales_schema.sql`). What IS reused, unmodified, is the pair
 * of PURE hashing primitives (`stripOptionalTransactionWrapper`,
 * `computeMigrationChecksum`) — so a checksum computed here is always
 * byte-identical to what `bun run db:migrate` computes for the same file
 * content, regardless of filename convention.
 */
async function discoverMigrationChecksums(
  migrationsDir: string
): Promise<{ name: string; checksum: string }[]> {
  let entries;
  try {
    entries = await readdir(migrationsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const fileNames = entries
    .filter(
      (entry) => entry.isFile() && MIGRATION_FILE_PATTERN.test(entry.name)
    )
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  return Promise.all(
    fileNames.map(async (name) => {
      const rawSql = await readFile(path.join(migrationsDir, name), "utf8");
      const sql = stripOptionalTransactionWrapper(rawSql);
      return { name, checksum: computeMigrationChecksum(sql) };
    })
  );
}

async function readContractVersion(
  relativePath: string,
  rootDir: string
): Promise<string | null> {
  try {
    const source = await readFile(path.join(rootDir, relativePath), "utf8");
    const document = parseDocument(source);
    if (document.errors.length > 0) return null;

    const parsed = document.toJSON() as { info?: { version?: unknown } } | null;
    const version = parsed?.info?.version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

function printReport(report: ExtensionCompatibilityReport): void {
  if (report.moduleCompositionIssues.length > 0) {
    console.error("Module composition issues:");
    for (const issue of report.moduleCompositionIssues) {
      console.error(`  ${formatModuleCompositionIssue(issue)}`);
    }
  }

  if (report.manifestIssues.length > 0) {
    console.error("Compatibility manifest issues:");
    for (const issue of report.manifestIssues) {
      console.error(`  ${formatExtensionManifestIssue(issue)}`);
    }
  }

  if (report.valid) {
    console.log(
      report.manifestChecked
        ? "extension:check OK — compatibility manifest and module composition both valid."
        : "extension:check OK — module composition valid (no compatibility manifest found)."
    );
  } else {
    console.error(
      `extension:check FAILED — ${
        report.moduleCompositionIssues.length + report.manifestIssues.length
      } issue(s) found.`
    );
  }
}

async function writeReportFile(
  reportPath: string,
  report: ExtensionCompatibilityReport
): Promise<void> {
  // Deterministic, no wall-clock timestamp — same "safe for CI artifacts,
  // byte-identical for identical input" convention
  // `module-composition-inventory.json` documents for itself.
  await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

export async function runExtensionCheck(
  args: CliArgs,
  rootDir = process.cwd()
): Promise<ExtensionCompatibilityReport | { fatal: string }> {
  const location = await resolveManifestPath(args.manifestPath, rootDir);

  if (!location.found && location.explicit) {
    return {
      fatal: `Manifest not found at explicitly given path "${location.path}".`
    };
  }

  const base = listBaseModules();

  if (!location.found) {
    return evaluateExtensionCompatibility({
      base,
      application: applicationModuleRegistry,
      manifest: undefined,
      facts: EMPTY_FACTS
    });
  }

  let rawManifest: unknown;
  try {
    rawManifest = await loadManifestSource(location.path);
  } catch (error) {
    return {
      fatal: `Failed to parse manifest "${location.path}": ${safeErrorDetail(error)}`
    };
  }

  const parsed = parseExtensionManifest(rawManifest);
  if (!parsed.valid) {
    return {
      valid: false,
      manifestChecked: true,
      moduleCompositionIssues: [],
      manifestIssues: parsed.issues
    };
  }

  const migrationsDir = path.isAbsolute(args.migrationsDir)
    ? args.migrationsDir
    : path.join(rootDir, args.migrationsDir);

  const [
    migrationFiles,
    actualOpenApiContractVersion,
    actualAsyncApiContractVersion,
    packageJsonText
  ] = await Promise.all([
    discoverMigrationChecksums(migrationsDir),
    readContractVersion(OPENAPI_PATH, rootDir),
    readContractVersion(ASYNCAPI_PATH, rootDir),
    Bun.file(path.join(rootDir, "package.json")).text()
  ]);

  const facts: ExtensionCompatibilityFacts = {
    actualBaseVersion: JSON.parse(packageJsonText).version as string,
    actualModuleContractVersion: MODULE_CONTRACT_VERSION,
    capabilityVersions: CAPABILITY_CONTRACT_VERSIONS,
    migrationFiles,
    actualOpenApiContractVersion,
    actualAsyncApiContractVersion
  };

  return evaluateExtensionCompatibility({
    base,
    application: applicationModuleRegistry,
    manifest: parsed.manifest,
    facts
  });
}

const EMPTY_FACTS: ExtensionCompatibilityFacts = {
  actualBaseVersion: "0.0.0",
  actualModuleContractVersion: MODULE_CONTRACT_VERSION,
  capabilityVersions: {},
  migrationFiles: [],
  actualOpenApiContractVersion: null,
  actualAsyncApiContractVersion: null
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runExtensionCheck(args);

  if ("fatal" in result) {
    console.error(`extension:check FAILED — ${result.fatal}`);
    process.exitCode = 1;
    return;
  }

  printReport(result);

  if (args.reportPath) {
    await writeReportFile(args.reportPath, result);
  }

  if (!result.valid) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
