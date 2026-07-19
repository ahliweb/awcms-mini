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

/**
 * FAIL-CLOSED boolean (Issue #870 review E1): an ABSENT field takes the
 * default; a PRESENT field is passed through VERBATIM (cast) so a non-boolean
 * value (`"false"`, `0`, `null`) is rejected by the domain validator's
 * `typeof === "boolean"` check — never coerced to `true`, which would publish a
 * feature the operator meant to leave OFF. Mirrors the visibility/featureKind
 * fail-closed pattern.
 */
function asBoolFailClosed(
  record: Record<string, unknown>,
  key: string,
  absentDefault: boolean
): boolean {
  return (key in record ? record[key] : absentDefault) as boolean;
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
    // FAIL-CLOSED (Issue #870 review Codex-A): a PRESENT-but-invalid
    // `featureKind` is passed through verbatim so `validateFeatureGrants`
    // rejects it (400), never silently coerced to "feature". Only a truly
    // absent field defaults.
    featureKind: ("featureKind" in record
      ? asString(record.featureKind)
      : "feature") as FeatureGrantInput["featureKind"],
    featureKey: asString(record.featureKey),
    enabled: asBoolFailClosed(record, "enabled", true),
    metadata: asMetadata(record.metadata)
  };
}

export function parseQuota(raw: unknown): QuotaInput {
  const record = asRecord(raw);
  return {
    meterKey: asString(record.meterKey),
    isUnlimited: asBoolFailClosed(record, "isUnlimited", false),
    limitValue: asNumberOrNull(record.limitValue),
    unit: asString(record.unit),
    // E2: present-key detection — a present-but-falsy ("") value is passed
    // through so the domain enum check rejects it, never coerced to "none".
    resetPolicy: ("resetPolicy" in record
      ? asString(record.resetPolicy)
      : "none") as QuotaResetPolicy,
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
    // E2: present-key detection — a present "" is rejected by the enum check.
    interval: ("interval" in record
      ? asString(record.interval)
      : "one_time") as PriceInterval,
    // FAIL-CLOSED (Issue #870 review Codex-A): a PRESENT-but-invalid
    // `visibility` (e.g. "internl") is passed through verbatim so
    // `validatePrices` rejects it (400) — NEVER coerced to "public", which
    // would silently leak an intended-internal price into the tenant-visible
    // published projection (ADR-0022 §3 Medium-1). Only a truly absent field
    // defaults to "public".
    visibility: ("visibility" in record
      ? asString(record.visibility)
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
    trialEnabled: asBoolFailClosed(record, "trialEnabled", false),
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
    // E2: present-key detection — a present "" is rejected by the enum check.
    planType: ("planType" in record
      ? asString(record.planType)
      : "subscription") as PlanType,
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
    // E1 fail-closed: present value passed through verbatim (validator rejects
    // a non-boolean), never coerced.
    if ("trialEnabled" in content)
      parsedContent.trialEnabled = content.trialEnabled as boolean;
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
