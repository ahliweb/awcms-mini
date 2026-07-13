/**
 * Deterministic build-time module composition — the validation engine
 * (Issue #740, epic #738 `platform-evolution`, Wave 1). Composes the
 * reviewed base registry (`src/modules/index.ts`'s `listBaseModules()`)
 * with at most one reviewed application registry
 * (`ApplicationModuleRegistry`, supplied only through the designated
 * build-time extension point `src/modules/application-registry.ts`) into
 * one final, validated module list. See
 * `docs/adr/0013-extension-layers-and-boundary-model.md` §5/§9 and
 * `docs/awcms-mini/21_module_admission_governance.md` §7 for the binding
 * architectural context this implements: the base registry stays the
 * single, statically-reviewed source of Core/System/Official Optional
 * modules; a derived repository contributes application modules WITHOUT
 * ever editing `src/modules/index.ts`, and composition is 100%
 * compile-time TypeScript — no runtime discovery, file upload, package
 * scanning, `eval`, or untrusted code loading.
 *
 * ## Why this lives in `module-management/domain/`, not `_shared/`
 *
 * This reuses `./module-dependency-graph.ts` (`validateModuleDependencyGraph`)
 * and `./job-registry.ts` (`validateJobDescriptor`) directly — both SIBLING
 * files in this same module's `domain/` folder. `_shared/module-contract.ts`
 * is deliberately dependency-free (every module, including this one,
 * depends ON it — the contract file has always had zero imports); if this
 * validation engine lived in `_shared/` instead, it would need to import
 * FROM `module-management/domain/`, inverting that direction for the sake
 * of one module's convenience. `module_management` is already the
 * established owner of "registry-wide, pure, no-I/O" validation
 * (`module-dependency-graph.ts`'s own header comment, Issue #680) — this is
 * the same kind of concern, so it lives alongside it. Only
 * `src/modules/index.ts` (the composition root, which already legitimately
 * imports every module) and CLI scripts import this file — same
 * already-established precedent as `scripts/validate-module-graph.ts` and
 * `scripts/modules-sync.ts` reaching into `module-management/domain/`
 * today. This does not touch the module-boundary rule
 * (`tests/unit/module-boundary.test.ts`), which restricts a DIFFERENT
 * thing: one module's `application`/`domain` tree importing ANOTHER
 * module's `application`/`domain` tree directly, instead of through
 * `_shared/ports/`.
 *
 * ## Two-phase design: merge (always succeeds) vs validate (can fail)
 *
 * `mergeModuleRegistries` is a pure, unconditional concatenation — base
 * modules first (in their declared order), then the application
 * registry's modules (in ITS declared order), never reordered,
 * deduplicated, or mutated. This is deliberately the ONLY thing
 * `src/modules/index.ts` itself calls (mirroring the existing architecture
 * where `index.ts` is pure data and has never itself thrown —
 * `listModules()` before Issue #740 was `return modules`, no validation,
 * ever; `validateModuleDependencyGraph` has always been a SEPARATE,
 * explicit call a script/test makes, never embedded in module load). This
 * is also WHY a default base build (`applicationModuleRegistry ===
 * undefined`, this base repo's real shipped state) produces a
 * byte-identical effective registry to before this issue: merging with
 * nothing is a no-op pass-through (`[...base]`, same order, same object
 * references).
 *
 * `validateComposedModuleRegistry` is the actual rule engine — called
 * explicitly by `bun run modules:compose:check`
 * (`scripts/validate-module-composition.ts`) and by tests, never by
 * `index.ts`'s module-load path. `composeModuleRegistry` is a convenience
 * wrapper combining both for callers that want one call (the CI script,
 * the composed-inventory generator, fixture tests).
 *
 * ## Every composition issue class (see `ModuleCompositionIssue`)
 *
 * Reused as-is from the existing whole-registry DAG validator (Issue
 * #680), run against the MERGED list: `self_dependency`,
 * `duplicate_dependency`, `missing_dependency`, `cycle`.
 *
 * New in this issue:
 * - `duplicate_module_key` — two contributed application modules share a
 *   key (neither is a base module's key — see `prohibited_base_override`
 *   for that case, reported INSTEAD of this one on the same collision to
 *   avoid double-noise, the same "most specific issue wins" philosophy
 *   `module-dependency-graph.ts` already documents for its own
 *   self-dependency/duplicate-dependency split).
 * - `prohibited_base_override` — an application module's `key` exactly
 *   matches a BASE module's key. Doc 21 §7 / ADR-0013 §9's guardrail says
 *   "Core/System modules cannot be replaced or shadowed" — this check is
 *   deliberately stricter (ANY base module, not only Core/System),
 *   because `ModuleDescriptor.type` is not consistently populated across
 *   the base registry today (doc 21 §8's own remediation note R1: 9 of 16
 *   modules leave `type` `undefined`), so a Core/System-only filter would
 *   be unreliable. Blocking every base collision is a strict superset of
 *   the required guardrail and forbids nothing an application registry
 *   would ever legitimately need — an application module reusing a base
 *   module's own key is never correct.
 * - `invalid_module_type` — an application module declares `type: "base"`
 *   or `type: "system"` — those categories are reserved for the reviewed
 *   base registry (doc 21 §2); an application/derived module must be
 *   `"domain"`, `"integration"`, `"derived"`, or leave `type` undeclared
 *   (same leniency the base registry itself allows, doc 21 §8 R1).
 * - `capability_provider_conflict` — two or more modules in the merged
 *   registry declare the same string in their own `capabilities.provides`
 *   — ambiguous which module a consumer's `providedBy` actually resolves
 *   to.
 * - `capability_provider_missing` — a REQUIRED (`optional` not `true`)
 *   `capabilities.consumes` entry names a `providedBy` module that either
 *   isn't in the merged registry at all, or IS but doesn't declare that
 *   capability in its own `provides`. An `optional: true` entry is never
 *   checked — ADR-0011's whole point is that the consumer degrades safely
 *   when it resolves to "not applicable".
 * - `migration_namespace_overlap` — the application registry's declared
 *   `migrationNamespace` numeric range intersects the base's reserved
 *   range (`BASE_MODULE_MIGRATION_NAMESPACE`). Best-effort, declared-data
 *   only: this does NOT read real `sql/*.sql` filenames (a pure domain
 *   function has no filesystem access, matching this module's own no-I/O
 *   convention) — skipped entirely when the application registry omits
 *   `migrationNamespace`.
 * - `deployment_profile_incompatible` — a module declares
 *   `compatibility.deploymentProfiles` including a profile that one of its
 *   own `dependencies` (which also declares `deploymentProfiles`) does NOT
 *   support — claiming to run somewhere a required dependency cannot.
 * - `navigation_path_conflict` — two navigation entries anywhere in the
 *   merged registry (same module or different modules) declare the exact
 *   same `path`.
 * - `invalid_job_descriptor` — reuses `./job-registry.ts`'s
 *   `validateJobDescriptor` against every contributed module's `jobs`
 *   array (not just the base registry's, which already implicitly passes
 *   today, verified by `tests/unit/module-composition.test.ts`'s own
 *   "real base registry" smoke test).
 *
 * No issue type exists for permission catalogs or health descriptors
 * beyond what's covered above — `ModuleHealthContract` is two optional
 * booleans with no shape to validate, and permission entries are
 * inherently namespaced by their own module's `key`
 * (`comparePermissions`'s `${moduleKey}.${activityCode}.${action}`,
 * `domain/permission-sync.ts`) so cross-module collisions are structurally
 * impossible. Both still flow into `buildComposedModuleInventory` below so
 * the deterministic inventory reflects contributed modules' permission and
 * health metadata (acceptance criterion: "Permission/navigation/job/health
 * inventories include contributed modules and remain deterministic").
 */
