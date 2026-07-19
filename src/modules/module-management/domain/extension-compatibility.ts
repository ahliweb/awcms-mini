/**
 * Derived-application compatibility manifest validator (Issue #741, epic
 * #738 `platform-evolution`, Wave 1, ADR-0015). Composes with, and
 * deliberately does NOT duplicate, `./module-composition.ts` (Issue
 * #740): that file proves a derived repository's CONTRIBUTED MODULES
 * compose into a valid registry (key/DAG/capability-binding/migration-
 * namespace/deployment-profile checks against the REAL, statically
 * imported TypeScript registry); THIS file validates a SEPARATE,
 * complementary concern — whether a derived repository's SELF-PUBLISHED
 * compatibility manifest (a plain JSON/YAML document, not TypeScript) is
 * internally consistent and still compatible with the base release it's
 * actually running against (base SemVer range, module-contract version,
 * capability contract versions, migration checksum immutability/
 * ordering, and API/event contract staleness). `evaluateExtensionCompatibility`
 * below runs BOTH and returns a single combined report — see
 * `scripts/extension-check.ts` (`bun run extension:check`), the only
 * caller that assembles the I/O-derived `ExtensionCompatibilityFacts`
 * this file's own functions never read themselves.
 *
 * ## Why this lives in `module-management/domain/`, not `_shared/`
 *
 * Same reasoning `module-composition.ts`'s own file header gives for
 * itself: this reuses `./module-composition.ts`'s `composeModuleRegistry`
 * directly (a sibling file in this same `domain/` folder), and
 * `_shared/module-contract.ts`/`_shared/extension-manifest-contract.ts`
 * are deliberately dependency-free (every module, including this one,
 * depends ON them) — putting the validation ENGINE here instead would
 * force those contract files to import FROM here, inverting the
 * established direction.
 *
 * ## No I/O — same "pure domain, no filesystem access" convention
 *
 * Every check function here takes plain, already-read data
 * (`ExtensionCompatibilityFacts`) — never touches `node:fs`, `Bun.file`,
 * or a database itself. `scripts/extension-check.ts` is the ONLY place
 * that reads `package.json`, walks a migrations directory, or parses
 * `openapi`/`asyncapi` YAML files — exactly the same split
 * `module-composition.ts`'s own header documents for why
 * `migration_namespace_overlap` compares declared RANGES only, never
 * reads real `sql/*.sql` files itself.
 *
 * ## Security boundary (issue's own "Security and architecture requirements")
 *
 * `parseExtensionManifest` below is schema-bounded: every field is
 * validated by `typeof`/`Array.isArray`/shape checks only. A manifest
 * value is NEVER passed to `eval`/`Function()`/dynamic `import()`, never
 * used to construct a filesystem path outside the caller-supplied
 * `--migrations-dir` root (`scripts/extension-check.ts` resolves that
 * root itself; this file only ever compares plain filename STRINGS
 * against `ExtensionCompatibilityFacts.migrationFiles`, an array the
 * caller already read), and never shells out. Every string in a manifest
 * is treated as inert data for comparison — the same "manifest parsing is
 * schema-bounded and treats all strings as data" requirement the issue
 * states explicitly.
 */
import {
  compareSemver,
  parseSemver,
  satisfiesSemverRange
} from "../../../lib/semver/compare";
import type {
  ApplicationModuleRegistry,
  ModuleDescriptor
} from "../../_shared/module-contract";
import {
  EXTENSION_MANIFEST_SCHEMA_VERSION,
  type ExtensionCompatibilityManifest,
  type ExtensionManifestContributedModule,
  type ExtensionManifestDeploymentProfile,
  type ExtensionManifestMigrationChecksum
} from "../../_shared/extension-manifest-contract";
import {
  composeModuleRegistry,
  formatModuleCompositionIssue,
  type ModuleCompositionIssue
} from "./module-composition";

