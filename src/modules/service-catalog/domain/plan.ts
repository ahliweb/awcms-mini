/**
 * `service_catalog` domain types + validation (Issue #870, epic #868 SaaS
 * control plane, ADR-0022). Pure — no I/O. Validation returns a list of
 * `{ field, message }` errors (empty = valid), the same discriminated-error
 * convention `reference-data/domain/value-set.ts` uses; the application layer
 * turns a non-empty list into a `400 VALIDATION_ERROR`.
 *
 * Money is EXACT minor units: `amountMinor` MUST be a safe non-negative
 * INTEGER — a fractional/float amount is a validation error, never silently
 * rounded (AC "no floating-point amount storage"). Feature/meter keys are
 * checked against the static registry (`key-registry.ts`) here, so an unknown
 * key FAILS CLOSED at draft-edit/validate/publish time.
 */
import {
  isKnownFeatureGrant,
  isKnownMeterKey,
  isValidServiceCatalogKeyFormat,
  type ServiceCatalogFeatureKind,
  type ServiceCatalogKeyRegistry
} from "./key-registry";

export type PlanType = "subscription" | "addon" | "bundle" | "custom";
export type PlanStatus = "active" | "archived";
export type OfferVersionStatus = "draft" | "published" | "retired" | "archived";
export type PriceInterval =
  | "one_time"
  | "daily"
  | "weekly"
  | "monthly"
  | "quarterly"
  | "yearly"
  | "usage";
export type PriceVisibility = "public" | "internal";
export type QuotaResetPolicy =
  | "none"
  | "daily"
  | "weekly"
  | "monthly"
  | "quarterly"
  | "yearly"
  | "billing_cycle";

export const PLAN_TYPES: readonly PlanType[] = [
  "subscription",
  "addon",
  "bundle",
  "custom"
];
export const PRICE_INTERVALS: readonly PriceInterval[] = [
  "one_time",
  "daily",
  "weekly",
  "monthly",
  "quarterly",
  "yearly",
  "usage"
];
export const PRICE_VISIBILITIES: readonly PriceVisibility[] = [
  "public",
  "internal"
];
export const QUOTA_RESET_POLICIES: readonly QuotaResetPolicy[] = [
  "none",
  "daily",
  "weekly",
  "monthly",
  "quarterly",
  "yearly",
  "billing_cycle"
];

export type PlanValidationError = { field: string; message: string };

export type FeatureGrantInput = {
  featureKind: ServiceCatalogFeatureKind;
  featureKey: string;
  enabled: boolean;
  metadata: Record<string, unknown>;
};

export type QuotaInput = {
  meterKey: string;
  isUnlimited: boolean;
  limitValue: number | null;
  unit: string;
  resetPolicy: QuotaResetPolicy;
  metadata: Record<string, unknown>;
};

export type PriceInput = {
  componentKey: string;
  amountMinor: number;
  currency: string;
  interval: PriceInterval;
  visibility: PriceVisibility;
  metadata: Record<string, unknown>;
};

/** The full commercial content of a draft version (currency + optional collections). */
export type VersionContentInput = {
  currency: string;
  market: string | null;
  trialEnabled: boolean;
  trialDays: number | null;
  availableFrom: string | null;
  availableTo: string | null;
  notes: string | null;
  features: FeatureGrantInput[];
  quotas: QuotaInput[];
  prices: PriceInput[];
};

export type CreatePlanInput = {
  planKey: string;
  name: string;
  description: string | null;
  planType: PlanType;
  content: VersionContentInput;
};

const CURRENCY_FORMAT = /^[A-Z]{3}$/;
const PLAN_KEY_FORMAT = /^[a-z][a-z0-9_]*$/;
const MARKET_FORMAT = /^[A-Za-z0-9][A-Za-z0-9_\-]{0,31}$/;
const UNIT_FORMAT = /^[a-z][a-z0-9_]*$/;
const COMPONENT_KEY_FORMAT = /^[a-z][a-z0-9_]*$/;
const MAX_METADATA_BYTES = 4000;

function isSafeNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}

function isPlainObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Fix 2: a PRESENT-but-non-object metadata is rejected, never coerced to `{}`; also bounds size. */
function metadataError(metadata: unknown): string | null {
  if (!isPlainObject(metadata)) {
    return "metadata must be an object.";
  }
  if (JSON.stringify(metadata).length > MAX_METADATA_BYTES) {
    return "metadata is too large.";
  }
  return null;
}