import type {
  ApplicationModuleRegistry,
  ModuleDescriptor,
  ModuleMigrationNamespace
} from "../../_shared/module-contract";
import { validateJobDescriptor } from "./job-registry";
import {
  formatModuleDependencyGraphIssue,
  validateModuleDependencyGraph,
  type ModuleDependencyGraphIssue
} from "./module-dependency-graph";

/**
 * This base repository's own reserved migration-number range — every
 * `sql/NNN_awcms_mini_*.sql` file this repo ever ships must stay within
 * `1..899`. `899` is a deliberately generous ceiling (the real current
 * high-water mark is far below it — `ls sql | sort -V | tail -1` for the
 * live count) so the base can keep growing for a long time without needing
 * to renumber anything; a derived repository's own `migrationNamespace`
 * must start at `900` or above (or otherwise not overlap this range) to
 * guarantee zero numbering collisions with the base by construction. This
 * is a POLICY constant, not derived from the real `sql/` directory (this
 * file is pure, no filesystem access — the real directory is cross-checked
 * separately by `scripts/repo-inventory-generate.ts`).
 */
export const BASE_MODULE_MIGRATION_NAMESPACE: ModuleMigrationNamespace = {
  label: "awcms-mini base",
  rangeStart: 1,
  rangeEnd: 899
};

