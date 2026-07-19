/**
 * Derived-application compatibility manifest schema (Issue #741, epic
 * #738 `platform-evolution`, Wave 1, ADR-0015). Pure types + the schema's
 * own version constant — zero imports, same dependency-free convention
 * `module-contract.ts` documents for itself (every derived repository's
 * `extension.manifest.json`/`.yaml` is authored against this shape, and
 * this file must never gain a transitive dependency that would make
 * authoring one harder to reason about).
 *
 * A derived repository publishes ONE manifest file (JSON or YAML) at its
 * repository root — `extension.manifest.json` by convention
 * (`scripts/extension-check.ts`'s default lookup path) — describing its
 * own compatibility contract with this base. This is DATA, never CODE:
 * every field is a plain string/number/array, parsed with `JSON.parse`/
 * the `yaml` package's `parse`, never `eval`/`Function()`/dynamic
 * `import()` of a manifest-supplied path — see
 * `src/modules/module-management/domain/extension-compatibility.ts`'s
 * file header for the full security boundary this schema and its
 * validator stay inside.
 */

/**
 * SemVer of THIS schema shape (the fields below) — independent of every
 * other versioning scheme in this repo (package release, REST/event
 * contract, module descriptor contract, capability contract — see
 * `module-contract.ts`'s `MODULE_CONTRACT_VERSION` doc comment for the
 * full list this is the sixth of). Bumped only when a field is added
 * (MINOR, backward-compatible) or removed/retyped (MAJOR, breaking) —
 * PATCH is documentation-only. `scripts/extension-check.ts` fails with an
 * actionable diagnostic when a manifest declares a `manifestVersion`
 * whose MAJOR differs from this constant, rather than a raw parse error.
 *
 * `1.1.0` (Issue #874, epic #868 SaaS control plane) — added the optional
 * `saasContractVersion` field. MINOR: purely additive, backward-compatible
 * (a manifest that omits it is unaffected).
 */
export const EXTENSION_MANIFEST_SCHEMA_VERSION = "1.1.0";

/**
 * Same four values as `ModuleDescriptor`'s own
 * `ModuleCompatibilityContract.deploymentProfiles`
 * (`_shared/module-contract.ts`) — redeclared here rather than imported,
 * for the identical "keep this file dependency-free" reason that file's
 * own doc comment gives for its own redeclaration of the same four
 * values (originally from `src/lib/config/registry.ts`'s
 * `DeploymentProfile`). Keep all three lists in sync by hand if
 * `docs/awcms-mini/deployment-profiles.md` ever adds a profile —
 * structural (plain string) comparison throughout, not nominal type
 * identity.
 */
export type ExtensionManifestDeploymentProfile =
  "development" | "staging" | "production" | "offline-lan";

export type ExtensionManifestApplication = {
  /** Stable identifier for the derived application/repository — same convention as `ApplicationModuleRegistry.id`, but this field is independent data (the manifest can exist and be checked even before any TypeScript module registry compiles). */
  key: string;
  /** The derived application's OWN release SemVer — never compared against `compatibleAwcmsMiniRange` (that range is this REPOSITORY's version, not the derived app's own). */
  version: string;
  name?: string;
};

export type ExtensionManifestContributedModule = {
  /** Must match a `ModuleDescriptor.key` the derived application's own `ApplicationModuleRegistry` contributes — NOT cross-checked against the real TypeScript registry by this manifest layer (that is `composeModuleRegistry`'s job, run separately by the same `bun run extension:check` invocation — see the CLI script's own header). This field lets the manifest be validated standalone, before/without compiling the derived repository's TypeScript. */
  key: string;
  minVersion?: string;
  /** Self-declared mirror of that module's own `compatibility.deploymentProfiles` — checked for INTERNAL manifest consistency against this same manifest's top-level `deployment.requiredProfiles` (see `checkDeploymentProfileRequirements` in `extension-compatibility.ts`). Absence means "no constraint declared" (same absence convention `ModuleCompatibilityContract.deploymentProfiles` itself uses). */
  deploymentProfiles?: readonly ExtensionManifestDeploymentProfile[];
};

export type ExtensionManifestMigrationChecksum = {
  /** Migration filename, e.g. `900_awpos_sales_schema.sql` — compared by exact string match against files discovered on disk by `scripts/extension-check.ts --migrations-dir=<dir>` (default `sql/`). */
  file: string;
  /** `sha256:<hex>` — same format `scripts/db-migrate.ts`'s own `computeMigrationChecksum` produces (that exact function is reused, not reimplemented, by `scripts/extension-check.ts`, so a checksum computed by `bun run db:migrate` and one computed by `bun run extension:check` are always byte-identical for the same file content). */
  checksum: string;
};

export type ExtensionManifestMigrationNamespace = {
  label: string;
  rangeStart: number;
  rangeEnd: number;
};

