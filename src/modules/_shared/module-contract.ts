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
  /** High-volume table lifecycle descriptors this module owns (Issue #745) — see `HighVolumeTableDescriptor`'s own doc comment above. */
  dataLifecycle?: HighVolumeTableDescriptor[];
  /** Segregation-of-duties conflict rules this module owns (Issue #746) — see `SoDRuleDescriptor`'s own doc comment above. */
  sodRules?: SoDRuleDescriptor[];
  /** Read-model projection descriptors this module owns (Issue #753) — see `ProjectionDescriptor`'s own doc comment below (declared after this type since it's mutually referenced only by name, TypeScript type declarations are not order-sensitive). */
  reportingProjections?: ProjectionDescriptor[];
};

/**
 * Segregation-of-duties conflict rule descriptor (Issue #746, epic #738
 * platform-evolution Wave 2, ADR-0013 §4). Same "module declares its own
 * descriptor, a central engine reads `listModules()`" shape `permissions`/
 * `dataLifecycle` above already use — `identity_access`'s
 * `domain/sod-rule-registry.ts` is the aggregator/validator, mirroring
 * `data-lifecycle/domain/lifecycle-registry.ts` exactly. A module
 * contributes ONE of these per real SoD policy it wants enforced (maker/
 * checker, requester/approver, posting/period-control, ...) — the base
 * never hardcodes a domain-specific rule itself (issue #746 out-of-scope:
 * "Implementing domain-specific finance/procurement/payroll/approval rules
 * in the base"); every entry here is a GENERIC conflicting-permission-pair
 * declaration, never a business rule about what those permissions actually
 * do.
 *
 * TRUSTED CODE-ONLY METADATA (same rule as every descriptor type above) —
 * declared by the owning module's source, never tenant/request-controlled.
 */
export type SoDRuleScopeApplicability =
  "any" | "same_scope_only" | "global_within_tenant";

export type SoDRuleSeverity = "low" | "medium" | "high" | "critical";

export type SoDRuleExceptionPolicy = {
  allowed: boolean;
  /** Required when `allowed` is `true` — the permission key a different tenant user must hold to approve an exception to THIS rule (never the same permission the rule itself conflicts over). */
  requiresApprovalPermission?: string;
  /** Required only when `allowed` is `true` — an exception must always have a bounded lifetime (issue #746: "exceptions MUST have an end date — no indefinite override"); moot (must be absent) when `allowed` is `false`. */
  maxDurationDays?: number;
};

export type SoDRuleDescriptor = {
  /** Stable, unique across the whole registry, e.g. `"data_lifecycle.legal_hold_maker_checker"`. */
  ruleKey: string;
  /** Must equal the declaring module's own `key` — validated by the registry gate, not the type system (see `identity-access/domain/sod-rule-registry.ts`). */
  ownerModuleKey: string;
  description: string;
  /** At least 2 `module.activity.action` permission keys (the `permissionKey()` format, `identity-access/domain/access-control.ts`) that must never all be held/exercised by the same subject for the same scope (or anywhere in the tenant, per `scopeApplicability`) without an approved exception. */
  conflictingPermissionKeys: string[];
  /**
   * `"global_within_tenant"` — the conflict applies even without any shared
   * business scope (holding both permissions anywhere in the tenant is
   * itself the conflict). `"same_scope_only"` — the conflict only applies
   * when both permissions would apply to the SAME `scopeType`+`scopeId`.
   * `"any"` is reserved for a future rule kind that is scope-agnostic by
   * design (neither global nor scope-matched) — no rule in this repo uses
   * it yet.
   */
  scopeApplicability: SoDRuleScopeApplicability;
  severity: SoDRuleSeverity;
  exceptionPolicy: SoDRuleExceptionPolicy;
};

/**
 * Module-contributed read-model projection descriptor (Issue #753, epic
 * #738 `platform-evolution` Wave 3). Same "module declares its own array,
 * a central aggregator (`reporting/domain/projection-registry.ts`) reads
 * `listModules()`" shape `dataLifecycle`/`sodRules` above already use — a
 * module that wants a derived, incrementally-maintained read model instead
 * of repeated live aggregation contributes ONE of these per projection in
 * its OWN `module.ts`'s `reportingProjections` array. `reporting`'s engine
 * never writes another module's transactional tables (it reads via a
 * bounded cursor re-scan of a column the owning module already declared
 * here, or via a `domain_event_runtime` consumer it registers itself) and
 * only ever writes ITS OWN projection tables
 * (`awcms_mini_reporting_projection_*`).
 *
 * TRUSTED CODE-ONLY METADATA (same rule as every descriptor type above) —
 * declared by the owning module's source, never tenant/request-controlled.
 */
export type ProjectionScope = "tenant" | "global";

/** One event type/version this projection's steady-state updates consume via a `domain_event_runtime` consumer (Issue #742) — see `reporting`'s own `module.ts` for the registered example and `domain-event-runtime/infrastructure/consumer-registry.ts` for where the actual consumer entry lives (the cross-module wiring point). `eventVersion` is a STRING (e.g. `"1.0"`), matching `domain-event-runtime/domain/consumer-types.ts`'s own `DomainEventConsumerDefinition.eventVersions`/`DomainEventEnvelope.eventVersion` — never a number. */
export type ProjectionEventSource = {
  eventType: string;
  eventVersion: string;
};

