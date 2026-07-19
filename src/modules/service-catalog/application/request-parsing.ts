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

/**
 * FAIL-CLOSED tri-state nullable field (Issue #870 round 6, Fix 1) at CREATE.
 * ABSENT (`!(key in record)`) -> `null` (nullable default). PRESENT `null` ->
 * `null` (explicit clear). PRESENT any OTHER value -> kept VERBATIM (cast) so
 * the domain validator rejects a wrong type — NEVER coerced to `null`, which
 * the application layer reads as an explicit clear and would use to DELETE
 * existing data (silent loss). PATCH callers do the `key in` check themselves
 * (absent = keep) and pass the raw value through the same verbatim cast.
 */
function nullableAtCreate(
  record: Record<string, unknown>,
  key: string
): unknown {
  return key in record ? record[key] : null;
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

/**
 * FAIL-CLOSED metadata (Fix 2): an ABSENT metadata defaults to `{}`; a PRESENT
 * value is kept VERBATIM (cast) so the domain validator's `isPlainObject` check
 * rejects a non-object (array/scalar) instead of silently coercing it to `{}`.
 */
function asMetadata(value: unknown): Record<string, unknown> {
  return (value === undefined ? {} : value) as Record<string, unknown>;
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
    // Fix 1 tri-state nullable: absent -> null; present -> verbatim (the
    // isSafeNonNegativeInteger check rejects a non-number, never coerces).
    limitValue: nullableAtCreate(record, "limitValue") as number | null,
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

/**
 * FAIL-CLOSED collection (Fix 2): a PRESENT value is mapped when it is an array,
 * else passed through VERBATIM (cast) so the domain validator's `Array.isArray`
 * check rejects it (400) — NEVER coerced to `[]`, which in the PATCH path would
 * DELETE the existing rows (silent data loss). Callers use present-key
 * detection so an ABSENT collection defaults to `[]` (create) / is left unset
 * (PATCH = keep), and only a present value reaches here.
 */
function parseCollectionPresent<T>(
  value: unknown,
  mapper: (item: unknown) => T
): T[] {
  return Array.isArray(value) ? value.map(mapper) : (value as unknown as T[]);
}

/** Full version content (create) — every field materialized with a default so the domain validator sees a complete object. */
export function parseVersionContent(raw: unknown): VersionContentInput {
  const record = asRecord(raw);
  return {
    currency: asString(record.currency),
    // Fix 1 tri-state nullable: absent -> null; present -> verbatim (validator
    // rejects a wrong type; never coerced to null = silent clear).
    market: nullableAtCreate(record, "market") as string | null,
    trialEnabled: asBoolFailClosed(record, "trialEnabled", false),
    trialDays: nullableAtCreate(record, "trialDays") as number | null,
    availableFrom: nullableAtCreate(record, "availableFrom") as string | null,
    availableTo: nullableAtCreate(record, "availableTo") as string | null,
    notes: nullableAtCreate(record, "notes") as string | null,
    // present-key detection: absent -> [] (default); present -> fail-closed
    // collection parse (a present non-array is rejected downstream, not wiped).
    features:
      "features" in record
        ? parseCollectionPresent(record.features, parseFeatureGrant)
        : [],
    quotas:
      "quotas" in record
        ? parseCollectionPresent(record.quotas, parseQuota)
        : [],
    prices:
      "prices" in record
        ? parseCollectionPresent(record.prices, parsePrice)
        : []
  };
}

export function parseCreatePlanBody(body: unknown): CreatePlanInput {
  const record = asRecord(body);
  return {
    planKey: asString(record.planKey),
    name: asString(record.name),
    // Fix 1 tri-state nullable: absent -> null; present -> verbatim.
    description: nullableAtCreate(record, "description") as string | null,
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
  // Fix 1 tri-state nullable (PATCH): present -> verbatim; the outer `key in`
  // check keeps an ABSENT field; a present wrong-type is rejected by the
  // validator (NOT coerced to null = a silent clear/delete).
  if ("description" in record) {
    result.description = record.description as string | null;
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
      parsedContent.market = content.market as string | null;
    // E1 fail-closed: present value passed through verbatim (validator rejects
    // a non-boolean), never coerced.
    if ("trialEnabled" in content)
      parsedContent.trialEnabled = content.trialEnabled as boolean;
    if ("trialDays" in content)
      parsedContent.trialDays = content.trialDays as number | null;
    if ("availableFrom" in content)
      parsedContent.availableFrom = content.availableFrom as string | null;
    if ("availableTo" in content)
      parsedContent.availableTo = content.availableTo as string | null;
    if ("notes" in content)
      parsedContent.notes = content.notes as string | null;
    // Fix 2: a PRESENT collection is fail-closed — a non-array is passed
    // through (rejected 400 by the validator), NEVER coerced to [] (which would
    // DELETE the existing rows). Absent = keep (not set here).
    if ("features" in content)
      parsedContent.features = parseCollectionPresent(
        content.features,
        parseFeatureGrant
      );
    if ("quotas" in content)
      parsedContent.quotas = parseCollectionPresent(content.quotas, parseQuota);
    if ("prices" in content)
      parsedContent.prices = parseCollectionPresent(content.prices, parsePrice);
    result.content = parsedContent;
  }

  return result;
}
