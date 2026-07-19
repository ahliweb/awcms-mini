/**
 * SINGLE SOURCE OF TRUTH for the SaaS commercial contract registry (Issue
 * #874, epic #868 SaaS control plane, ADR-0022). Pure code-registry
 * aggregation + validation over what every module declares in its OWN
 * `module.ts` (`ModuleDescriptor.serviceCatalog`, `_shared/module-contract.ts`
 * — the `Saas*Descriptor` families) — no I/O, no database, no network, safe to
 * run on every CI build, same shape `data-lifecycle/domain/lifecycle-registry.ts`
 * / `identity-access/domain/sod-rule-registry.ts` already use.
 *
 * ## Why this lives in `_shared/`, not in one module's `domain/`
 *
 * `service_catalog` (#870) and `tenant_entitlement` (#871) BOTH need to resolve
 * the same feature/meter/quota key sets. The module boundary (ADR-0022 §4,
 * `tests/unit/module-boundary.test.ts`) forbids one module importing another
 * module's `application`/`domain` code, so before #874 each of those two modules
 * kept its OWN private `resolve*KeyRegistry` aggregation (a drift-guard test in
 * #871 defended the duplication). #874 removes the duplication by putting the
 * ONE aggregator here in `_shared/` — the shared seam every module may import —
 * and having both modules' registries re-export it. `_shared/` is dependency-
 * free of any module, so this creates no boundary violation and no import cycle.
 *
 * ## Fail-closed (Issue #874 security requirement)
 *
 * - Runtime: `isKnownFeatureGrant`/`isKnownMeterKey`/`isKnownQuotaKey`/
 *   `isKnownCommercialEventType` return `false` for any key not present in the
 *   reviewed registry — an unknown key referenced by a plan/override is rejected
 *   at validate time, never accepted silently.
 * - Build: `validateSaasContractRegistry` rejects duplicate keys, unknown
 *   owners, unsafe units, unbounded/NaN/negative values, conflicting
 *   aggregation semantics, missing/invalid privacy classification, quota→meter
 *   dangling references, hard-enforced informational meters, event/AsyncAPI
 *   parity gaps, and the deprecated pre-#874 thin key fields. It is wired into
 *   `bun run check` via `scripts/saas-contract-registry-check.ts`. A conflicting
 *   descriptor can therefore never ship — the build fails before deploy.
 */
import type {
  ModuleDescriptor,
  SaasCommercialEventDescriptor,
  SaasFeatureDescriptor,
  SaasMeterAggregation,
  SaasMeterDescriptor,
  SaasMeterValueType,
  SaasQuotaDescriptor
} from "./module-contract";

/** Same syntactic key gate `service_catalog`/`tenant_entitlement` used before #874, and the DB CHECK constraints in sql/079/081 mirror. */
const KEY_FORMAT = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;
const UNIT_FORMAT = /^[a-z][a-z0-9_]*$/;
const EVENT_VERSION_FORMAT = /^[0-9]+\.[0-9]+$/;
/** Dotted, hyphen-allowed event address, e.g. `awcms-mini.service-catalog.offer.published` — matches the AsyncAPI channel address convention. */
const EVENT_TYPE_FORMAT = /^[a-z0-9]+([.-][a-z0-9]+)+$/;
const MAX_KEY_LENGTH = 120;
const MAX_UNIT_LENGTH = 40;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

export const SAAS_PRIVACY_CLASSIFICATIONS: readonly string[] = [
  "non_personal",
  "pseudonymous",
  "personal"
];
export const SAAS_METER_VALUE_TYPES: readonly string[] = [
  "count",
  "gauge",
  "amount_minor",
  "duration_seconds",
  "bytes"
];
export const SAAS_METER_AGGREGATIONS: readonly string[] = [
  "sum",
  "max",
  "last",
  "unique_count"
];
export const SAAS_METER_CORRECTIONS: readonly string[] = [
  "none",
  "signed_delta"
];
export const SAAS_METER_CLASSIFICATIONS: readonly string[] = [
  "billable",
  "informational"
];
export const SAAS_QUOTA_RESET_PERIODS: readonly string[] = [
  "none",
  "daily",
  "weekly",
  "monthly",
  "quarterly",
  "yearly",
  "billing_cycle"
];
export const SAAS_QUOTA_ENFORCEMENT_MODES: readonly string[] = [
  "hard",
  "soft",
  "advisory"
];
export const SAAS_COMMERCIAL_EVENT_KINDS: readonly string[] = [
  "lifecycle",
  "commercial"
];

