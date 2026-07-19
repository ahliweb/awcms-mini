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

/**
 * Per-tenant availability for a module that has NO explicit
 * `awcms_mini_tenant_modules` row (Issue #870, epic #868 SaaS control plane,
 * ADR-0022 §7 / Medium-3). The historical, repo-wide default has always been
 * "a module with no explicit tenant state is available by default" — i.e.
 * `"enabled"`. ADR-0022 §7 makes the opt-in SaaS control-plane modules
 * (`service_catalog` and its six siblings) the deliberate exception: they
 * MUST be default-disabled per tenant so a LAN/offline deployment that never
 * activates the control plane keeps them fully inert (no reachable API/SSR
 * surface, no startup/network dependency), and a billing/entitlement module
 * silently active on a LAN box is treated as an attack surface, not cosmetics.
 *
 * This is the MECHANISM half of that requirement — read at every tenant-state
 * resolution point (`identity-access/application/auth-context.ts`'s
 * `resolveModuleEnabled` = the runtime API/SSR guard, plus the
 * `module_management` tenant-module matrix/lifecycle services). The GATE half
 * (a test that FAILS if any control-plane key resolves `enabled` without an
 * explicit row) lives in `tests/unit/module-governance-default-disabled.test.ts`.
 * Absent / `"enabled"` = the unchanged historical behavior for every other
 * module.
 */
export type ModuleDefaultTenantState = "enabled" | "disabled";

/**
 * Whether a module with NO explicit `awcms_mini_tenant_modules` row is
 * enabled for a tenant by default. Pure (no I/O), single-sourced, so every
 * resolution point stays consistent — see `ModuleDefaultTenantState`. Returns
 * `true` unless the descriptor opted into `defaultTenantState: "disabled"`.
 */
export function isModuleTenantEnabledByDefault(
  descriptor: Pick<ModuleDescriptor, "defaultTenantState"> | null | undefined
): boolean {
  return descriptor?.defaultTenantState !== "disabled";
}

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
  /**
   * Per-tenant default availability when no explicit
   * `awcms_mini_tenant_modules` row exists (Issue #870, ADR-0022 §7). Omitted
   * / `"enabled"` keeps the historical "available by default" behavior; the
   * opt-in SaaS control-plane modules set `"disabled"`. See
   * `ModuleDefaultTenantState` above.
   */
  defaultTenantState?: ModuleDefaultTenantState;
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
  /** Staged import/export exchange descriptors this module owns (Issue #752) — see `ExchangeDescriptor`'s own doc comment below. */
  dataExchange?: ExchangeDescriptor[];
  /** Reference-data value sets/codes this module contributes (Issue #750) — see `ReferenceDataModuleContract`'s own doc comment below. */
  referenceData?: ReferenceDataModuleContract;
  /** Read-model projection descriptors this module owns (Issue #753) — see `ProjectionDescriptor`'s own doc comment below (declared after this type since it's mutually referenced only by name, TypeScript type declarations are not order-sensitive). */
  reportingProjections?: ProjectionDescriptor[];
  /** Static feature/meter key contributions this module makes to the `service_catalog` allowed-key registry (Issue #870) — see `ServiceCatalogModuleContract`'s own doc comment below. */
  serviceCatalog?: ServiceCatalogModuleContract;
};

/**
 * ============================================================================
 * SaaS commercial contract descriptors (Issue #874, epic #868 SaaS control
 * plane, ADR-0022). The versioned, build-time contract every module uses to
 * declare the commercial capabilities it exposes — features, usage meters,
 * quota limits, and lifecycle/commercial domain events. This is the SINGLE
 * SOURCE OF TRUTH that `service_catalog` (#870), `tenant_entitlement` (#871),
 * and usage metering (#875) all resolve descriptors from — `src/modules/
 * _shared/saas-contract-registry.ts` is the one aggregator/validator, and
 * both `service-catalog/domain/key-registry.ts` and `tenant-entitlement/
 * domain/entitlement-key-registry.ts` re-export it rather than re-deriving
 * their own private key lists (the drift Issue #874 exists to pay down).
 *
 * All of these are TRUSTED CODE-ONLY METADATA (same rule as every descriptor
 * type above) — declared by the owning module's own `module.ts`, checked in
 * to the repo, never tenant/request-controlled, never a secret/executable
 * expression. There is NO runtime discovery, upload, or `eval` (doc 21 §7 /
 * ADR-0012 §7): the registry is the compile-time union of these arrays,
 * merged across base + application contributions through the same
 * deterministic `listModules()` composition seam every other descriptor
 * family uses. `SAAS_CONTRACT_VERSION` below versions this whole shape.
 * ============================================================================
 */

