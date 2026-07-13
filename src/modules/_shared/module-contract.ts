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
 * High-volume table lifecycle descriptor (Issue #745, epic #738
 * platform-evolution Wave 1 — the `data_lifecycle` System Foundation
 * module, ADR-0013 §1/§6). A module that owns a table expected to grow
 * large (audit/analytics/outbox/queue-shaped data) contributes ONE of
 * these per table in its OWN `module.ts`'s `dataLifecycle` array — the
 * same "module declares its own descriptor, a central engine reads
 * `listModules()`" shape `permissions`/`navigation`/`jobs` above already
 * use. `data_lifecycle`'s registry/engine
 * (`src/modules/data-lifecycle/`) never reads another module's schema
 * without one of these present — ADR-0013 §6's "operates through the
 * contract declared by the owning module, never accessing another
 * module's schema without that contract" IS this type.
 *
 * This is TRUSTED CODE-ONLY METADATA (same rule as every descriptor type
 * above) — an immutable fact declared by the owning module's source,
 * never tenant/request-controlled, and never itself duplicated into a
 * mutable settings table (issue #745 scope: "do not duplicate immutable
 * descriptor facts in mutable settings" — the few genuine runtime/tenant
 * overrides this system needs, e.g. legal holds, live in their own
 * dedicated tables, never here).
 */
export type LifecycleTableScope = "tenant" | "global";

/** Broad retention rationale bucket — used for readiness/compliance-mapping grouping, not itself a legal category (doc `data-lifecycle.md` §Pemetaan kepatuhan maps these practically, without asserting one universal legal retention period). */
export type LifecycleRetentionClass =
  | "audit_security"
  | "analytics_telemetry"
  | "operational_queue"
  | "financial_tax"
  | "communication_log"
  | "system_event";

/**
 * `"delegated"` — the owning module already has its own hand-rolled
 * purge/retention function and/or scheduled job (e.g.
 * `purgeExpiredAuditEvents`); `data_lifecycle`'s engine may read this
 * table for dry-run counts (read-only, safe) but NEVER mutates it —
 * real archive/purge stays owned by the existing mechanism, satisfying
 * "integrated or explicitly documented as compatible adopters rather
 * than duplicated" (issue #745 acceptance criteria) and the out-of-scope
 * guardrail "bypassing module ownership to purge another module's table
 * directly".
 * `"generic"` — the owning module has NO existing purge mechanism and
 * explicitly opts the table into `data_lifecycle`'s generic bounded
 * archive/purge execution (table name, tenant column, cursor column,
 * batch limit — all declared right here, by the owner, so this is never
 * an unsanctioned cross-module schema access).
 */
export type LifecycleExecutionMode = "delegated" | "generic";

export type LifecycleArchivePortKind =
  "local_offline" | "external_object_storage" | "none";

export type LifecycleArchiveFormat = "jsonl" | "csv";

export type LifecycleDeletionMode =
  "hard_delete" | "anonymize" | "status_transition_then_purge";

export type LifecyclePartitionPolicy = {
  eligible: boolean;
  granularity?: "daily" | "monthly" | "yearly";
  /** Required either way — "automate only where PostgreSQL safety can be proven" (issue #745 scope) means "not eligible" needs as much of a stated reason as "eligible". */
  rationale: string;
};

export type LifecycleArchivePolicy = {
  archivable: boolean;
  format?: LifecycleArchiveFormat;
  port?: LifecycleArchivePortKind;
  rationale: string;
};

export type LifecycleDeletionPolicy = {
  mode: LifecycleDeletionMode;
  rationale: string;
};

export type LifecycleLegalHoldPolicy = {
  /**
   * DOCUMENTATION/GUIDANCE ONLY — whether this class of data plausibly
   * warrants a legal hold at all, for an operator deciding whether to
   * bother creating one. Deliberately NOT consulted by the runtime
   * engine (`data-lifecycle/domain/legal-hold.ts`'s
   * `evaluateLegalHoldForDescriptor`) to decide whether an ACTUAL hold
   * record applies — a hold record (a human, permission-gated, audited
   * action) targeting this descriptor's `key`, or a tenant-wide hold
   * (`descriptorKey: null`), always applies regardless of what this flag
   * says. Letting `applicable: false` suppress enforcement would let an
   * owning module silently defeat legal hold coverage for its own table
   * by declaring it "not applicable" — exactly the bypass issue #745
   * forbids ("cannot be silently bypassed by tenant policy", which
   * applies with equal force to a module's own descriptor).
   */
  applicable: boolean;
  /**
   * A literal, not a free-choice enum value, when `applicable` is `true`
   * — "legal hold overrides ordinary retention/purge" (issue #745
   * critical requirement) can never be declared away per-descriptor by
   * an owning module picking a different precedence value. When
   * `applicable` is `false`, precedence is moot (`"not_applicable"`).
   */
  precedence: "overrides_retention" | "not_applicable";
};

export type LifecycleIndexRequirement = {
  columns: readonly string[];
  purpose: string;
};

/** Documents an EXISTING hand-rolled purge mechanism this descriptor adopts rather than duplicates — required when `executionMode: "delegated"`. */
export type LifecycleExistingAdopter = {
  jobCommand?: string;
  purgeFunctionRef: string;
  description: string;
};

export type HighVolumeTableDescriptor = {
  /** Stable, unique across the whole registry, e.g. `"logging.audit_events"`. */
  key: string;
  tableName: string;
  /** Must equal the declaring module's own `key` — validated by the registry gate, not by the type system (see `data-lifecycle/domain/lifecycle-registry.ts`). */
  ownerModuleKey: string;
  scope: LifecycleTableScope;
  cursorColumn: string;
  /** Defaults to `"tenant_id"` when `scope === "tenant"`. */
  tenantColumn?: string;
  retentionClass: LifecycleRetentionClass;
  retentionMinDays: number;
  retentionMaxDays: number;
  defaultRetentionDays: number;
  partition: LifecyclePartitionPolicy;
  archive: LifecycleArchivePolicy;
  deletion: LifecycleDeletionPolicy;
  legalHold: LifecycleLegalHoldPolicy;
  requiredIndexes: readonly LifecycleIndexRequirement[];
  batchLimit: number;
  backupRestoreNotes: string;
  executionMode: LifecycleExecutionMode;
  existingAdopter?: LifecycleExistingAdopter;
};

/** Compatibility metadata used by Issue #515's dependency-graph validation to report version incompatibility when present — absence means "no constraint declared", not "incompatible". */
export type ModuleCompatibilityContract = {
  minAppVersion?: string;
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
  /** High-volume table lifecycle descriptors this module owns (Issue #745) — see `HighVolumeTableDescriptor`'s own doc comment above. */
  dataLifecycle?: HighVolumeTableDescriptor[];
};

export function defineModule(descriptor: ModuleDescriptor): ModuleDescriptor {
  return descriptor;
}