/**
 * Which aggregation rules make sense for each value type — the "conflicting
 * aggregation semantics" gate (Issue #874). Summing a gauge, or taking the
 * `max` of a raw event count, is a modelling error the build must reject, not
 * a silent misconfiguration a billing run later trips over.
 */
export const AGGREGATION_COMPATIBILITY: Readonly<
  Record<SaasMeterValueType, readonly SaasMeterAggregation[]>
> = Object.freeze({
  count: ["sum", "unique_count"],
  gauge: ["max", "last"],
  amount_minor: ["sum"],
  duration_seconds: ["sum", "max"],
  bytes: ["sum", "max", "last"]
});

export function isValidSaasKeyFormat(key: unknown): key is string {
  return (
    typeof key === "string" &&
    key.length <= MAX_KEY_LENGTH &&
    KEY_FORMAT.test(key)
  );
}

export type SaasContractRegistry = {
  /** Valid whole-module entitlement keys — the live module registry's own keys. */
  moduleKeys: ReadonlySet<string>;
  featureKeys: ReadonlySet<string>;
  meterKeys: ReadonlySet<string>;
  quotaKeys: ReadonlySet<string>;
  commercialEventTypes: ReadonlySet<string>;
  features: ReadonlyMap<string, SaasFeatureDescriptor>;
  meters: ReadonlyMap<string, SaasMeterDescriptor>;
  quotas: ReadonlyMap<string, SaasQuotaDescriptor>;
  commercialEvents: ReadonlyMap<string, SaasCommercialEventDescriptor>;
};

/**
 * Build the merged registry from a descriptor list (always `listModules()` at
 * the application layer — passed in so this stays pure and unit-testable with
 * synthetic descriptors). Pure aggregation ONLY: it never throws and never
 * validates — validation is `validateSaasContractRegistry`'s job, enforced by
 * the build gate. First declaration of a key wins (deterministic, `listModules()`
 * order); duplicates are surfaced by the validator, not silently merged here.
 */
export function resolveSaasContractRegistry(
  descriptors: readonly ModuleDescriptor[]
): SaasContractRegistry {
  const moduleKeys = new Set<string>();
  const features = new Map<string, SaasFeatureDescriptor>();
  const meters = new Map<string, SaasMeterDescriptor>();
  const quotas = new Map<string, SaasQuotaDescriptor>();
  const commercialEvents = new Map<string, SaasCommercialEventDescriptor>();

  for (const descriptor of descriptors) {
    moduleKeys.add(descriptor.key);
    const contract = descriptor.serviceCatalog;
    if (!contract) {
      continue;
    }
    for (const feature of contract.features ?? []) {
      if (!features.has(feature.key)) {
        features.set(feature.key, feature);
      }
    }
    for (const meter of contract.meters ?? []) {
      if (!meters.has(meter.key)) {
        meters.set(meter.key, meter);
      }
    }
    for (const quota of contract.quotas ?? []) {
      if (!quotas.has(quota.key)) {
        quotas.set(quota.key, quota);
      }
    }
    for (const event of contract.commercialEvents ?? []) {
      if (!commercialEvents.has(event.eventType)) {
        commercialEvents.set(event.eventType, event);
      }
    }
  }

  return {
    moduleKeys,
    featureKeys: new Set(features.keys()),
    meterKeys: new Set(meters.keys()),
    quotaKeys: new Set(quotas.keys()),
    commercialEventTypes: new Set(commercialEvents.keys()),
    features,
    meters,
    quotas,
    commercialEvents
  };
}