export type ExtensionManifestIssue =
  | { type: "manifest_schema_invalid"; path: string; message: string }
  | {
      type: "manifest_schema_version_unsupported";
      declaredVersion: string;
      actualVersion: string;
    }
  | { type: "base_version_range_invalid"; range: string }
  | {
      type: "base_version_range_incompatible";
      declaredRange: string;
      actualVersion: string;
    }
  | { type: "module_contract_version_invalid"; declaredVersion: string }
  | {
      type: "module_contract_version_unsupported";
      declaredVersion: string;
      actualVersion: string;
    }
  | { type: "saas_contract_version_invalid"; declaredVersion: string }
  | {
      type: "saas_contract_version_unsupported";
      declaredVersion: string;
      actualVersion: string;
    }
  | {
      type: "duplicate_contributed_module";
      moduleKey: string;
      occurrences: number;
    }
  | { type: "capability_unknown"; capability: string; providedBy: string }
  | {
      type: "capability_version_unsupported";
      capability: string;
      declaredVersion: string;
      actualVersion: string;
      source: "base" | "self";
    }
  | {
      type: "duplicate_migration_identifier";
      file: string;
      occurrences: number;
    }
  | {
      type: "duplicate_migration_number";
      number: number;
      files: readonly string[];
    }
  | {
      type: "migration_checksum_changed";
      file: string;
      declaredChecksum: string;
      actualChecksum: string;
    }
  | { type: "migration_history_missing_file"; file: string }
  | {
      type: "migration_ordering_violation";
      file: string;
      number: number;
      reason: string;
    }
  | {
      type: "deployment_profile_unsupported_by_module";
      moduleKey: string;
      profile: ExtensionManifestDeploymentProfile;
    }
  | {
      type: "stale_api_contract_assumption";
      contract: "openapi" | "asyncapi";
      declaredVersion: string;
      actualVersion: string;
      reason: string;
    };

/**
 * Plain data assembled ONLY by `scripts/extension-check.ts` (the sole I/O
 * boundary) — see file header. `migrationFiles` is every file discovered
 * under the caller-resolved migrations directory, already hashed with the
 * exact same `computeMigrationChecksum`/`stripOptionalTransactionWrapper`
 * pair `scripts/db-migrate.ts` uses for real applied-migration integrity,
 * so a checksum computed here is byte-identical to what `bun run
 * db:migrate` would compute for the same file content.
 */
export type ExtensionCompatibilityFacts = {
  actualBaseVersion: string;
  actualModuleContractVersion: string;
  /** The base's current `SAAS_CONTRACT_VERSION` (`module-contract.ts`), Issue #874. */
  actualSaasContractVersion: string;
  capabilityVersions: Readonly<Record<string, string>>;
  migrationFiles: readonly { name: string; checksum: string }[];
  actualOpenApiContractVersion: string | null;
  actualAsyncApiContractVersion: string | null;
};