export type ExtensionManifestMigrations = {
  /** Same shape/intent as `ApplicationModuleRegistry.migrationNamespace` (`module-contract.ts`) — this manifest's own declaration, independent of what the TypeScript registry declares (both should agree; `extension-compatibility.ts` does not cross-check the two, since they are read by entirely different tools at entirely different times — a mismatch there is a derived-repo authoring bug the manifest schema cannot itself observe). */
  namespace: ExtensionManifestMigrationNamespace;
  /**
   * Every migration file the derived application has ALREADY shipped
   * (applied to at least one real deployment) — the append-only,
   * immutable ledger this manifest asserts. A file listed here whose
   * on-disk checksum no longer matches is the headline compatibility
   * failure this issue exists to catch: "a derived repo can't silently
   * redefine a migration that already shipped." Empty array is valid
   * (a derived application that has never shipped a migration yet).
   */
  historicalChecksums: readonly ExtensionManifestMigrationChecksum[];
};

export type ExtensionManifestCapabilityBinding = {
  /** Matches a `ModuleCapabilityContract.provides`/`.consumes[].capability` string (ADR-0011) — e.g. `"public_content"`. */
  key: string;
  version: string;
};

export type ExtensionManifestRequiredCapability =
  ExtensionManifestCapabilityBinding & {
    /** Module key expected to provide this capability — matches `ModuleCapabilityDependency.providedBy`. Purely descriptive at the manifest layer (see `contributedModules` field doc — real provider RESOLUTION is `composeModuleRegistry`'s job). */
    providedBy: string;
    optional?: boolean;
  };

export type ExtensionManifestCapabilities = {
  /** Capabilities this derived application's OWN contributed modules provide — versions here are the SOURCE OF TRUTH for `requires` entries below that name one of these same keys (self-consistency), never looked up in the base's global `CAPABILITY_CONTRACT_VERSIONS`. */
  provides?: readonly ExtensionManifestCapabilityBinding[];
  /** Capabilities this derived application consumes — resolved against the base's global `CAPABILITY_CONTRACT_VERSIONS` registry first, then against this SAME manifest's own `provides` list (a derived app's module consuming another of its own modules' capabilities); unresolved by either is `capability_unknown`. */
  requires?: readonly ExtensionManifestRequiredCapability[];
};

export type ExtensionManifestConsumedContracts = {
  /** SemVer this derived application was built/tested against — compared to the base's ACTUAL current `openapi/awcms-mini-public-api.openapi.yaml` `info.version` (ADR-0008: MAJOR mismatch is always breaking; a MINOR/PATCH the manifest declares higher than what's actually shipped means the derived app assumes a feature that doesn't exist yet). */
  openApiContractVersion?: string;
  /** Same comparison, against `asyncapi/awcms-mini-domain-events.asyncapi.yaml` `info.version`. */
  asyncApiContractVersion?: string;
};

export type ExtensionManifestDeployment = {
  /** Deployment profiles this derived application declares it MUST be able to run under (e.g. `["offline-lan"]` for a LAN-first POS). Checked against each `contributedModules[].deploymentProfiles` entry that itself declares a list — see `ExtensionManifestContributedModule`'s own doc comment. */
  requiredProfiles: readonly ExtensionManifestDeploymentProfile[];
};

export type ExtensionCompatibilityManifest = {
  manifestVersion: string;
  application: ExtensionManifestApplication;
  /** SemVer RANGE (see `src/lib/semver/compare.ts`) this derived application declares itself compatible with, checked against this repository's OWN current `package.json` `version` — e.g. `">=0.23.0 <1.0.0"`. */
  compatibleAwcmsMiniRange: string;
  /** SemVer this manifest was authored against — compared to the base's ACTUAL current `MODULE_CONTRACT_VERSION` (`module-contract.ts`). */
  moduleContractVersion: string;
  /**
   * SemVer of the SaaS commercial contract (`SAAS_CONTRACT_VERSION`,
   * `module-contract.ts`) this derived application's own SaaS descriptors were
   * authored against (Issue #874) — compared to the base's ACTUAL current
   * `SAAS_CONTRACT_VERSION` with the same MAJOR-match/MINOR-ceiling rule as
   * `moduleContractVersion`. OPTIONAL: absence means "no SaaS contract
   * constraint declared" (a derived app that contributes no
   * features/meters/quotas), same absence convention `minAppVersion`/
   * `consumes.*` already use.
   */
  saasContractVersion?: string;
  contributedModules: readonly ExtensionManifestContributedModule[];
  migrations: ExtensionManifestMigrations;
  capabilities?: ExtensionManifestCapabilities;
  deployment: ExtensionManifestDeployment;
  consumes?: ExtensionManifestConsumedContracts;
};