/** Whether a feature grant's `(kind, key)` pair is known. `module` kind checks the module registry; `feature` kind checks the contributed feature keys. Fail-closed. */
export function isKnownFeatureGrant(
  registry: SaasContractRegistry,
  kind: "feature" | "module",
  key: string
): boolean {
  if (!isValidSaasKeyFormat(key)) {
    return false;
  }
  return kind === "module"
    ? registry.moduleKeys.has(key)
    : registry.featureKeys.has(key);
}

/** Whether a quota's meter key is a known, reviewed meter (fail-closed). */
export function isKnownMeterKey(
  registry: SaasContractRegistry,
  key: string
): boolean {
  return isValidSaasKeyFormat(key) && registry.meterKeys.has(key);
}

/** Whether a quota key is a known, reviewed quota dimension (fail-closed). */
export function isKnownQuotaKey(
  registry: SaasContractRegistry,
  key: string
): boolean {
  return isValidSaasKeyFormat(key) && registry.quotaKeys.has(key);
}

/** Whether a commercial-event identifier is a known, reviewed event (fail-closed). */
export function isKnownCommercialEventType(
  registry: SaasContractRegistry,
  eventType: string
): boolean {
  return registry.commercialEventTypes.has(eventType);
}

// ---------------------------------------------------------------------------
// Validation (the build gate).
// ---------------------------------------------------------------------------

export type SaasContractRegistryIssue = {
  /** The offending key/eventType (or `"(missing)"`), for grouping in diagnostics. */
  ref: string;
  message: string;
};

export function formatSaasContractRegistryIssue(
  issue: SaasContractRegistryIssue
): string {
  return `[${issue.ref}] ${issue.message}`;
}

export type SaasContractRegistryValidationResult = {
  valid: boolean;
  issues: SaasContractRegistryIssue[];
  featureCount: number;
  meterCount: number;
  quotaCount: number;
  commercialEventCount: number;
};

function checkKeyAndOwner(
  key: unknown,
  ownerModuleKey: unknown,
  ownerModule: ModuleDescriptor,
  push: (message: string) => void
): void {
  if (!isValidSaasKeyFormat(key)) {
    push(
      `key must be non-empty, <= ${MAX_KEY_LENGTH} chars, and match ${KEY_FORMAT} (got ${JSON.stringify(key)}).`
    );
  }
  if (ownerModuleKey !== ownerModule.key) {
    push(
      `ownerModuleKey (${JSON.stringify(ownerModuleKey)}) must equal the declaring module's own key (${JSON.stringify(ownerModule.key)}) — a module must not declare a descriptor it claims another module owns.`
    );
  }
}

function validateFeature(
  ownerModule: ModuleDescriptor,
  feature: SaasFeatureDescriptor,
  push: (message: string) => void
): void {
  checkKeyAndOwner(feature.key, feature.ownerModuleKey, ownerModule, push);
  if (!feature.description || typeof feature.description !== "string") {
    push("description is required.");
  }
}