/**
 * How sensitive a meter's aggregate is with respect to a natural person —
 * REQUIRED, EXPLICIT on every meter (Issue #874: "privacy classification
 * must be explicit"). A meter descriptor carries only an aggregatable numeric
 * quantity (there is deliberately NO raw-payload field on `SaasMeterDescriptor`
 * — "descriptors cannot request raw sensitive payload storage by default"), so
 * this classifies the SENSITIVITY of that counted dimension, not a stored blob.
 */
export type SaasPrivacyClassification =
  | "non_personal" // pure operational counts with no personal linkage
  | "pseudonymous" // keyed by an opaque tenant/subject id, not directly identifying
  | "personal"; // relates to an identifiable person (UU PDP / ISO 27701 scope)

/** The kind of quantity a meter counts — governs which aggregation rules are compatible (`saas-contract-registry.ts`'s `AGGREGATION_COMPATIBILITY`). */
export type SaasMeterValueType =
  | "count" // non-negative integer events
  | "gauge" // a point-in-time level (active users, current storage)
  | "amount_minor" // exact minor currency units (never a float)
  | "duration_seconds"
  | "bytes";

/** How a meter's samples combine over an aggregation window. */
export type SaasMeterAggregation =
  | "sum" // add increments across the period
  | "max" // peak of a gauge across the period
  | "last" // latest gauge value
  | "unique_count"; // distinct count of a dimension

/**
 * Whether a meter accepts signed corrections. `"none"` — only non-negative
 * increments; the meter can never go negative (overflow/NaN/negative-abuse
 * guard). `"signed_delta"` — signed corrections are EXPLICITLY permitted (a
 * later reversal/adjustment can be negative), the only case `bounds.minValue`
 * may be below zero (Issue #874 security requirement).
 */
export type SaasMeterCorrectionSemantics = "none" | "signed_delta";

/** Whether a meter feeds billing or is dashboard/telemetry only (Issue #874 "billable versus informational classification"). */
export type SaasMeterClassification = "billable" | "informational";

/** When a quota's consumption window resets. */
export type SaasQuotaResetPeriod =
  | "none"
  | "daily"
  | "weekly"
  | "monthly"
  | "quarterly"
  | "yearly"
  | "billing_cycle";

/** How strictly a quota limit is applied. `"hard"` blocks at the limit; `"soft"` allows overage but records it; `"advisory"` never blocks (informational only). */
export type SaasQuotaEnforcementMode = "hard" | "soft" | "advisory";

/** Whether a commercial/domain event marks a lifecycle transition or a commercial (billing-relevant) fact. */
export type SaasCommercialEventKind = "lifecycle" | "commercial";

/** One feature this module exposes for plan feature grants and entitlement overrides. */
export type SaasFeatureDescriptor = {
  /** Globally unique across every module's feature contributions. Format `^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$`, <= 120 chars. */
  key: string;
  /** Must equal the declaring module's own `key` — validated by the registry gate (source ownership), not the type system. */
  ownerModuleKey: string;
  description: string;
};

/** Inclusive numeric bounds for a single meter sample — the overflow/NaN/negative-abuse guard (Issue #874). */
export type SaasMeterBounds = {
  /** Must be a finite integer. `>= 0` unless the meter's `correction` is `"signed_delta"`. */
  minValue: number;
  /** Must be a finite integer `<= Number.MAX_SAFE_INTEGER` (9007199254740991) — the overflow guard. */
  maxValue: number;
};