export type ManifestParseResult =
  | { valid: true; manifest: ExtensionCompatibilityManifest }
  | { valid: false; issues: readonly ExtensionManifestIssue[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

/**
 * Manual, narrow structural validator — deliberately not a general JSON
 * Schema engine (no new dependency for a handful of fields, same
 * reasoning `src/lib/semver/compare.ts`'s own header gives for not
 * pulling in a `semver` package). Collects EVERY structural problem in
 * one pass (never stops at the first), same philosophy
 * `validateComposedModuleRegistry` documents for itself. Every branch
 * only ever calls `typeof`/`Array.isArray` — no manifest value is ever
 * evaluated, executed, or used to resolve a path from here.
 */
export function parseExtensionManifest(raw: unknown): ManifestParseResult {
  const issues: ExtensionManifestIssue[] = [];
  const fail = (path: string, message: string): void => {
    issues.push({ type: "manifest_schema_invalid", path, message });
  };

  if (!isPlainObject(raw)) {
    return {
      valid: false,
      issues: [
        {
          type: "manifest_schema_invalid",
          path: "$",
          message: "manifest must be a JSON/YAML object"
        }
      ]
    };
  }

  if (typeof raw.manifestVersion !== "string") {
    fail("manifestVersion", "must be a string");
  }

  const application = raw.application;
  if (!isPlainObject(application)) {
    fail("application", "must be an object");
  } else {
    if (typeof application.key !== "string")
      fail("application.key", "must be a string");
    if (typeof application.version !== "string")
      fail("application.version", "must be a string");
    if (
      application.name !== undefined &&
      typeof application.name !== "string"
    ) {
      fail("application.name", "must be a string when present");
    }
  }

  if (typeof raw.compatibleAwcmsMiniRange !== "string") {
    fail("compatibleAwcmsMiniRange", "must be a string");
  }

  if (typeof raw.moduleContractVersion !== "string") {
    fail("moduleContractVersion", "must be a string");
  }

  if (
    raw.saasContractVersion !== undefined &&
    typeof raw.saasContractVersion !== "string"
  ) {
    fail("saasContractVersion", "must be a string when present");
  }

  const contributedModules = raw.contributedModules;
  if (!Array.isArray(contributedModules)) {
    fail("contributedModules", "must be an array");
  } else {
    contributedModules.forEach((entry, index) => {
      const path = `contributedModules[${index}]`;
      if (!isPlainObject(entry)) {
        fail(path, "must be an object");
        return;
      }
      if (typeof entry.key !== "string")
        fail(`${path}.key`, "must be a string");
      if (
        entry.minVersion !== undefined &&
        typeof entry.minVersion !== "string"
      ) {
        fail(`${path}.minVersion`, "must be a string when present");
      }
      if (
        entry.deploymentProfiles !== undefined &&
        !isStringArray(entry.deploymentProfiles)
      ) {
        fail(
          `${path}.deploymentProfiles`,
          "must be an array of strings when present"
        );
      }
    });
  }

  const migrations = raw.migrations;
  if (!isPlainObject(migrations)) {
    fail("migrations", "must be an object");
  } else {
    const namespace = migrations.namespace;
    if (!isPlainObject(namespace)) {
      fail("migrations.namespace", "must be an object");
    } else {
      if (typeof namespace.label !== "string")
        fail("migrations.namespace.label", "must be a string");
      if (typeof namespace.rangeStart !== "number")
        fail("migrations.namespace.rangeStart", "must be a number");
      if (typeof namespace.rangeEnd !== "number")
        fail("migrations.namespace.rangeEnd", "must be a number");
    }

    const historicalChecksums = migrations.historicalChecksums;
    if (!Array.isArray(historicalChecksums)) {
      fail("migrations.historicalChecksums", "must be an array");
    } else {
      historicalChecksums.forEach((entry, index) => {
        const path = `migrations.historicalChecksums[${index}]`;
        if (!isPlainObject(entry)) {
          fail(path, "must be an object");
          return;
        }
        if (typeof entry.file !== "string")
          fail(`${path}.file`, "must be a string");
        if (typeof entry.checksum !== "string")
          fail(`${path}.checksum`, "must be a string");
      });
    }
  }

  const capabilities = raw.capabilities;
  if (capabilities !== undefined) {
    if (!isPlainObject(capabilities)) {
      fail("capabilities", "must be an object when present");
    } else {
      if (capabilities.provides !== undefined) {
        if (!Array.isArray(capabilities.provides)) {
          fail("capabilities.provides", "must be an array when present");
        } else {
          capabilities.provides.forEach((entry, index) => {
            const path = `capabilities.provides[${index}]`;
            if (!isPlainObject(entry)) {
              fail(path, "must be an object");
              return;
            }
            if (typeof entry.key !== "string")
              fail(`${path}.key`, "must be a string");
            if (typeof entry.version !== "string")
              fail(`${path}.version`, "must be a string");
          });
        }
      }
      if (capabilities.requires !== undefined) {
        if (!Array.isArray(capabilities.requires)) {
          fail("capabilities.requires", "must be an array when present");
        } else {
          capabilities.requires.forEach((entry, index) => {
            const path = `capabilities.requires[${index}]`;
            if (!isPlainObject(entry)) {
              fail(path, "must be an object");
              return;
            }
            if (typeof entry.key !== "string")
              fail(`${path}.key`, "must be a string");
            if (typeof entry.version !== "string")
              fail(`${path}.version`, "must be a string");
            if (typeof entry.providedBy !== "string")
              fail(`${path}.providedBy`, "must be a string");
            if (
              entry.optional !== undefined &&
              typeof entry.optional !== "boolean"
            ) {
              fail(`${path}.optional`, "must be a boolean when present");
            }
          });
        }
      }
    }
  }

  const deployment = raw.deployment;
  if (!isPlainObject(deployment)) {
    fail("deployment", "must be an object");
  } else if (!isStringArray(deployment.requiredProfiles)) {
    fail("deployment.requiredProfiles", "must be an array of strings");
  }

  const consumes = raw.consumes;
  if (consumes !== undefined) {
    if (!isPlainObject(consumes)) {
      fail("consumes", "must be an object when present");
    } else {
      if (
        consumes.openApiContractVersion !== undefined &&
        typeof consumes.openApiContractVersion !== "string"
      ) {
        fail(
          "consumes.openApiContractVersion",
          "must be a string when present"
        );
      }
      if (
        consumes.asyncApiContractVersion !== undefined &&
        typeof consumes.asyncApiContractVersion !== "string"
      ) {
        fail(
          "consumes.asyncApiContractVersion",
          "must be a string when present"
        );
      }
    }
  }

  if (issues.length > 0) {
    return { valid: false, issues };
  }

  return { valid: true, manifest: raw as ExtensionCompatibilityManifest };
}

export function formatExtensionManifestIssue(
  issue: ExtensionManifestIssue
): string {
  switch (issue.type) {
    case "manifest_schema_invalid":
      return `Manifest field "${issue.path}" is invalid: ${issue.message}`;
    case "manifest_schema_version_unsupported":
      return `Manifest declares schema version "${issue.declaredVersion}", but this tooling supports "${issue.actualVersion}" (major version must match).`;
    case "base_version_range_invalid":
      return `Manifest field "compatibleAwcmsMiniRange" ("${issue.range}") is not a valid SemVer range.`;
    case "base_version_range_incompatible":
      return `This AWCMS-Mini release does not satisfy the manifest's declared compatible range "${issue.declaredRange}" (actual version: ${issue.actualVersion}).`;
    case "module_contract_version_invalid":
      return `Manifest field "moduleContractVersion" ("${issue.declaredVersion}") is not valid SemVer.`;
    case "module_contract_version_unsupported":
      return `Manifest declares moduleContractVersion "${issue.declaredVersion}", unsupported by this release's actual module contract version "${issue.actualVersion}" (major must match; minor must not exceed it).`;
    case "saas_contract_version_invalid":
      return `Manifest field "saasContractVersion" ("${issue.declaredVersion}") is not valid SemVer.`;
    case "saas_contract_version_unsupported":
      return `Manifest declares saasContractVersion "${issue.declaredVersion}", unsupported by this release's actual SaaS contract version "${issue.actualVersion}" (major must match; minor must not exceed it).`;
    case "duplicate_contributed_module":
      return `Contributed module key "${issue.moduleKey}" is declared ${issue.occurrences} times in the manifest.`;
    case "capability_unknown":
      return `Manifest requires capability "${issue.capability}" (providedBy "${issue.providedBy}"), which is neither a known base capability nor declared in this manifest's own "capabilities.provides".`;
    case "capability_version_unsupported":
      return `Manifest requires capability "${issue.capability}" version "${issue.declaredVersion}", unsupported by the ${issue.source === "base" ? "base repository's" : "manifest's own declared"} actual version "${issue.actualVersion}".`;
    case "duplicate_migration_identifier":
      return `Migration file "${issue.file}" is declared ${issue.occurrences} times in migrations.historicalChecksums.`;
    case "duplicate_migration_number":
      return `Migration number ${issue.number} is used by more than one file: ${issue.files.join(", ")}.`;
    case "migration_checksum_changed":
      return `Historical migration "${issue.file}" checksum changed — declared ${issue.declaredChecksum}, actual ${issue.actualChecksum}. An already-shipped migration must never be edited; create a new migration instead.`;
    case "migration_history_missing_file":
      return `Historical migration "${issue.file}" is declared in the manifest but not found on disk.`;
    case "migration_ordering_violation":
      return `Migration "${issue.file}" (number ${issue.number}) violates ordering: ${issue.reason}.`;
    case "deployment_profile_unsupported_by_module":
      return `Deployment profile "${issue.profile}" is required by the manifest, but contributed module "${issue.moduleKey}" does not declare support for it.`;
    case "stale_api_contract_assumption":
      return `Manifest's declared ${issue.contract === "openapi" ? "OpenAPI" : "AsyncAPI"} contract version "${issue.declaredVersion}" is stale relative to the actual "${issue.actualVersion}": ${issue.reason}.`;
  }
}

function extractMigrationNumber(filename: string): number | null {
  const match = /^(\d+)_/.exec(filename);
  return match ? Number(match[1]) : null;
}

function checkManifestSchemaVersion(
  manifest: ExtensionCompatibilityManifest
): ExtensionManifestIssue[] {
  const declared = parseSemver(manifest.manifestVersion);
  if (!declared) return [];

  const actual = parseSemver(EXTENSION_MANIFEST_SCHEMA_VERSION);
  if (!actual || declared.major !== actual.major) {
    return [
      {
        type: "manifest_schema_version_unsupported",
        declaredVersion: manifest.manifestVersion,
        actualVersion: EXTENSION_MANIFEST_SCHEMA_VERSION
      }
    ];
  }
  return [];
}

function checkBaseVersionRange(
  manifest: ExtensionCompatibilityManifest,
  facts: ExtensionCompatibilityFacts
): ExtensionManifestIssue[] {
  const result = satisfiesSemverRange(
    facts.actualBaseVersion,
    manifest.compatibleAwcmsMiniRange
  );

  if (result === null) {
    return [
      {
        type: "base_version_range_invalid",
        range: manifest.compatibleAwcmsMiniRange
      }
    ];
  }
  if (!result) {
    return [
      {
        type: "base_version_range_incompatible",
        declaredRange: manifest.compatibleAwcmsMiniRange,
        actualVersion: facts.actualBaseVersion
      }
    ];
  }
  return [];
}

/** MAJOR must match exactly; declared MINOR must not exceed actual MINOR — same "backward-compatible additive minor, breaking major" rule ADR-0008 defines for the REST/event contract, applied here to the module descriptor contract and (in `versionsCompatible` below) to capability contracts. */
function isVersionSupported(declared: string, actual: string): boolean {
  const d = parseSemver(declared);
  const a = parseSemver(actual);
  if (!d || !a) return false;
  if (d.major !== a.major) return false;
  return d.minor <= a.minor;
}

function checkModuleContractVersion(
  manifest: ExtensionCompatibilityManifest,
  facts: ExtensionCompatibilityFacts
): ExtensionManifestIssue[] {
  if (!parseSemver(manifest.moduleContractVersion)) {
    return [
      {
        type: "module_contract_version_invalid",
        declaredVersion: manifest.moduleContractVersion
      }
    ];
  }

  if (
    !isVersionSupported(
      manifest.moduleContractVersion,
      facts.actualModuleContractVersion
    )
  ) {
    return [
      {
        type: "module_contract_version_unsupported",
        declaredVersion: manifest.moduleContractVersion,
        actualVersion: facts.actualModuleContractVersion
      }
    ];
  }
  return [];
}

function checkSaasContractVersion(
  manifest: ExtensionCompatibilityManifest,
  facts: ExtensionCompatibilityFacts
): ExtensionManifestIssue[] {
  const declared = manifest.saasContractVersion;
  if (declared === undefined) {
    return [];
  }

  if (!parseSemver(declared)) {
    return [
      { type: "saas_contract_version_invalid", declaredVersion: declared }
    ];
  }

  if (!isVersionSupported(declared, facts.actualSaasContractVersion)) {
    return [
      {
        type: "saas_contract_version_unsupported",
        declaredVersion: declared,
        actualVersion: facts.actualSaasContractVersion
      }
    ];
  }
  return [];
}

function checkDuplicateContributedModules(
  manifest: ExtensionCompatibilityManifest
): ExtensionManifestIssue[] {
  const counts = new Map<string, number>();
  for (const module of manifest.contributedModules) {
    counts.set(module.key, (counts.get(module.key) ?? 0) + 1);
  }

  const issues: ExtensionManifestIssue[] = [];
  for (const [moduleKey, occurrences] of counts) {
    if (occurrences > 1) {
      issues.push({
        type: "duplicate_contributed_module",
        moduleKey,
        occurrences
      });
    }
  }
  return issues;
}

/**
 * Deliberately checks version compatibility for EVERY `requires` entry,
 * including `optional: true` ones — a divergence from `module-
 * composition.ts`'s own `capability_provider_missing`, which skips
 * `optional` entirely ("ADR-0011's whole point is that the consumer
 * degrades safely when it resolves to not applicable"). That precedent is
 * about STRUCTURAL absence (no provider registered for this tenant at
 * all) — a per-tenant runtime condition. A VERSION mismatch is a
 * different risk: the consuming code already compiled against an
 * assumed port shape, and a breaking change to that shape can still throw
 * for tenants where the capability DOES resolve, regardless of whether
 * the feature is optional. Silently skipping version-checking for
 * `optional` entries would hide exactly that risk.
 */
function checkCapabilities(
  manifest: ExtensionCompatibilityManifest,
  facts: ExtensionCompatibilityFacts
): ExtensionManifestIssue[] {
  const issues: ExtensionManifestIssue[] = [];
  const requires = manifest.capabilities?.requires ?? [];
  const providesByKey = new Map(
    (manifest.capabilities?.provides ?? []).map(
      (p) => [p.key, p.version] as const
    )
  );

  for (const required of requires) {
    const baseVersion = facts.capabilityVersions[required.key];
    if (baseVersion !== undefined) {
      if (!isVersionSupported(required.version, baseVersion)) {
        issues.push({
          type: "capability_version_unsupported",
          capability: required.key,
          declaredVersion: required.version,
          actualVersion: baseVersion,
          source: "base"
        });
      }
      continue;
    }

    const selfVersion = providesByKey.get(required.key);
    if (selfVersion !== undefined) {
      if (!isVersionSupported(required.version, selfVersion)) {
        issues.push({
          type: "capability_version_unsupported",
          capability: required.key,
          declaredVersion: required.version,
          actualVersion: selfVersion,
          source: "self"
        });
      }
      continue;
    }

    issues.push({
      type: "capability_unknown",
      capability: required.key,
      providedBy: required.providedBy
    });
  }

  return issues;
}

function checkMigrations(
  manifest: ExtensionCompatibilityManifest,
  facts: ExtensionCompatibilityFacts
): ExtensionManifestIssue[] {
  const issues: ExtensionManifestIssue[] = [];
  const { historicalChecksums, namespace } = manifest.migrations;

  const fileOccurrences = new Map<string, number>();
  for (const entry of historicalChecksums) {
    fileOccurrences.set(entry.file, (fileOccurrences.get(entry.file) ?? 0) + 1);
  }
  for (const [file, occurrences] of fileOccurrences) {
    if (occurrences > 1) {
      issues.push({
        type: "duplicate_migration_identifier",
        file,
        occurrences
      });
    }
  }

  const numberToFiles = new Map<number, Set<string>>();
  for (const entry of historicalChecksums) {
    const number = extractMigrationNumber(entry.file);
    if (number === null) continue;
    const files = numberToFiles.get(number) ?? new Set<string>();
    files.add(entry.file);
    numberToFiles.set(number, files);
  }
  for (const [number, files] of numberToFiles) {
    if (files.size > 1) {
      issues.push({
        type: "duplicate_migration_number",
        number,
        files: [...files].sort((a, b) => a.localeCompare(b))
      });
    }
  }

  for (const entry of historicalChecksums) {
    const number = extractMigrationNumber(entry.file);
    if (
      number !== null &&
      (number < namespace.rangeStart || number > namespace.rangeEnd)
    ) {
      issues.push({
        type: "migration_ordering_violation",
        file: entry.file,
        number,
        reason: `outside the declared namespace range ${namespace.rangeStart}-${namespace.rangeEnd}`
      });
    }
  }

  const onDiskByName = new Map(
    facts.migrationFiles.map((f) => [f.name, f.checksum] as const)
  );

  let maxHistoricalNumber = -Infinity;
  for (const entry of historicalChecksums) {
    const number = extractMigrationNumber(entry.file);
    if (number !== null && number > maxHistoricalNumber) {
      maxHistoricalNumber = number;
    }

    const actualChecksum = onDiskByName.get(entry.file);
    if (actualChecksum === undefined) {
      issues.push({ type: "migration_history_missing_file", file: entry.file });
      continue;
    }
    if (actualChecksum !== entry.checksum) {
      issues.push({
        type: "migration_checksum_changed",
        file: entry.file,
        declaredChecksum: entry.checksum,
        actualChecksum
      });
    }
  }

  if (Number.isFinite(maxHistoricalNumber)) {
    const historicalFileNames = new Set(historicalChecksums.map((e) => e.file));
    for (const file of facts.migrationFiles) {
      if (historicalFileNames.has(file.name)) continue;

      const number = extractMigrationNumber(file.name);
      if (number !== null && number <= maxHistoricalNumber) {
        issues.push({
          type: "migration_ordering_violation",
          file: file.name,
          number,
          reason: `a new migration cannot be numbered at or before the highest already-shipped historical migration (${maxHistoricalNumber})`
        });
      }
    }
  }

  return issues;
}

function checkDeploymentProfiles(
  manifest: ExtensionCompatibilityManifest
): ExtensionManifestIssue[] {
  const issues: ExtensionManifestIssue[] = [];

  for (const module of manifest.contributedModules) {
    if (!module.deploymentProfiles) continue;

    for (const profile of manifest.deployment.requiredProfiles) {
      if (!module.deploymentProfiles.includes(profile)) {
        issues.push({
          type: "deployment_profile_unsupported_by_module",
          moduleKey: module.key,
          profile
        });
      }
    }
  }

  return issues;
}

function compareContractVersions(
  declared: string,
  actual: string
): string | null {
  const d = parseSemver(declared);
  const a = parseSemver(actual);
  if (!d || !a) {
    return "declared or actual contract version is not valid SemVer";
  }
  if (d.major !== a.major) {
    return `major version mismatch — the contract shape may have changed (ADR-0008)`;
  }
  if (compareSemver(d, a) > 0) {
    return "manifest assumes a newer minor/patch contract version than is actually shipped";
  }
  return null;
}

function checkContractStaleness(
  manifest: ExtensionCompatibilityManifest,
  facts: ExtensionCompatibilityFacts
): ExtensionManifestIssue[] {
  const issues: ExtensionManifestIssue[] = [];

  const declaredOpenApi = manifest.consumes?.openApiContractVersion;
  if (declaredOpenApi && facts.actualOpenApiContractVersion) {
    const reason = compareContractVersions(
      declaredOpenApi,
      facts.actualOpenApiContractVersion
    );
    if (reason) {
      issues.push({
        type: "stale_api_contract_assumption",
        contract: "openapi",
        declaredVersion: declaredOpenApi,
        actualVersion: facts.actualOpenApiContractVersion,
        reason
      });
    }
  }

  const declaredAsyncApi = manifest.consumes?.asyncApiContractVersion;
  if (declaredAsyncApi && facts.actualAsyncApiContractVersion) {
    const reason = compareContractVersions(
      declaredAsyncApi,
      facts.actualAsyncApiContractVersion
    );
    if (reason) {
      issues.push({
        type: "stale_api_contract_assumption",
        contract: "asyncapi",
        declaredVersion: declaredAsyncApi,
        actualVersion: facts.actualAsyncApiContractVersion,
        reason
      });
    }
  }

  return issues;
}

/**
 * Runs every manifest-level check in one pass (never stops at the
 * first), same philosophy `validateComposedModuleRegistry` documents for
 * itself.
 */
export function evaluateExtensionManifest(
  manifest: ExtensionCompatibilityManifest,
  facts: ExtensionCompatibilityFacts
): readonly ExtensionManifestIssue[] {
  return [
    ...checkManifestSchemaVersion(manifest),
    ...checkBaseVersionRange(manifest, facts),
    ...checkModuleContractVersion(manifest, facts),
    ...checkSaasContractVersion(manifest, facts),
    ...checkDuplicateContributedModules(manifest),
    ...checkCapabilities(manifest, facts),
    ...checkMigrations(manifest, facts),
    ...checkDeploymentProfiles(manifest),
    ...checkContractStaleness(manifest, facts)
  ];
}

export type ExtensionCompatibilityReport = {
  valid: boolean;
  manifestChecked: boolean;
  moduleCompositionIssues: readonly ModuleCompositionIssue[];
  manifestIssues: readonly ExtensionManifestIssue[];
};

/**
 * Combined report: `module-composition.ts`'s own engine (reused verbatim,
 * against the REAL base + application registry — meaningful with or
 * without a manifest present, exactly like `bun run modules:compose:check`
 * standalone) PLUS this file's manifest-specific checks (only run when a
 * manifest was found — `manifestChecked` tells a caller which case
 * applies). Absence of a manifest is never itself a failure — see
 * `scripts/extension-check.ts`'s own header for why a default base build
 * (no manifest committed) must stay green.
 */
export function evaluateExtensionCompatibility(input: {
  base: readonly ModuleDescriptor[];
  application: ApplicationModuleRegistry | undefined;
  manifest: ExtensionCompatibilityManifest | undefined;
  facts: ExtensionCompatibilityFacts;
}): ExtensionCompatibilityReport {
  const compositionResult = composeModuleRegistry({
    base: input.base,
    application: input.application
  });
  const moduleCompositionIssues = compositionResult.valid
    ? []
    : compositionResult.issues;

  const manifestIssues = input.manifest
    ? evaluateExtensionManifest(input.manifest, input.facts)
    : [];

  return {
    valid: moduleCompositionIssues.length === 0 && manifestIssues.length === 0,
    manifestChecked: input.manifest !== undefined,
    moduleCompositionIssues,
    manifestIssues
  };
}

export { formatModuleCompositionIssue };
export type {
  ExtensionManifestContributedModule,
  ExtensionManifestMigrationChecksum
};