export type ModuleCompositionIssue =
  | ModuleDependencyGraphIssue
  | { type: "duplicate_module_key"; moduleKey: string; occurrences: number }
  | {
      type: "prohibited_base_override";
      moduleKey: string;
      baseModuleType: string | undefined;
    }
  | { type: "invalid_module_type"; moduleKey: string; declaredType: string }
  | {
      type: "capability_provider_conflict";
      capability: string;
      providerModuleKeys: readonly string[];
    }
  | {
      type: "capability_provider_missing";
      moduleKey: string;
      capability: string;
      providedBy: string;
      reason:
        "provider_not_registered" | "provider_does_not_declare_capability";
    }
  | {
      type: "migration_namespace_overlap";
      applicationLabel: string;
      baseLabel: string;
      overlapStart: number;
      overlapEnd: number;
    }
  | {
      type: "deployment_profile_incompatible";
      moduleKey: string;
      dependencyKey: string;
      unsupportedProfile: string;
    }
  | {
      type: "navigation_path_conflict";
      path: string;
      moduleKeys: readonly string[];
    }
  | {
      type: "invalid_job_descriptor";
      moduleKey: string;
      command: string;
      errors: readonly string[];
    };

export type ModuleCompositionInput = {
  base: readonly ModuleDescriptor[];
  application?: ApplicationModuleRegistry;
};

export type ModuleCompositionResult =
  | { valid: true; registry: readonly ModuleDescriptor[] }
  | {
      valid: false;
      registry: readonly ModuleDescriptor[];
      issues: readonly ModuleCompositionIssue[];
    };

/**
 * Pure, unconditional concatenation — see file header for why
 * `src/modules/index.ts` calls ONLY this, never
 * `validateComposedModuleRegistry`, directly.
 */
export function mergeModuleRegistries(
  base: readonly ModuleDescriptor[],
  application: ApplicationModuleRegistry | undefined
): readonly ModuleDescriptor[] {
  return application ? [...base, ...application.modules] : [...base];
}

export function formatModuleCompositionIssue(
  issue: ModuleCompositionIssue
): string {
  switch (issue.type) {
    case "self_dependency":
    case "duplicate_dependency":
    case "missing_dependency":
    case "cycle":
      return formatModuleDependencyGraphIssue(issue);
    case "duplicate_module_key":
      return `Module key "${issue.moduleKey}" is declared ${issue.occurrences} times by the application registry.`;
    case "prohibited_base_override":
      return `Application module "${issue.moduleKey}" uses the same key as a base module (type: ${issue.baseModuleType ?? "undeclared"}) — application registries cannot replace or shadow any base module.`;
    case "invalid_module_type":
      return `Application module "${issue.moduleKey}" declares type "${issue.declaredType}", which is reserved for the reviewed base registry (must be "domain", "integration", "derived", or left undeclared).`;
    case "capability_provider_conflict":
      return `Capability "${issue.capability}" is provided by more than one module: ${issue.providerModuleKeys.join(", ")}.`;
    case "capability_provider_missing":
      return issue.reason === "provider_not_registered"
        ? `Module "${issue.moduleKey}" requires capability "${issue.capability}" from "${issue.providedBy}", which is not a registered module in the composed registry.`
        : `Module "${issue.moduleKey}" requires capability "${issue.capability}" from "${issue.providedBy}", which does not declare providing that capability.`;
    case "migration_namespace_overlap":
      return `Migration namespace "${issue.applicationLabel}" overlaps the base's reserved namespace "${issue.baseLabel}" in the range ${issue.overlapStart}-${issue.overlapEnd}.`;
    case "deployment_profile_incompatible":
      return `Module "${issue.moduleKey}" declares compatibility with deployment profile "${issue.unsupportedProfile}", but its dependency "${issue.dependencyKey}" does not support that profile.`;
    case "navigation_path_conflict":
      return `Navigation path "${issue.path}" is declared by more than one module: ${issue.moduleKeys.join(", ")}.`;
    case "invalid_job_descriptor":
      return `Module "${issue.moduleKey}" declares an invalid job "${issue.command}": ${issue.errors.join("; ")}`;
  }
}