function validateMeter(
  ownerModule: ModuleDescriptor,
  meter: SaasMeterDescriptor,
  push: (message: string) => void
): void {
  checkKeyAndOwner(meter.key, meter.ownerModuleKey, ownerModule, push);
  if (!meter.description || typeof meter.description !== "string") {
    push("description is required.");
  }
  if (
    typeof meter.eventVersion !== "string" ||
    !EVENT_VERSION_FORMAT.test(meter.eventVersion)
  ) {
    push(
      `eventVersion must be an "X.Y" string (got ${JSON.stringify(meter.eventVersion)}).`
    );
  }
  if (!SAAS_METER_VALUE_TYPES.includes(meter.valueType)) {
    push(
      `valueType ${JSON.stringify(meter.valueType)} is not one of ${SAAS_METER_VALUE_TYPES.join(", ")}.`
    );
  }
  if (!SAAS_METER_AGGREGATIONS.includes(meter.aggregation)) {
    push(
      `aggregation ${JSON.stringify(meter.aggregation)} is not one of ${SAAS_METER_AGGREGATIONS.join(", ")}.`
    );
  }
  if (!SAAS_METER_CORRECTIONS.includes(meter.correction)) {
    push(
      `correction ${JSON.stringify(meter.correction)} is not one of ${SAAS_METER_CORRECTIONS.join(", ")}.`
    );
  }
  if (!SAAS_METER_CLASSIFICATIONS.includes(meter.classification)) {
    push(
      `classification ${JSON.stringify(meter.classification)} is not one of ${SAAS_METER_CLASSIFICATIONS.join(", ")}.`
    );
  }
  // Privacy classification MUST be explicit + valid (Issue #874).
  if (!SAAS_PRIVACY_CLASSIFICATIONS.includes(meter.privacyClassification)) {
    push(
      `privacyClassification must be explicit and one of ${SAAS_PRIVACY_CLASSIFICATIONS.join(", ")} (got ${JSON.stringify(meter.privacyClassification)}).`
    );
  }
  // Conflicting aggregation semantics (only meaningful when both fields are valid enums).
  if (
    SAAS_METER_VALUE_TYPES.includes(meter.valueType) &&
    SAAS_METER_AGGREGATIONS.includes(meter.aggregation)
  ) {
    const allowed = AGGREGATION_COMPATIBILITY[meter.valueType];
    if (!allowed.includes(meter.aggregation)) {
      push(
        `aggregation ${JSON.stringify(meter.aggregation)} conflicts with valueType ${JSON.stringify(meter.valueType)} — allowed: ${allowed.join(", ")}.`
      );
    }
  }
  // Bounds: overflow/NaN/negative-abuse guard.
  const { bounds } = meter;
  if (!bounds || typeof bounds !== "object") {
    push("bounds is required (minValue/maxValue).");
  } else {
    const { minValue, maxValue } = bounds;
    if (!Number.isInteger(minValue)) {
      push(
        `bounds.minValue must be a finite integer (got ${JSON.stringify(minValue)}).`
      );
    }
    if (!Number.isInteger(maxValue)) {
      push(
        `bounds.maxValue must be a finite integer (got ${JSON.stringify(maxValue)}).`
      );
    }
    if (Number.isInteger(maxValue) && maxValue > MAX_SAFE) {
      push(
        `bounds.maxValue ${maxValue} exceeds Number.MAX_SAFE_INTEGER (${MAX_SAFE}) — overflow guard.`
      );
    }
    if (
      Number.isInteger(minValue) &&
      Number.isInteger(maxValue) &&
      minValue > maxValue
    ) {
      push(
        `bounds.minValue (${minValue}) must be <= bounds.maxValue (${maxValue}).`
      );
    }
    // Negative lower bound is ONLY allowed with explicit signed-delta correction.
    if (
      Number.isInteger(minValue) &&
      minValue < 0 &&
      meter.correction !== "signed_delta"
    ) {
      push(
        `bounds.minValue (${minValue}) may only be negative when correction is "signed_delta" (negative-value-abuse guard).`
      );
    }
  }
}

