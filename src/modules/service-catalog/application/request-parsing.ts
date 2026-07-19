/**
 * Defensive parsing of untrusted JSON request bodies into the typed domain
 * inputs (Issue #870). Kept out of the route files so it is unit-testable and
 * so the PATCH-absence semantics (an omitted field is KEPT, a provided one
 * REPLACES — repo lesson `patch-default-in-parse-resets-omitted-fields`) live
 * in exactly one place. Parsing only shapes/coerces types; VALUE validity
 * (formats, bounds, known keys) is the domain layer's job
 * (`domain/plan.ts` + `domain/key-registry.ts`), run after this.
 */
import type {
  CreatePlanInput,
  FeatureGrantInput,
  PlanType,
  PriceInput,
  PriceInterval,
  PriceVisibility,
  QuotaInput,
  QuotaResetPolicy,
  VersionContentInput
} from "../domain/plan";
import type { UpdatePlanDraftInput } from "./plan-directory";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function asMetadata(value: unknown): Record<string, unknown> {
  return asRecord(value);
}

export function parseFeatureGrant(raw: unknown): FeatureGrantInput {
  const record = asRecord(raw);
  return {
    featureKind: record.featureKind === "module" ? "module" : "feature",
    featureKey: asString(record.featureKey),
    enabled: asBool(record.enabled, true),
    metadata: asMetadata(record.metadata)
  };
}

export function parseQuota(raw: unknown): QuotaInput {
  const record = asRecord(raw);
  return {
    meterKey: asString(record.meterKey),
    isUnlimited: asBool(record.isUnlimited, false),
    limitValue: asNumberOrNull(record.limitValue),
    unit: asString(record.unit),
    resetPolicy: asString(record.resetPolicy || "none") as QuotaResetPolicy,
    metadata: asMetadata(record.metadata)
  };
}

export function parsePrice(raw: unknown): PriceInput {
  const record = asRecord(raw);
  return {
    componentKey: asString(record.componentKey),
    amountMinor:
      typeof record.amountMinor === "number" ? record.amountMinor : NaN,
    currency: asString(record.currency),
    interval: asString(record.interval || "one_time") as PriceInterval,
    visibility: (record.visibility === "internal"
      ? "internal"
      : "public") as PriceVisibility,
    metadata: asMetadata(record.metadata)
  };
}

function parseArray<T>(value: unknown, mapper: (item: unknown) => T): T[] {
  return Array.isArray(value) ? value.map(mapper) : [];
}

/** Full version content (create) — every field materialized with a default so the domain validator sees a complete object. */
export function parseVersionContent(raw: unknown): VersionContentInput {
  const record = asRecord(raw);
  return {
    currency: asString(record.currency),
    market: asStringOrNull(record.market),
    trialEnabled: asBool(record.trialEnabled, false),
    trialDays: asNumberOrNull(record.trialDays),
    availableFrom: asStringOrNull(record.availableFrom),
    availableTo: asStringOrNull(record.availableTo),
    notes: asStringOrNull(record.notes),
    features: parseArray(record.features, parseFeatureGrant),
    quotas: parseArray(record.quotas, parseQuota),
    prices: parseArray(record.prices, parsePrice)
  };
}

export function parseCreatePlanBody(body: unknown): CreatePlanInput {
  const record = asRecord(body);
  return {
    planKey: asString(record.planKey),
    name: asString(record.name),
    description: asStringOrNull(record.description),
    planType: asString(record.planType || "subscription") as PlanType,
    content: parseVersionContent(record.content)
  };
}

/**
 * PATCH parse: a top-level or content field is included in the result ONLY
 * when the request actually provided it (`key in record`), so an omitted field
 * is kept by the application layer and never reset. Child collections
 * (features/quotas/prices) are included only when present, and then REPLACE.
 */
export function parseUpdateDraftBody(body: unknown): UpdatePlanDraftInput {
  const record = asRecord(body);
  const result: UpdatePlanDraftInput = {};

  if ("name" in record) {
    result.name = asString(record.name);
  }
  if ("description" in record) {
    result.description = asStringOrNull(record.description);
  }
  if ("planType" in record) {
    result.planType = asString(record.planType) as PlanType;
  }

  if ("content" in record) {
    const content = asRecord(record.content);
    const parsedContent: NonNullable<UpdatePlanDraftInput["content"]> = {};
    if ("currency" in content)
      parsedContent.currency = asString(content.currency);
    if ("market" in content)
      parsedContent.market = asStringOrNull(content.market);
    if ("trialEnabled" in content)
      parsedContent.trialEnabled = asBool(content.trialEnabled, false);
    if ("trialDays" in content)
      parsedContent.trialDays = asNumberOrNull(content.trialDays);
    if ("availableFrom" in content)
      parsedContent.availableFrom = asStringOrNull(content.availableFrom);
    if ("availableTo" in content)
      parsedContent.availableTo = asStringOrNull(content.availableTo);
    if ("notes" in content) parsedContent.notes = asStringOrNull(content.notes);
    if ("features" in content)
      parsedContent.features = parseArray(content.features, parseFeatureGrant);
    if ("quotas" in content)
      parsedContent.quotas = parseArray(content.quotas, parseQuota);
    if ("prices" in content)
      parsedContent.prices = parseArray(content.prices, parsePrice);
    result.content = parsedContent;
  }

  return result;
}