/** A valid timestamp is a STRING that `Date.parse` accepts — the typeof guard (Fix 1) stops a non-string (e.g. a number) coercing through `Date.parse`. */
function isValidTimestamp(value: unknown): boolean {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/** Validate the shared version content (currency, availability, and each feature/quota/price). Used by both create and draft update, and (re-run) at publish. */
export function validateVersionContent(
  content: VersionContentInput,
  registry: ServiceCatalogKeyRegistry
): PlanValidationError[] {
  const errors: PlanValidationError[] = [];

  if (!CURRENCY_FORMAT.test(content.currency)) {
    errors.push({
      field: "currency",
      message: "currency must be a 3-letter ISO-4217 code (e.g. IDR, USD)."
    });
  }

  if (
    content.market !== null &&
    (typeof content.market !== "string" || !MARKET_FORMAT.test(content.market))
  ) {
    errors.push({
      field: "market",
      // Fix 1: a present non-string (or null-clear) is distinct — a non-string
      // present value is rejected, never treated as a valid clear.
      message: "market must be a short alphanumeric string or null."
    });
  }

  if (
    content.trialDays !== null &&
    !(isSafeNonNegativeInteger(content.trialDays) && content.trialDays <= 3650)
  ) {
    errors.push({
      field: "trialDays",
      message: "trialDays must be an integer between 0 and 3650."
    });
  }

  if (
    content.availableFrom !== null &&
    !isValidTimestamp(content.availableFrom)
  ) {
    errors.push({
      field: "availableFrom",
      message: "availableFrom must be an ISO-8601 timestamp string or null."
    });
  }
  if (content.availableTo !== null && !isValidTimestamp(content.availableTo)) {
    errors.push({
      field: "availableTo",
      message: "availableTo must be an ISO-8601 timestamp string or null."
    });
  }
  if (
    content.availableFrom !== null &&
    content.availableTo !== null &&
    isValidTimestamp(content.availableFrom) &&
    isValidTimestamp(content.availableTo) &&
    Date.parse(content.availableTo) <= Date.parse(content.availableFrom)
  ) {
    errors.push({
      field: "availableTo",
      message: "availableTo must be after availableFrom."
    });
  }

  if (
    content.notes !== null &&
    (typeof content.notes !== "string" || content.notes.length > 2000)
  ) {
    errors.push({
      field: "notes",
      message: "notes must be a string (<= 2000 characters) or null."
    });
  }

  if (typeof content.trialEnabled !== "boolean") {
    errors.push({
      field: "trialEnabled",
      message: "trialEnabled must be a boolean (E1)."
    });
  }

  // Fix 2: a PRESENT-but-non-array collection is rejected (400), NEVER iterated
  // (which would throw) and NEVER treated as an empty replacement (which in the
  // PATCH path would DELETE the existing rows). Each collection is guarded
  // before its item validator runs.
  if (!Array.isArray(content.features)) {
    errors.push({ field: "features", message: "features must be an array." });
  } else {
    validateFeatureGrants(content.features, registry, errors);
  }
  if (!Array.isArray(content.quotas)) {
    errors.push({ field: "quotas", message: "quotas must be an array." });
  } else {
    validateQuotas(content.quotas, registry, errors);
  }
  if (!Array.isArray(content.prices)) {
    errors.push({ field: "prices", message: "prices must be an array." });
  } else {
    validatePrices(content.prices, content.currency, errors);
  }

  return errors;
}

function validateFeatureGrants(
  features: readonly FeatureGrantInput[],
  registry: ServiceCatalogKeyRegistry,
  errors: PlanValidationError[]
): void {
  const seen = new Set<string>();
  features.forEach((feature, index) => {
    const at = `features[${index}]`;
    if (feature.featureKind !== "feature" && feature.featureKind !== "module") {
      errors.push({
        field: `${at}.featureKind`,
        message: "featureKind must be 'feature' or 'module'."
      });
      return;
    }
    if (!isValidServiceCatalogKeyFormat(feature.featureKey)) {
      errors.push({
        field: `${at}.featureKey`,
        message: "featureKey has an invalid format."
      });
      return;
    }
    // FAIL CLOSED — an unknown feature/module key is rejected, never accepted.
    if (
      !isKnownFeatureGrant(registry, feature.featureKind, feature.featureKey)
    ) {
      errors.push({
        field: `${at}.featureKey`,
        message: `Unknown ${feature.featureKind} key "${feature.featureKey}" — it must be declared in a reviewed static registry.`
      });
    }
    const dedupeKey = `${feature.featureKind}:${feature.featureKey}`;
    if (seen.has(dedupeKey)) {
      errors.push({
        field: `${at}.featureKey`,
        message: `Duplicate ${feature.featureKind} key "${feature.featureKey}".`
      });
    }
    seen.add(dedupeKey);
    if (typeof feature.enabled !== "boolean") {
      errors.push({
        field: `${at}.enabled`,
        message:
          "enabled must be a boolean (E1: a present-but-invalid value is rejected, never coerced to true)."
      });
    }
    const featureMetaErr = metadataError(feature.metadata);
    if (featureMetaErr) {
      errors.push({ field: `${at}.metadata`, message: featureMetaErr });
    }
  });
}

function validateQuotas(
  quotas: readonly QuotaInput[],
  registry: ServiceCatalogKeyRegistry,
  errors: PlanValidationError[]
): void {
  const seen = new Set<string>();
  quotas.forEach((quota, index) => {
    const at = `quotas[${index}]`;
    if (!isValidServiceCatalogKeyFormat(quota.meterKey)) {
      errors.push({
        field: `${at}.meterKey`,
        message: "meterKey has an invalid format."
      });
    } else if (!isKnownMeterKey(registry, quota.meterKey)) {
      // FAIL CLOSED — an unknown meter key is rejected.
      errors.push({
        field: `${at}.meterKey`,
        message: `Unknown meter key "${quota.meterKey}" — it must be declared in a reviewed static registry.`
      });
    }
    if (seen.has(quota.meterKey)) {
      errors.push({
        field: `${at}.meterKey`,
        message: `Duplicate meter key "${quota.meterKey}".`
      });
    }
    seen.add(quota.meterKey);

    if (typeof quota.isUnlimited !== "boolean") {
      // E1: a present-but-invalid isUnlimited is rejected, never coerced. Use
      // strict `=== true` below so a truthy non-boolean can't sneak into the
      // "unlimited" branch.
      errors.push({
        field: `${at}.isUnlimited`,
        message: "isUnlimited must be a boolean (E1)."
      });
    }

    if (quota.isUnlimited === true) {
      if (quota.limitValue !== null) {
        errors.push({
          field: `${at}.limitValue`,
          message: "limitValue must be null when isUnlimited is true."
        });
      }
    } else if (!isSafeNonNegativeInteger(quota.limitValue)) {
      errors.push({
        field: `${at}.limitValue`,
        message:
          "limitValue must be a non-negative integer when isUnlimited is false."
      });
    }

    if (!UNIT_FORMAT.test(quota.unit) || quota.unit.length > 40) {
      errors.push({
        field: `${at}.unit`,
        message: "unit has an invalid format."
      });
    }
    if (!QUOTA_RESET_POLICIES.includes(quota.resetPolicy)) {
      errors.push({
        field: `${at}.resetPolicy`,
        message: "resetPolicy is invalid."
      });
    }
    const quotaMetaErr = metadataError(quota.metadata);
    if (quotaMetaErr) {
      errors.push({ field: `${at}.metadata`, message: quotaMetaErr });
    }
  });
}

function validatePrices(
  prices: readonly PriceInput[],
  versionCurrency: string,
  errors: PlanValidationError[]
): void {
  const seen = new Set<string>();
  prices.forEach((price, index) => {
    const at = `prices[${index}]`;
    if (
      !COMPONENT_KEY_FORMAT.test(price.componentKey) ||
      price.componentKey.length > 60
    ) {
      errors.push({
        field: `${at}.componentKey`,
        message: "componentKey has an invalid format."
      });
    }
    if (seen.has(price.componentKey)) {
      errors.push({
        field: `${at}.componentKey`,
        message: `Duplicate price component "${price.componentKey}".`
      });
    }
    seen.add(price.componentKey);

    if (!isSafeNonNegativeInteger(price.amountMinor)) {
      errors.push({
        field: `${at}.amountMinor`,
        message:
          "amountMinor must be a non-negative integer (exact minor currency units, never a float)."
      });
    }
    if (!CURRENCY_FORMAT.test(price.currency)) {
      errors.push({
        field: `${at}.currency`,
        message: "currency must be a 3-letter ISO-4217 code."
      });
    } else if (
      CURRENCY_FORMAT.test(versionCurrency) &&
      price.currency !== versionCurrency
    ) {
      errors.push({
        field: `${at}.currency`,
        message: `price currency "${price.currency}" must match the version currency "${versionCurrency}".`
      });
    }
    if (!PRICE_INTERVALS.includes(price.interval)) {
      errors.push({ field: `${at}.interval`, message: "interval is invalid." });
    }
    if (!PRICE_VISIBILITIES.includes(price.visibility)) {
      errors.push({
        field: `${at}.visibility`,
        message: "visibility must be 'public' or 'internal'."
      });
    }
    const priceMetaErr = metadataError(price.metadata);
    if (priceMetaErr) {
      errors.push({ field: `${at}.metadata`, message: priceMetaErr });
    }
  });
}

/** Validate a plan header (create). */
export function validatePlanHeader(
  planKey: string,
  name: string,
  description: string | null,
  planType: PlanType
): PlanValidationError[] {
  const errors: PlanValidationError[] = [];
  if (!PLAN_KEY_FORMAT.test(planKey) || planKey.length > 100) {
    errors.push({
      field: "planKey",
      message:
        "planKey must be lower_snake_case starting with a letter (<= 100 chars)."
    });
  }
  if (name.length < 1 || name.length > 200) {
    errors.push({ field: "name", message: "name must be 1-200 characters." });
  }
  if (
    description !== null &&
    (typeof description !== "string" || description.length > 2000)
  ) {
    errors.push({
      field: "description",
      // Fix 1: a present non-string is rejected, not treated as a valid clear.
      message: "description must be a string (<= 2000 characters) or null."
    });
  }
  if (!PLAN_TYPES.includes(planType)) {
    errors.push({ field: "planType", message: "planType is invalid." });
  }
  return errors;
}