function validateQuota(
  ownerModule: ModuleDescriptor,
  quota: SaasQuotaDescriptor,
  meters: ReadonlyMap<string, SaasMeterDescriptor>,
  push: (message: string) => void
): void {
  checkKeyAndOwner(quota.key, quota.ownerModuleKey, ownerModule, push);
  if (!quota.description || typeof quota.description !== "string") {
    push("description is required.");
  }
  if (
    typeof quota.unit !== "string" ||
    quota.unit.length > MAX_UNIT_LENGTH ||
    !UNIT_FORMAT.test(quota.unit)
  ) {
    push(
      `unit must match ${UNIT_FORMAT} and be <= ${MAX_UNIT_LENGTH} chars (got ${JSON.stringify(quota.unit)}) — unsafe-unit guard.`
    );
  }
  if (!SAAS_QUOTA_RESET_PERIODS.includes(quota.resetPeriod)) {
    push(
      `resetPeriod ${JSON.stringify(quota.resetPeriod)} is not one of ${SAAS_QUOTA_RESET_PERIODS.join(", ")}.`
    );
  }
  if (!SAAS_QUOTA_ENFORCEMENT_MODES.includes(quota.enforcement)) {
    push(
      `enforcement ${JSON.stringify(quota.enforcement)} is not one of ${SAAS_QUOTA_ENFORCEMENT_MODES.join(", ")}.`
    );
  }
  // Quota→meter reference must resolve (fail-closed dangling reference).
  const meter = isValidSaasKeyFormat(quota.meterKey)
    ? meters.get(quota.meterKey)
    : undefined;
  if (!meter) {
    push(
      `meterKey ${JSON.stringify(quota.meterKey)} does not resolve to any known meter — a quota must limit a reviewed meter.`
    );
  } else if (
    quota.enforcement === "hard" &&
    meter.classification === "informational"
  ) {
    push(
      `enforcement "hard" conflicts with meter ${JSON.stringify(quota.meterKey)} classified "informational" — an informational meter cannot be hard-enforced.`
    );
  }
}

function validateCommercialEvent(
  ownerModule: ModuleDescriptor,
  event: SaasCommercialEventDescriptor,
  push: (message: string) => void
): void {
  if (
    typeof event.eventType !== "string" ||
    event.eventType.length > MAX_KEY_LENGTH ||
    !EVENT_TYPE_FORMAT.test(event.eventType)
  ) {
    push(
      `eventType must be a dotted address matching ${EVENT_TYPE_FORMAT} (got ${JSON.stringify(event.eventType)}).`
    );
  }
  if (event.ownerModuleKey !== ownerModule.key) {
    push(
      `ownerModuleKey (${JSON.stringify(event.ownerModuleKey)}) must equal the declaring module's own key (${JSON.stringify(ownerModule.key)}).`
    );
  }
  if (
    typeof event.eventVersion !== "string" ||
    !EVENT_VERSION_FORMAT.test(event.eventVersion)
  ) {
    push(
      `eventVersion must be an "X.Y" string (got ${JSON.stringify(event.eventVersion)}).`
    );
  }
  if (!SAAS_COMMERCIAL_EVENT_KINDS.includes(event.kind)) {
    push(
      `kind ${JSON.stringify(event.kind)} is not one of ${SAAS_COMMERCIAL_EVENT_KINDS.join(", ")}.`
    );
  }
  if (!event.description || typeof event.description !== "string") {
    push("description is required.");
  }
  // Event/AsyncAPI parity (pure half): the eventType must be listed in the
  // owning module's own `events.publishes`, which `scripts/api-spec-check.ts`
  // already ties to an AsyncAPI channel. Chaining through `publishes` keeps
  // this validator I/O-free; the check SCRIPT additionally verifies the
  // AsyncAPI file directly.
  if (
    typeof event.eventType === "string" &&
    !(ownerModule.events?.publishes ?? []).includes(event.eventType)
  ) {
    push(
      `eventType ${JSON.stringify(event.eventType)} is not listed in module ${JSON.stringify(ownerModule.key)}'s events.publishes — a commercial event must also be a declared, AsyncAPI-backed published event.`
    );
  }
}

/**
 * Validates the WHOLE merged registry — per-descriptor structural validity
 * plus cross-descriptor invariants (unique keys per namespace, feature/meter
 * key disjointness, deprecated thin-field rejection). Collects EVERY problem in
 * one pass (never stops at the first), same philosophy the other registry
 * validators document.
 */