function checkKeyCollisions(
  base: readonly ModuleDescriptor[],
  application: ApplicationModuleRegistry | undefined
): ModuleCompositionIssue[] {
  const issues: ModuleCompositionIssue[] = [];
  if (!application) return issues;

  const baseByKey = new Map(base.map((m) => [m.key, m] as const));
  const applicationKeyCounts = new Map<string, number>();

  for (const module of application.modules) {
    const baseMatch = baseByKey.get(module.key);
    if (baseMatch) {
      issues.push({
        type: "prohibited_base_override",
        moduleKey: module.key,
        baseModuleType: baseMatch.type
      });
      continue;
    }

    applicationKeyCounts.set(
      module.key,
      (applicationKeyCounts.get(module.key) ?? 0) + 1
    );
  }

  for (const [moduleKey, occurrences] of applicationKeyCounts) {
    if (occurrences > 1) {
      issues.push({ type: "duplicate_module_key", moduleKey, occurrences });
    }
  }

  return issues;
}

function checkModuleTypes(
  application: ApplicationModuleRegistry | undefined
): ModuleCompositionIssue[] {
  if (!application) return [];

  return application.modules
    .filter((m) => m.type === "base" || m.type === "system")
    .map((m) => ({
      type: "invalid_module_type" as const,
      moduleKey: m.key,
      declaredType: m.type!
    }));
}

function checkCapabilityBindings(
  merged: readonly ModuleDescriptor[]
): ModuleCompositionIssue[] {
  const issues: ModuleCompositionIssue[] = [];
  const byKey = new Map(merged.map((m) => [m.key, m] as const));

  const providerMap = new Map<string, string[]>();
  for (const module of merged) {
    for (const capability of module.capabilities?.provides ?? []) {
      const providers = providerMap.get(capability) ?? [];
      providers.push(module.key);
      providerMap.set(capability, providers);
    }
  }

  for (const [capability, providerModuleKeys] of providerMap) {
    if (providerModuleKeys.length > 1) {
      issues.push({
        type: "capability_provider_conflict",
        capability,
        providerModuleKeys
      });
    }
  }

  for (const module of merged) {
    for (const consumed of module.capabilities?.consumes ?? []) {
      if (consumed.optional) continue;

      const provider = byKey.get(consumed.providedBy);
      if (!provider) {
        issues.push({
          type: "capability_provider_missing",
          moduleKey: module.key,
          capability: consumed.capability,
          providedBy: consumed.providedBy,
          reason: "provider_not_registered"
        });
        continue;
      }

      if (
        !(provider.capabilities?.provides ?? []).includes(consumed.capability)
      ) {
        issues.push({
          type: "capability_provider_missing",
          moduleKey: module.key,
          capability: consumed.capability,
          providedBy: consumed.providedBy,
          reason: "provider_does_not_declare_capability"
        });
      }
    }
  }

  return issues;
}

function rangesOverlap(
  a: ModuleMigrationNamespace,
  b: ModuleMigrationNamespace
): boolean {
  return a.rangeStart <= b.rangeEnd && b.rangeStart <= a.rangeEnd;
}

