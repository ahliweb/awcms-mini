/**
 * Module descriptor contract (Issue #511, epic #492/#510). Extended for
 * Module Management: richer trusted metadata about each module, while
 * every addition here is optional so the existing 9 registered modules'
 * descriptors (which only set the original fields) remain valid without
 * any change.
 *
 * Everything in a `ModuleDescriptor` is **trusted code-only metadata** —
 * written by the module's own `module.ts`, checked in to the repo, never
 * user/tenant-controlled. It must never carry a runtime secret, token,
 * password, or provider credential (those live in `process.env` only,
 * doc 18) — this is descriptive/declarative metadata, not configuration
 * *values*.
 */

/** Broad category a module falls into — descriptive only, not itself an authorization or enable/disable mechanism. */
export type ModuleType =
  "base" | "system" | "domain" | "integration" | "derived";

/**
 * `disabled` here means globally disabled by code/deployment (the module
 * is registered but inert everywhere) — **not** a per-tenant toggle.
 * Tenant-level enable/disable is database state
 * (`awcms_mini_tenant_modules`, Issue #512/#515), tracked independently of
 * this descriptor-level status.
 */
export type ModuleLifecycleStatus =
  "active" | "experimental" | "deprecated" | "maintenance" | "disabled";

export type ModuleApiContract = {
  openApiPath: string;
  basePath: string;
};

export type ModuleEventContract = {
  asyncApiPath?: string;
  publishes?: string[];
  subscribes?: string[];
};

/** One permission this module declares to the catalog — `module_key` is the descriptor's own `key`, never repeated here. Consumed by Issue #517's sync/status comparison against `awcms_mini_permissions`. */
export type ModulePermissionDescriptor = {
  activityCode: string;
  action: string;
  description: string;
};

/** One admin navigation entry this module wants rendered — consumed by Issue #518's navigation registry/sidebar. `requiredPermission` is checked in addition to (not instead of) the target page/API's own server-side guard. */
export type ModuleNavigationEntry = {
  labelKey: string;
  path: string;
  icon?: string;
  order?: number;
  group?: string;
  requiredPermission?: string;
};

/** Non-secret settings shape/defaults only — consumed by Issue #516. Never put a secret-shaped default here; real secrets stay in env/secret manager. */
export type ModuleSettingsContract = {
  schemaVersion?: number;
  defaults?: Record<string, unknown>;
};

/** One operational command this module ships — consumed by Issue #519's job registry (documentation only, never an execute-from-UI action). */
export type ModuleJobDescriptor = {
  command: string;
  purpose: string;
  recommendedSchedule?: string;
  environmentNotes?: string;
  safeInOfflineLan?: boolean;
};

/** Capability flags only — the real check logic (DB reachable, provider configured, etc.) is implemented in Issue #520, this just declares that the module has one. */
export type ModuleHealthContract = {
  hasHealthCheck?: boolean;
  hasReadinessCheck?: boolean;
};

/**
 * Deployment profile names (Issue #740, epic #738 `platform-evolution`).
 * Same four values as `src/lib/config/registry.ts`'s own `DeploymentProfile`
 * — redeclared here rather than imported, to keep this contract file
 * dependency-free (it has always had zero imports; every module.ts across
 * every module, and now every derived repository's own
 * `application-registry.ts`, transitively depends on this file). Keep both
 * lists in sync if `docs/awcms-mini/deployment-profiles.md` ever adds a
 * profile — `src/modules/module-management/domain/module-composition.ts`
 * cross-checks values structurally (plain string comparison), not by
 * nominal type identity, so this is a documentation obligation, not a
 * compile-time-enforced one.
 */
export type ModuleDeploymentProfile =
  "development" | "staging" | "production" | "offline-lan";

/** Compatibility metadata used by Issue #515's dependency-graph validation to report version incompatibility when present — absence means "no constraint declared", not "incompatible". */
export type ModuleCompatibilityContract = {
  minAppVersion?: string;
  /**
   * Deployment profiles (`docs/awcms-mini/deployment-profiles.md`) this
   * module — base or contributed application module — is declared
   * compatible with (Issue #740). Absence means "no constraint declared",
   * same convention `minAppVersion`'s absence already uses — compatible
   * with every profile. Build-time composition
   * (`module-management/domain/module-composition.ts`) reports a
   * `deployment_profile_incompatible` issue when a module claims a profile
   * one of its own `dependencies` does not support.
   */
  deploymentProfiles?: readonly ModuleDeploymentProfile[];
};

/**
 * One capability this module's application/domain code consumes from
 * ANOTHER module, via a port (Issue #681, epic #679 platform-hardening) —
 * `_shared/ports/*.ts` defines the actual TypeScript interface;
 * `providedBy` names the module whose adapter (`<module>/application/
 * *-port-adapter.ts`) implements it, wired at the composition root (route
 * handlers), never a direct cross-module import inside `application`/
 * `domain`. Deliberately separate from `dependencies` above, which governs
 * enable/disable LIFECYCLE ORDERING only and is checked by
 * `domain/tenant-module-lifecycle.ts` — `capabilities` is documentation of
 * a SOURCE-LEVEL relationship (enforced by the structural boundary test,
 * `tests/unit/module-boundary.test.ts`), not a lifecycle constraint; a
 * module can consume another's capability while still declaring `[]`
 * `dependencies` on it (exactly the case for `blog_content`/`news_portal`
 * — see both modules' own `module.ts` for why a hard `dependencies` edge
 * between them was rejected back in Issue #632).
 *
 * `optional: true` means the CONSUMING module's own feature degrades
 * safely (documented per call site) when the capability resolves to "not
 * applicable" for a given tenant/request — not "the code can run without
 * the other module's source present" (this is a monolith; all modules'
 * code always ships together, only per-tenant DB-backed enable state
 * varies).
 */