/** One usage meter this module exposes for quota limits and (in #875) usage events. */
export type SaasMeterDescriptor = {
  /** Globally unique across every module's meter contributions (and disjoint from feature keys). Same format as `SaasFeatureDescriptor.key`. */
  key: string;
  /** Must equal the declaring module's own `key` (source ownership). */
  ownerModuleKey: string;
  description: string;
  /** The usage-event schema version this meter emits, e.g. `"1.0"` — matches `domain-event-runtime`'s `"X.Y"` event-version style. */
  eventVersion: string;
  valueType: SaasMeterValueType;
  aggregation: SaasMeterAggregation;
  correction: SaasMeterCorrectionSemantics;
  classification: SaasMeterClassification;
  /** REQUIRED, EXPLICIT — see `SaasPrivacyClassification`. A missing/invalid value fails the build. */
  privacyClassification: SaasPrivacyClassification;
  bounds: SaasMeterBounds;
};

/** One quota limit dimension this module exposes for plan quotas and entitlement overrides — a limitable view over a meter. */
export type SaasQuotaDescriptor = {
  /** Globally unique across every module's quota contributions. Same format as `SaasFeatureDescriptor.key`. */
  key: string;
  /** Must equal the declaring module's own `key` (source ownership). */
  ownerModuleKey: string;
  description: string;
  /** The meter this quota limits — MUST resolve to a known `SaasMeterDescriptor.key` in the merged registry (fail-closed otherwise). */
  meterKey: string;
  /** Human unit label, e.g. `"call"`, `"byte"`, `"user"`. Format `^[a-z][a-z0-9_]*$`, <= 40 chars (matches the DB CHECK in sql/079). */
  unit: string;
  resetPeriod: SaasQuotaResetPeriod;
  enforcement: SaasQuotaEnforcementMode;
};

/**
 * One lifecycle/commercial domain event this module publishes, declared here
 * so `service_catalog`/usage/billing resolve a single source for commercial
 * event names. `eventType` MUST also appear in the owning module's own
 * `events.publishes` (which `scripts/api-spec-check.ts` already ties to an
 * AsyncAPI channel) — the registry gate enforces that parity so the AsyncAPI
 * and these descriptors can never drift.
 */
export type SaasCommercialEventDescriptor = {
  /** Dotted event address, e.g. `"awcms-mini.service-catalog.offer.published"`. Must match a channel in `asyncapi/awcms-mini-domain-events.asyncapi.yaml` and be listed in the owning module's `events.publishes`. */
  eventType: string;
  /** Event payload schema version, `"X.Y"`. */
  eventVersion: string;
  /** Must equal the declaring module's own `key` (source ownership). */
  ownerModuleKey: string;
  kind: SaasCommercialEventKind;
  description: string;
};

/**
 * A module's static contribution to the SaaS commercial contract registry
 * (Issue #870/#874, epic #868 SaaS control plane, ADR-0022). Same "module
 * declares its own plain-data descriptor, a central registry reads
 * `listModules()`" shape `referenceData`/`dataLifecycle`/`sodRules` above
 * already use — `src/modules/_shared/saas-contract-registry.ts` is the ONE
 * aggregator/validator (Issue #874), consumed by `service-catalog` (#870),
 * `tenant_entitlement` (#871), and usage metering (#875).
 *
 * WHY A STATIC DESCRIPTOR CONTRIBUTION. A plan's feature grants and usage
 * quotas reference `featureKey`/`meterKey` strings; those keys MUST resolve
 * through a reviewed, static registry, and an unknown key FAILS CLOSED
 * (rejected at draft-update/validate/publish time — Issue #870 security
 * requirement "unknown keys fail closed"), never accepted silently. The base
 * repo never hardcodes a business feature set; instead every module —
 * including a derived application's own modules contributed through
 * `application-registry.ts` (Issue #740) — declares the features/meters/
 * quotas/commercial-events it exposes right here, as rich plain data.
 *
 * NOTE: *module-entitlement* keys are NOT declared here — a plan may grant a
 * tenant access to a whole module, and the set of valid module keys is simply
 * `listModules()`'s own keys (derived from the registry, never a hand-kept
 * list — see memory `derive-publish-roots-from-registry`).
 */