/** One rule evaluated against a fetched batch row (Issue #753's incremental cursor engine, `reporting/application/projection-incremental-worker.ts`) — `matchColumn`/`matchValue` are optional (omit both to count every row in the batch); when present, both are required together. */
export type ProjectionCursorMetricRule = {
  metricKey: string;
  effect: "increment" | "decrement";
  matchColumn?: string;
  matchValue?: string;
};

/**
 * One bounded, cursor-ordered re-scan of a single source table — the ONLY
 * mechanism this system uses to either (a) poll-update a `cursor_table`
 * strategy projection's steady state, or (b) recompute ANY projection
 * (including a `domain_event` strategy one) from scratch during a rebuild.
 * `cursorColumn` must be a monotonically-increasing, insert-time-only
 * column (e.g. `created_at`) on an effectively append-only table/stream —
 * a column that can move backward on UPDATE (or a soft-delete-then-restore
 * table) is not safe here; see `reporting/README.md` §Projections for the
 * append-only-source rule this repo's own registered descriptors follow.
 */
export type ProjectionCursorStream = {
  /** Unique within the descriptor — keys this stream's own cursor row. */
  streamKey: string;
  /** Must start with `awcms_mini_` (same convention/validation `data_lifecycle`'s `HighVolumeTableDescriptor.tableName` already enforces). */
  tableName: string;
  /** Defaults to `"tenant_id"`. */
  tenantColumn?: string;
  cursorColumn: string;
  metrics: readonly ProjectionCursorMetricRule[];
};

export type ProjectionSourceContract =
  | { strategy: "cursor_table"; streams: readonly ProjectionCursorStream[] }
  | {
      strategy: "domain_event";
      events: readonly ProjectionEventSource[];
      /** Must match the `DomainEventConsumerDefinition.name` registered for this projection in `domain-event-runtime/infrastructure/consumer-registry.ts` — cross-checked at runtime by that registry's own tests, not by this repo's static registry validator (which has no visibility into the OTHER module's registry). */
      consumerName: string;
    };

export type ProjectionFreshnessPolicy = {
  /** Below this age since the last successful update, the projection reports `"current"`. */
  targetSeconds: number;
  /** At or above this age, the projection reports `"stale"` (between `targetSeconds` and this, it reports `"delayed"`). Must be `>= targetSeconds`. */
  staleAfterSeconds: number;
  /** Consecutive update failures at or above this count report `"failed"` regardless of age (Issue #753: "a projection-update job silently fail/skip a tenant must reflect stale/failed, never falsely fresh"). */
  errorAfterConsecutiveFailures: number;
};

export type ProjectionDescriptor = {
  /** Stable, unique across the whole registry, `"<ownerModuleKey>.<name>"`. */
  key: string;
  version: number;
  /** Must equal the declaring module's own `key` — validated by the registry gate, not the type system (see `reporting/domain/projection-registry.ts`). */
  ownerModuleKey: string;
  scope: ProjectionScope;
  description: string;
  /** How this projection's STEADY-STATE (ongoing, incremental) updates arrive. */
  source: ProjectionSourceContract;
  /** How a REBUILD recomputes this projection from scratch — ALWAYS a bounded cursor re-scan of the authoritative source table(s), even for a `domain_event`-strategy projection (rebuild reads the event outbox table directly rather than re-triggering delivery, so it never depends on `domain_event_runtime` replaying anything). See `reporting/application/projection-rebuild.ts`. */
  rebuildSource: { streams: readonly ProjectionCursorStream[] };
  /** `metricKey` (from `source`/`rebuildSource`'s own rules) -> human-readable label. */
  metricLabels: Readonly<Record<string, string>>;
  /** `module.activity.action` permission key (`identity-access/domain/access-control.ts`'s `permissionKey()` format) required to READ this projection's snapshot/freshness/reconciliation. Rebuild/export use their own separate permissions (not declared here — see `reporting`'s own permission catalog). */
  requiredPermission: string;
  freshness: ProjectionFreshnessPolicy;
  /** API path a client can follow to see the live, fully-reauthorized source view this projection summarizes — MUST be an endpoint that independently re-checks RBAC/ABAC at request time (every existing `/api/v1/reports/*` route already does), never a shortcut that trusts the projection's own permission check. */
  drillDownPath?: string;
  /** Free-text reference to a `data_lifecycle` `HighVolumeTableDescriptor.key` if this projection's own tables are (or should become) separately registered there, or a short rationale if not — documentation only, `reporting`'s projection tables are not auto-enrolled. */
  retentionClass: string;
  /** Bounded per-pass row limit for both incremental and rebuild cursor scans — same purpose as `HighVolumeTableDescriptor.batchLimit`. */
  batchLimit: number;
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
 *
 * `1.2.0` (Issue #753) — added the optional `ModuleDescriptor.
 * reportingProjections` field plus the new `ProjectionDescriptor` family
 * of exported types (MINOR: purely additive, same rule as `1.1.0`'s own
 * `dataLifecycle`/`sodRules` additions).
 */
export const MODULE_CONTRACT_VERSION = "1.2.0";

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