export type ModuleCapabilityDependency = {
  capability: string;
  providedBy: string;
  optional?: boolean;
};

export type ModuleCapabilityContract = {
  /** Capability names THIS module provides an adapter for (matches a port defined in `_shared/ports/`), for other modules to declare in their own `consumes`. */
  provides?: string[];
  consumes?: ModuleCapabilityDependency[];
};

export type ModuleDescriptor = {
  key: string;
  name: string;
  version: string;
  status: ModuleLifecycleStatus;
  description: string;
  dependencies: string[];
  api?: ModuleApiContract;
  events?: ModuleEventContract;
  type?: ModuleType;
  isCore?: boolean;
  permissions?: ModulePermissionDescriptor[];
  navigation?: ModuleNavigationEntry[];
  settings?: ModuleSettingsContract;
  jobs?: ModuleJobDescriptor[];
  health?: ModuleHealthContract;
  compatibility?: ModuleCompatibilityContract;
  capabilities?: ModuleCapabilityContract;
  maintainers?: string[];
};

export function defineModule(descriptor: ModuleDescriptor): ModuleDescriptor {
  return descriptor;
}

/**
 * One derived/downstream repository's declared reservation of the numeric
 * `NNN_` migration-filename prefix range its own `sql/` directory owns
 * (Issue #740). Purely declarative composition metadata — this contract
 * does not read real `sql/*.sql` filenames (see
 * `module-management/domain/module-composition.ts`'s file header for why
 * that check stays a pure, filesystem-free, declared-data comparison).
 */
export type ModuleMigrationNamespace = {
  /** Human label for diagnostics, e.g. "awpos" or "smart-school-portal". */
  label: string;
  /** Inclusive lower bound of the numeric `NNN_` migration filename prefix this registry owns. */
  rangeStart: number;
  /** Inclusive upper bound. */
  rangeEnd: number;
};

/**
 * SemVer of the `ModuleDescriptor`/`ApplicationModuleRegistry` TYPE SHAPE
 * itself — independent of `package.json` (release version) and the
 * OpenAPI/AsyncAPI `info.version` (REST/event contract version), same
 * "three independent versioning schemes" precedent ADR-0008 already
 * establishes for those two. This is the fourth: the module descriptor
 * *contract* (this file's own exported types), added by Issue #741 (epic
 * #738 `platform-evolution`, Wave 1) so a derived repository's
 * compatibility manifest (`docs/adr/0015-derived-application-
 * compatibility-manifest.md`) can declare which shape of this file it was
 * written against and fail with an actionable diagnostic
 * (`bun run extension:check`) instead of a raw TypeScript compile error
 * when a future breaking change lands.
 *
 * Bump policy (mirrors ADR-0008 §2's contract bump rules exactly):
 * - **MAJOR** — a field is removed, renamed, or an existing optional
 *   field becomes required (a derived repository's existing `module.ts`
 *   could stop compiling or change meaning).
 * - **MINOR** — a new optional field is added (every addition to this
 *   file so far, including Issue #740's own `capabilities`/
 *   `compatibility.deploymentProfiles`/`ApplicationModuleRegistry`, has
 *   been exactly this kind of change).
 * - **PATCH** — documentation-only clarification, no shape change.
 *
 * `1.0.0` here is a first declaration, not a "declared stable" milestone
 * the way ADR-0008 §2 uses `1.0.0` for the REST/event contract — this
 * file's shape was never versioned before Issue #741; every prior
 * addition (Issue #511, #681, #740) was already additive/non-breaking by
 * convention, just never assigned a number a derived repository could
 * check against.
 */
export const MODULE_CONTRACT_VERSION = "1.0.0";

/**
 * One derived/downstream repository's contribution to the final composed
 * module registry (Issue #740, epic #738 `platform-evolution`, Wave 1).
 * Supplied ONLY through the designated build-time extension point
 * (`src/modules/application-registry.ts`) — never by editing
 * `src/modules/index.ts` itself. Still 100% static, compile-time
 * TypeScript — no runtime discovery/upload/package scanning/`eval`, per
 * `docs/awcms-mini/21_module_admission_governance.md` §7 and
 * `docs/adr/0013-extension-layers-and-boundary-model.md` §9. See
 * `src/modules/module-management/domain/module-composition.ts` for the
 * validation engine that composes this against the base registry.
 */
export type ApplicationModuleRegistry = {
  /** Stable, human-readable identifier for the contributing repository/application — used in diagnostics and the composed inventory only, never persisted to a database or used for authorization. */
  id: string;
  modules: readonly ModuleDescriptor[];
  /**
   * This application registry's own reserved migration-number range,
   * validated against the base's reserved range
   * (`module-composition.ts`'s `BASE_MODULE_MIGRATION_NAMESPACE`) to catch
   * a numbering collision before any migration file is even written.
   * Optional: composition skips the overlap check when omitted (a
   * documented caveat, not a silent pass).
   */
  migrationNamespace?: ModuleMigrationNamespace;
};