export type ServiceCatalogModuleContract = {
  /**
   * @deprecated Superseded by `features` (Issue #874). Kept in the type only
   * so a derived repository written against the pre-#874 shape gets an
   * actionable build-gate diagnostic ("migrate contributesFeatureKeys to
   * features[]") from `saas-contracts:registry:check` instead of a raw
   * TypeScript compile error. The registry no longer reads this field; a
   * module that still declares it FAILS the gate.
   */
  contributesFeatureKeys?: readonly string[];
  /** @deprecated Superseded by `meters` (Issue #874) — same migration note as `contributesFeatureKeys`. */
  contributesMeterKeys?: readonly string[];
  /** Features this module exposes for plan feature grants (Issue #874). */
  features?: readonly SaasFeatureDescriptor[];
  /** Usage meters this module exposes (Issue #874). */
  meters?: readonly SaasMeterDescriptor[];
  /** Quota limit dimensions this module exposes, each backed by one of its `meters` (Issue #874). */
  quotas?: readonly SaasQuotaDescriptor[];
  /** Lifecycle/commercial domain-event identifiers this module publishes (Issue #874). */
  commercialEvents?: readonly SaasCommercialEventDescriptor[];
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
 * Staged import/export exchange descriptor (Issue #752, epic #738
 * platform-evolution Wave 3, ADR-0017). Same "module declares its own
 * descriptor, a central engine reads `listModules()`" shape `dataLifecycle`/
 * `sodRules` above already use — `data_exchange`'s `domain/exchange-
 * registry.ts` is the aggregator/validator, mirroring `data-lifecycle/
 * domain/lifecycle-registry.ts` exactly. A module contributes ONE of these
 * per import OR export contract it wants staged/committed through the
 * generic `data_exchange` engine — the base never hardcodes a domain-
 * specific schema itself (this repo's own `data_exchange` module ships
 * exactly one self-contained reference descriptor pair, `reference_items`,
 * to prove the mechanism end-to-end — see that module's README).
 *
 * TRUSTED CODE-ONLY METADATA (same rule as every descriptor type above) —
 * declared by the owning module's source, never tenant/request-controlled.
 * Deliberately carries NO function/adapter reference (a descriptor is pure
 * data, importable from any module.ts without creating a cross-module
 * source dependency) — `adapterRegistryKey` is a plain string the owning
 * module's REAL adapter implementation (a `DataExchangeAdapterPort`,
 * `_shared/ports/data-exchange-adapter-port.ts`) registers itself under, in
 * `data_exchange/infrastructure/exchange-adapter-registry.ts` (a static,
 * reviewed-source-code registry — same shape as `domain-event-runtime/
 * infrastructure/consumer-registry.ts`'s `DOMAIN_EVENT_CONSUMERS`).
 */
export type ExchangeDirection = "import" | "export" | "both";

export type ExchangeFormat = "csv" | "json";

/**
 * A descriptor's sensitive-value policy (Issue #752; hardened by Issue
 * #820). REQUIRED on every descriptor — declaring it is an affirmative act
 * by the owning module, never an omission the base silently interprets in
 * the caller's favour:
 *
 * - `fieldNames: []` means "this descriptor has deliberately reasoned about
 *   its fields and none of them are sensitive" — preview returns raw values.
 * - A non-empty `fieldNames` masks exactly those fields unless the caller
 *   holds THIS descriptor's own `rawValuePermission` (never a generic
 *   `data_exchange.*` permission — see `preview.ts`).
 * - A descriptor with NO policy at all (only reachable if it bypassed the
 *   registry gate in `data-exchange/domain/exchange-registry.ts`) is masked
 *   ENTIRELY at preview time, and no permission can unmask it. Default-deny:
 *   an undeclared field is an unknown field, and an unknown field is
 *   treated as sensitive.
 */
export type ExchangeSensitiveFieldPolicy = {
  /** Field names (as they appear in the parsed row, not a column name) that must never appear unmasked in a preview/error artifact without the caller holding the descriptor's `rawValuePermission`. Declare `[]` to state explicitly that no field is sensitive. */
  fieldNames: readonly string[];
  /** Permission key (module.activity.action format) required to view unmasked values for the fields above — required when `fieldNames` is non-empty, and the ONLY permission that unmasks them (Issue #820: previously this field was validated but never enforced, and the route hardcoded the far broader `data_exchange.preview_errors.read` instead). */
  rawValuePermission?: string;
  /** The parsed-row field name the owning module's adapter derives a staged row's `naturalKey` from (e.g. `"code"` for `reference_items`, but plausibly `"email"`/`"nik"` for a profile import — the dedup key IS commonly the sensitive identifier). When this name also appears in `fieldNames`, `naturalKey` is masked alongside `fields` (Issue #820 Cacat 4: masking previously ASSUMED `naturalKey` was non-sensitive). */
  naturalKeyField?: string;
};

export type ExchangeLimits = {
  /** Hard cap on the staged file's byte size — must not exceed the HTTP-layer tier this descriptor's intake endpoint uses (`src/lib/security/request-body-limit.ts`'s `large` tier, 5 MiB, as of this issue). */
  maxFileBytes: number;
  maxRowCount: number;
  maxFieldsPerRow: number;
};

export type ExchangeDescriptor = {
  /** Stable, unique across the whole registry, e.g. `"data_exchange.reference_items"`. */
  key: string;
  /** Must equal the declaring module's own `key` — validated by the registry gate, not the type system (see `data-exchange/domain/exchange-registry.ts`). */
  ownerModuleKey: string;
  direction: ExchangeDirection;
  formats: readonly ExchangeFormat[];
  /** Versioned schema identifier the owning module's adapter validates against — bumped by the owning module whenever its field shape changes (independent of `MODULE_CONTRACT_VERSION`). */
  schemaVersion: string;
  limits: ExchangeLimits;
  /** The `infrastructure/exchange-adapter-registry.ts` lookup key for this descriptor's REAL `DataExchangeAdapterPort` implementation — never a function reference (see this type's own header). */
  adapterRegistryKey: string;
  /** Permission key (module.activity.action) required to stage/preview/commit against this descriptor, beyond the generic `data_exchange.imports.*`/`data_exchange.exports.*` gate — e.g. an owning module may require its OWN write permission (`reference_data.items.create`) in addition. `undefined` means no additional permission beyond the generic gate. */
  requiredPermission?: string;
  /** REQUIRED (Issue #820) — declare `{ fieldNames: [] }` to state explicitly that no field is sensitive. Omitting it used to mean "return every staged value raw, with no permission check at all"; it is now rejected by the registry gate, and masked entirely at preview time if it somehow reaches the route. */
  sensitiveFields: ExchangeSensitiveFieldPolicy;
  description: string;
};

/**
 * One localized label/description for a `ReferenceCodeContribution` (Issue
 * #750, epic #738 platform-evolution Wave 3, ADR-0021). At least an `"en"`
 * entry is required — same "default en, min en+id" catalog convention
 * every UI string in this repo already follows (skill
 * `awcms-mini-i18n`), applied here to CONTENT rather than UI chrome.
 */
export type ReferenceCodeLabelContribution = {
  locale: string;
  label: string;
  description?: string;
};

/**
 * One code within a `ReferenceValueSetContribution` a module declares
 * statically in its own `module.ts` (Issue #750). Pure, trusted,
 * code-only data — same rule as every descriptor type in this file: never
 * tenant/request-controlled, never a secret/executable expression.
 * Aggregated + validated by `reference_data/domain/contribution-
 * registry.ts` and written to `awcms_mini_reference_codes` (`provenance:
 * "module"`, `managed_by_descriptor: true`) ONLY by `reference_data`'s own
 * `application/contribution-sync.ts` — the declaring module never writes
 * to that table itself (ADR-0013 §6 no-shared-table-write).
 */
export type ReferenceCodeContribution = {
  code: string;
  labels: ReferenceCodeLabelContribution[];
  sortOrder?: number;
  metadata?: Record<string, unknown>;
};

/**
 * One value set a module contributes statically (Issue #750). `key` must
 * be globally unique across every module's contributions (validated by
 * `contribution-registry.ts`, which also rejects a `key` colliding with an
 * existing `platform_curated` value set created via the API). The
 * declaring module IS the `owner_module` — never trusted from anywhere
 * else, always derived from the descriptor's own `key` at sync time.
 */
export type ReferenceValueSetContribution = {
  key: string;
  name: string;
  description: string;
  overridePolicy:
    "none" | "tenant_extend" | "tenant_override" | "tenant_extend_and_override";
  codes: ReferenceCodeContribution[];
};

/**
 * A module's declared reference-data contribution (Issue #750, epic #738
 * platform-evolution Wave 3, ADR-0021 §5) — the mechanism "module-
 * contributed catalogs compose without direct source import or direct
 * table writes" (issue #750 acceptance criterion) actually is: a module
 * declares its OWN value sets/codes as plain data here, and
 * `reference_data`'s own `application/contribution-sync.ts` (invoked
 * explicitly via `bun run reference-data:contributions:sync`, never
 * automatically from another module's code) reads `listModules()` and
 * upserts them into ITS OWN tables — the declaring module never imports
 * `reference_data`'s tables or application code, and `reference_data`
 * never imports the declaring module's code, only its own descriptor's
 * plain data (same "module declares its own descriptor, a central
 * aggregator reads `listModules()`" shape `dataLifecycle`/`sodRules`
 * above already use).
 */
export type ReferenceDataModuleContract = {
  contributesValueSets: ReferenceValueSetContribution[];
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
 *
 * `1.3.0` (Issue #870, epic #868 SaaS control plane) — added two optional
 * fields plus their helper/types: `ModuleDescriptor.defaultTenantState`
 * (with `ModuleDefaultTenantState` + `isModuleTenantEnabledByDefault`, the
 * default-disabled mechanism ADR-0022 §7 requires) and
 * `ModuleDescriptor.serviceCatalog` (with `ServiceCatalogModuleContract`,
 * the static feature/meter key contribution seam). MINOR: purely additive,
 * same rule as `1.2.0`'s own `reportingProjections` addition.
 *
 * `1.4.0` (Issue #874, epic #868 SaaS control plane) — enriched
 * `ServiceCatalogModuleContract` with the rich SaaS descriptor families
 * (`features`/`meters`/`quotas`/`commercialEvents` plus their descriptor
 * types) and the separate `SAAS_CONTRACT_VERSION` constant below. MINOR:
 * purely additive — the pre-#874 `contributesFeatureKeys`/
 * `contributesMeterKeys` fields are kept (now `@deprecated`, no longer read
 * by the registry) so an old derived `module.ts` still type-checks and gets
 * an actionable migration diagnostic from `saas-contracts:registry:check`
 * rather than a compile error. No field was removed or retyped.
 */
export const MODULE_CONTRACT_VERSION = "1.4.0";

/**
 * SemVer of the SaaS COMMERCIAL CONTRACT shape (Issue #874, epic #868) — the
 * feature/meter/quota/commercial-event descriptor families on
 * `ServiceCatalogModuleContract` plus their validation semantics
 * (`src/modules/_shared/saas-contract-registry.ts`). This is a SEVENTH
 * independent versioning scheme (see the list in `MODULE_CONTRACT_VERSION`'s
 * doc comment above + `EXTENSION_MANIFEST_SCHEMA_VERSION`): a derived
 * repository declares the SaaS contract version it was authored against in
 * its compatibility manifest (`extension.manifest.json`'s
 * `saasContractVersion`), and `bun run extension:check` fails with an
 * actionable diagnostic when the MAJOR differs or the derived repo assumes a
 * newer MINOR than this base actually ships — same rule ADR-0008 defines for
 * the REST/event contract, applied here.
 *
 * Bump policy (mirrors `MODULE_CONTRACT_VERSION`'s own rules):
 * - **MAJOR** — a descriptor field/enum value is removed or retyped, or a
 *   validation rule tightens in a way that could reject a previously-valid
 *   descriptor (a derived repo's existing descriptors could stop validating).
 * - **MINOR** — a new optional descriptor field or a new enum member is
 *   added, backward-compatible for existing descriptors.
 * - **PATCH** — documentation-only clarification.
 *
 * `1.0.0` is the first declaration of this shape (same "first assigned
 * number, not a stability milestone" framing `MODULE_CONTRACT_VERSION` uses).
 */
export const SAAS_CONTRACT_VERSION = "1.0.0";

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