export function validateSaasContractRegistry(
  modules: readonly ModuleDescriptor[]
): SaasContractRegistryValidationResult {
  const issues: SaasContractRegistryIssue[] = [];
  const moduleKeys = new Set(modules.map((m) => m.key));

  const featureCounts = new Map<string, number>();
  const meterCounts = new Map<string, number>();
  const quotaCounts = new Map<string, number>();
  const eventCounts = new Map<string, number>();

  let featureCount = 0;
  let meterCount = 0;
  let quotaCount = 0;
  let commercialEventCount = 0;

  // A meter map for quota→meter reference resolution — built up front over ALL
  // modules so a quota may legitimately reference a meter another module owns.
  const meterByKey = resolveSaasContractRegistry(modules).meters;

  for (const module of modules) {
    const contract = module.serviceCatalog;
    if (!contract) {
      continue;
    }

    // Deprecated pre-#874 thin fields — reject with an actionable migration
    // message (fail-closed, not silently ignored).
    if (contract.contributesFeatureKeys?.length) {
      issues.push({
        ref: module.key,
        message:
          "serviceCatalog.contributesFeatureKeys is deprecated (Issue #874) — migrate it to features[] (rich descriptors with descriptions)."
      });
    }
    if (contract.contributesMeterKeys?.length) {
      issues.push({
        ref: module.key,
        message:
          "serviceCatalog.contributesMeterKeys is deprecated (Issue #874) — migrate it to meters[] (rich descriptors with eventVersion/valueType/aggregation/privacyClassification/bounds)."
      });
    }

    for (const feature of contract.features ?? []) {
      featureCount += 1;
      const ref = feature.key || "(missing feature key)";
      validateFeature(module, feature, (message) =>
        issues.push({ ref, message })
      );
      featureCounts.set(feature.key, (featureCounts.get(feature.key) ?? 0) + 1);
    }
    for (const meter of contract.meters ?? []) {
      meterCount += 1;
      const ref = meter.key || "(missing meter key)";
      validateMeter(module, meter, (message) => issues.push({ ref, message }));
      meterCounts.set(meter.key, (meterCounts.get(meter.key) ?? 0) + 1);
    }
    for (const quota of contract.quotas ?? []) {
      quotaCount += 1;
      const ref = quota.key || "(missing quota key)";
      validateQuota(module, quota, meterByKey, (message) =>
        issues.push({ ref, message })
      );
      quotaCounts.set(quota.key, (quotaCounts.get(quota.key) ?? 0) + 1);
    }
    for (const event of contract.commercialEvents ?? []) {
      commercialEventCount += 1;
      const ref = event.eventType || "(missing eventType)";
      validateCommercialEvent(module, event, (message) =>
        issues.push({ ref, message })
      );
      eventCounts.set(
        event.eventType,
        (eventCounts.get(event.eventType) ?? 0) + 1
      );
    }

    // Owner sanity — a descriptor claiming ownership by a non-registered module
    // is impossible here (we iterate `modules`), but a quota/meter can name an
    // owner that is not itself in the registry only via the per-descriptor
    // ownerModuleKey check above; the module-key set is used below for the
    // cross-namespace feature/meter disjointness note only.
    void moduleKeys;
  }

  const reportDuplicates = (
    counts: Map<string, number>,
    namespace: string
  ): void => {
    for (const [key, count] of counts) {
      if (count > 1) {
        issues.push({
          ref: key,
          message: `${namespace} key is declared ${count} times — keys must be unique across the whole registry.`
        });
      }
    }
  };
  reportDuplicates(featureCounts, "feature");
  reportDuplicates(meterCounts, "meter");
  reportDuplicates(quotaCounts, "quota");
  reportDuplicates(eventCounts, "commercialEvent");

  // Feature and meter keys must be disjoint — `tenant_entitlement` maps an
  // override's `kind` (feature vs quota) to one of these namespaces, so a key
  // that is BOTH a feature and a meter would be ambiguous.
  for (const key of featureCounts.keys()) {
    if (meterCounts.has(key)) {
      issues.push({
        ref: key,
        message:
          "key is declared as both a feature and a meter — feature and meter key namespaces must be disjoint."
      });
    }
  }

  return {
    valid: issues.length === 0,
    issues,
    featureCount,
    meterCount,
    quotaCount,
    commercialEventCount
  };
}
