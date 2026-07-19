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

export function buildOfferSnapshot(
  planKey: string,
  version: number,
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

  // Hash over ALL prices (public + internal) INCLUDING visibility (Issue #870
  // review Codex-B): two versions identical except a price's visibility
  // (internal <-> public) produce DIFFERENT tenant-visible offers, so they must
  // NOT share an offer hash — `toPrice` deliberately drops `visibility` (it is
  // the tenant projection shape), so the hash uses a distinct representation
  // that keeps it.
  const pricesForHash = byKey(
    content.prices.map((price) => ({
      componentKey: price.componentKey,
      amountMinor: price.amountMinor,
      currency: price.currency,
      interval: price.interval,
      visibility: price.visibility,
      metadata: price.metadata
    })),
    (p) => p.componentKey
  );

  const canonical = JSON.stringify(
    sortKeysDeep({
      planKey,
      version,
      currency: content.currency,
      market: content.market,
      trialEnabled: content.trialEnabled,
      trialDays: content.trialDays,
      availableFrom: content.availableFrom,
      availableTo: content.availableTo,
      features,
      quotas,
      prices: pricesForHash
    })
  );

  const offerHash = createHash("sha256").update(canonical).digest("hex");

  return { offerHash, features, quotas, publicPrices };
}