function checkMigrationNamespace(
  application: ApplicationModuleRegistry | undefined
): ModuleCompositionIssue[] {
  if (!application?.migrationNamespace) return [];

  const ns = application.migrationNamespace;
  if (!rangesOverlap(ns, BASE_MODULE_MIGRATION_NAMESPACE)) return [];

  return [
    {
      type: "migration_namespace_overlap",
      applicationLabel: ns.label,
      baseLabel: BASE_MODULE_MIGRATION_NAMESPACE.label,
      overlapStart: Math.max(
        ns.rangeStart,
        BASE_MODULE_MIGRATION_NAMESPACE.rangeStart
      ),
      overlapEnd: Math.min(
        ns.rangeEnd,
        BASE_MODULE_MIGRATION_NAMESPACE.rangeEnd
      )
    }
  ];
}

function checkDeploymentProfiles(
  merged: readonly ModuleDescriptor[]
): ModuleCompositionIssue[] {
  const issues: ModuleCompositionIssue[] = [];
  const byKey = new Map(merged.map((m) => [m.key, m] as const));

  for (const module of merged) {
    const ownProfiles = module.compatibility?.deploymentProfiles;
    if (!ownProfiles) continue;

    for (const dependencyKey of module.dependencies) {
      const dependencyProfiles =
        byKey.get(dependencyKey)?.compatibility?.deploymentProfiles;
      if (!dependencyProfiles) continue;

      for (const profile of ownProfiles) {
        if (!dependencyProfiles.includes(profile)) {
          issues.push({
            type: "deployment_profile_incompatible",
            moduleKey: module.key,
            dependencyKey,
            unsupportedProfile: profile
          });
        }
      }
    }
  }

  return issues;
}

function checkNavigationPaths(
  merged: readonly ModuleDescriptor[]
): ModuleCompositionIssue[] {
  const pathToModules = new Map<string, string[]>();

  for (const module of merged) {
    for (const entry of module.navigation ?? []) {
      const owners = pathToModules.get(entry.path) ?? [];
      owners.push(module.key);
      pathToModules.set(entry.path, owners);
    }
  }

  const issues: ModuleCompositionIssue[] = [];
  for (const [path, moduleKeys] of pathToModules) {
    if (moduleKeys.length > 1) {
      issues.push({ type: "navigation_path_conflict", path, moduleKeys });
    }
  }
  return issues;
}

function checkJobDescriptors(
  merged: readonly ModuleDescriptor[]
): ModuleCompositionIssue[] {
  const issues: ModuleCompositionIssue[] = [];

  for (const module of merged) {
    for (const job of module.jobs ?? []) {
      const result = validateJobDescriptor(job);
      if (!result.valid) {
        issues.push({
          type: "invalid_job_descriptor",
          moduleKey: module.key,
          command: job.command,
          errors: result.errors
        });
      }
    }
  }

  return issues;
}

/**
 * The full rule engine. Reports EVERY distinct issue across the whole
 * composed registry in one pass (never stops at the first), same
 * philosophy `validateModuleDependencyGraph`'s own tests document.
 */
export function validateComposedModuleRegistry(
  input: ModuleCompositionInput
): readonly ModuleCompositionIssue[] {
  const merged = mergeModuleRegistries(input.base, input.application);
  const dagResult = validateModuleDependencyGraph(merged);

  return [
    ...(dagResult.valid ? [] : dagResult.issues),
    ...checkKeyCollisions(input.base, input.application),
    ...checkModuleTypes(input.application),
    ...checkCapabilityBindings(merged),
    ...checkMigrationNamespace(input.application),
    ...checkDeploymentProfiles(merged),
    ...checkNavigationPaths(merged),
    ...checkJobDescriptors(merged)
  ];
}

/**
 * Convenience wrapper combining merge + validate for callers that want one
 * call (the CI script, the composed-inventory generator, fixture tests).
 * `registry` is always present (even when `valid: false`) so a caller can
 * still inspect what WOULD have been composed for diagnostics — never
 * treat it as safe to ship/sync when `valid` is `false`.
 */
export function composeModuleRegistry(
  input: ModuleCompositionInput
): ModuleCompositionResult {
  const registry = mergeModuleRegistries(input.base, input.application);
  const issues = validateComposedModuleRegistry(input);

  return issues.length > 0
    ? { valid: false, registry, issues }
    : { valid: true, registry };
}

