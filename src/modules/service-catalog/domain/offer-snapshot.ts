/**
 * Build the immutable published-offer snapshot + its content hash (Issue
 * #870, epic #868, ADR-0022 §3). Pure. Called at publish time: the operator's
 * draft version content is frozen into a reproducible snapshot.
 *
 * Two outputs:
 *   - `offerHash` — a stable SHA-256 over the FULL published content (features,
 *     quotas, ALL prices incl. internal, availability). Same content -> same
 *     hash, so the published version is reproducible and the hash can seed the
 *     publish idempotency key.
 *   - the tenant-readable PROJECTION payload — features + quotas + the PUBLIC
 *     price subset only (internal prices never cross the tenant boundary,
 *     ADR-0022 §3 Medium-1).
 */
import { createHash } from "node:crypto";

import type {
  PublishedOfferFeature,
  PublishedOfferPrice,
  PublishedOfferQuota
} from "../../_shared/ports/service-catalog-read-port";
import type {
  FeatureGrantInput,
  PriceInput,
  QuotaInput,
  VersionContentInput
} from "./plan";

export type OfferSnapshot = {
  offerHash: string;
  features: PublishedOfferFeature[];
  quotas: PublishedOfferQuota[];
  /** PUBLIC prices only — internal-visibility prices are excluded from the tenant projection. */
  publicPrices: PublishedOfferPrice[];
};

/** The tenant-visible header the projection carries (beyond the version content). */
export type OfferHeader = {
  planKey: string;
  planName: string;
  planType: string;
  version: number;
};

/**
 * The complete set of tenant-visible fields the offer hash covers (Fix 1). This
 * IS the canonical hash-input key set (verified by a unit test against
 * `buildOfferHashInput`), and it must cover EVERY tenant-visible column of the
 * `awcms_mini_service_catalog_published_offers` projection — see
 * `PROJECTION_COLUMN_TO_HASH_FIELD`, cross-checked against the real table by an
 * integration test. So no tenant-visible change can ever leave the hash
 * unchanged.
 */
export const OFFER_HASH_FIELDS = [
  "planKey",
  "planName",
  "planType",
  "version",
  "currency",
  "market",
  "trialEnabled",
  "trialDays",
  "availableFrom",
  "availableTo",
  "features",
  "quotas",
  "prices"
] as const;

/**
 * Every column of the published-offer projection -> the hash field it feeds, or
 * `null` when it is deliberately EXCLUDED (identity/bookkeeping/metadata, not
 * tenant-visible offer CONTENT). An integration test asserts this map's keys
 * equal the real table's columns, so adding a projection column forces a
 * conscious decision here; and the non-null values equal `OFFER_HASH_FIELDS`.
 */
export const PROJECTION_COLUMN_TO_HASH_FIELD: Readonly<
  Record<string, string | null>
> = {
  plan_key: "planKey",
  plan_name: "planName",
  plan_type: "planType",
  version: "version",
  currency: "currency",
  market: "market",
  trial_enabled: "trialEnabled",
  trial_days: "trialDays",
  effective_from: "availableFrom",
  effective_to: "availableTo",
  features: "features",
  quotas: "quotas",
  prices: "prices",
  // Excluded — not tenant-visible OFFER CONTENT:
  id: null, // surrogate PK
  plan_version_id: null, // FK to the source version
  offer_hash: null, // the hash itself
  published_at: null, // server publish timestamp (would break reproducibility)
  published_by: null, // publish provenance
  retired_at: null, // retirement metadata (set post-publish)
  created_at: null // row insert timestamp
};

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, inner]) => [key, sortKeysDeep(inner)] as const)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    );
  }
  return value;
}

function toFeature(feature: FeatureGrantInput): PublishedOfferFeature {
  return {
    featureKind: feature.featureKind,
    featureKey: feature.featureKey,
    enabled: feature.enabled,
    metadata: feature.metadata
  };
}

function toQuota(quota: QuotaInput): PublishedOfferQuota {
  return {
    meterKey: quota.meterKey,
    isUnlimited: quota.isUnlimited,
    limitValue: quota.limitValue,
    unit: quota.unit,
    resetPolicy: quota.resetPolicy,
    metadata: quota.metadata
  };
}

function toPrice(price: PriceInput): PublishedOfferPrice {
  return {
    componentKey: price.componentKey,
    amountMinor: price.amountMinor,
    currency: price.currency,
    interval: price.interval,
    metadata: price.metadata
  };
}

function byKey<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/**
 * The exact object the offer hash is computed over — the single source of
 * truth for "what the hash covers". Its keys MUST equal `OFFER_HASH_FIELDS`
 * (unit-tested), and it covers EVERY tenant-visible projection column
 * (Fix 1): the header (planKey/planName/planType/version) AND the tenant-
 * visible content (currency, market, trial, availability, features, quotas,
 * PUBLIC prices).
 *
 * HIGH (B1): internal price amounts are NOT here — the hash is stored on the
 * projection AND returned to tenants, so hashing operator-only data would make
 * it a brute-force ORACLE. This also satisfies Codex-B (a public<->internal
 * flip changes `publicPrices` -> the hash; an internal-amount change while it
 * stays internal is not in the public set -> the hash and projection are
 * unchanged). The full operator record is reproducible from the frozen
 * authoring tables, so no separate operator-only fingerprint is needed.
 */
function buildOfferHashInput(
  header: OfferHeader,
  content: VersionContentInput,
  features: PublishedOfferFeature[],
  quotas: PublishedOfferQuota[],
  publicPrices: PublishedOfferPrice[]
): Record<string, unknown> {
  return {
    planKey: header.planKey,
    planName: header.planName,
    planType: header.planType,
    version: header.version,
    currency: content.currency,
    market: content.market,
    trialEnabled: content.trialEnabled,
    trialDays: content.trialDays,
    availableFrom: content.availableFrom,
    availableTo: content.availableTo,
    features,
    quotas,
    prices: publicPrices
  };
}

/** Exposed for the completeness test: the actual keys the hash covers for a sample input. */
export function offerHashInputKeys(): string[] {
  const empty: PublishedOfferFeature[] = [];
  return Object.keys(
    buildOfferHashInput(
      { planKey: "", planName: "", planType: "", version: 0 },
      {
        currency: "",
        market: null,
        trialEnabled: false,
        trialDays: null,
        availableFrom: null,
        availableTo: null,
        notes: null,
        features: [],
        quotas: [],
        prices: []
      },
      empty,
      [],
      []
    )
  );
}

export function buildOfferSnapshot(
  header: OfferHeader,
  content: VersionContentInput
): OfferSnapshot {
  const features = byKey(
    content.features.map(toFeature),
    (f) => `${f.featureKind}:${f.featureKey}`
  );
  const quotas = byKey(content.quotas.map(toQuota), (q) => q.meterKey);
  const publicPrices = byKey(
    content.prices
      .filter((price) => price.visibility === "public")
      .map(toPrice),
    (p) => p.componentKey
  );

  const canonical = JSON.stringify(
    sortKeysDeep(
      buildOfferHashInput(header, content, features, quotas, publicPrices)
    )
  );

  const offerHash = createHash("sha256").update(canonical).digest("hex");

  return { offerHash, features, quotas, publicPrices };
}