export type ComposedModuleInventoryEntry = {
  key: string;
  name: string;
  version: string;
  status: string;
  type: string | null;
  source: "base" | "application";
  dependencies: readonly string[];
  capabilitiesProvided: readonly string[];
  capabilitiesConsumed: readonly {
    capability: string;
    providedBy: string;
    optional: boolean;
  }[];
  permissionCount: number;
  navigationCount: number;
  jobCount: number;
  hasHealthCheck: boolean;
  hasReadinessCheck: boolean;
  deploymentProfiles: readonly string[] | null;
};

export type ComposedModuleInventory = {
  baseModuleCount: number;
  applicationModuleCount: number;
  applicationRegistryId: string | null;
  totalModuleCount: number;
  valid: boolean;
  issueCount: number;
  migrationNamespaces: readonly {
    label: string;
    rangeStart: number;
    rangeEnd: number;
    source: "base" | "application";
  }[];
  modules: readonly ComposedModuleInventoryEntry[];
};

function toInventoryEntry(
  module: ModuleDescriptor,
  source: "base" | "application"
): ComposedModuleInventoryEntry {
  return {
    key: module.key,
    name: module.name,
    version: module.version,
    status: module.status,
    type: module.type ?? null,
    source,
    dependencies: module.dependencies,
    capabilitiesProvided: module.capabilities?.provides ?? [],
    capabilitiesConsumed: (module.capabilities?.consumes ?? []).map((c) => ({
      capability: c.capability,
      providedBy: c.providedBy,
      optional: c.optional ?? false
    })),
    permissionCount: module.permissions?.length ?? 0,
    navigationCount: module.navigation?.length ?? 0,
    jobCount: module.jobs?.length ?? 0,
    hasHealthCheck: module.health?.hasHealthCheck ?? false,
    hasReadinessCheck: module.health?.hasReadinessCheck ?? false,
    deploymentProfiles: module.compatibility?.deploymentProfiles ?? null
  };
}

/**
 * Deterministic, machine-readable composed inventory for CI/release
 * evidence (Issue #740's own acceptance criterion). No wall-clock
 * timestamp embedded — same "pure function of committed source" freshness
 * design `scripts/repo-inventory-generate.ts` documents for its own
 * output, enforced the same way (`scripts/module-composition-inventory-
 * check.ts`'s regenerate-and-diff gate). `modules` is sorted by `key` so
 * two runs against the same input always produce byte-identical JSON,
 * independent of registration order.
 *
 * When the composed registry is INVALID (e.g. a `prohibited_base_override`
 * collision), `source` for the colliding application module is still
 * attributed via `baseKeys.has(...)`, which will misreport it as `"base"`
 * for that one specific collision case — a minor cosmetic inaccuracy in an
 * already-rejected, `valid: false` result (`issueCount` makes the broken
 * state unambiguous); this inventory is diagnostic evidence, never treated
 * as safe-to-ship data when `valid` is `false`.
 */
export function buildComposedModuleInventory(
  input: ModuleCompositionInput
): ComposedModuleInventory {
  const result = composeModuleRegistry(input);
  const baseKeys = new Set(input.base.map((m) => m.key));

  const modules = [...result.registry]
    .map((m) =>
      toInventoryEntry(m, baseKeys.has(m.key) ? "base" : "application")
    )
    .sort((a, b) => a.key.localeCompare(b.key));

  const migrationNamespaces: ComposedModuleInventory["migrationNamespaces"] = [
    { ...BASE_MODULE_MIGRATION_NAMESPACE, source: "base" },
    ...(input.application?.migrationNamespace
      ? [
          {
            ...input.application.migrationNamespace,
            source: "application" as const
          }
        ]
      : [])
  ];

  return {
    baseModuleCount: input.base.length,
    applicationModuleCount: input.application?.modules.length ?? 0,
    applicationRegistryId: input.application?.id ?? null,
    totalModuleCount: result.registry.length,
    valid: result.valid,
    issueCount: result.valid ? 0 : result.issues.length,
    migrationNamespaces,
    modules
  };
}
