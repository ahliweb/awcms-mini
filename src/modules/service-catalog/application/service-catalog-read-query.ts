/**
 * Reads of the tenant-readable PUBLISHED PROJECTION
 * (`awcms_mini_service_catalog_published_offers`) — the ONLY catalog surface a
 * tenant-plane consumer ever sees (Issue #870, ADR-0022 §2/§3). This query
 * layer NEVER touches the operator authoring tables, so it structurally cannot
 * return a draft/retired-working row or an internal price. It backs the
 * `service_catalog_read` capability adapter.
 */
import type {
  ListPublishedOffersOptions,
  PublishedOffer,
  PublishedOfferFeature,
  PublishedOfferPrice,
  PublishedOfferQuota
} from "../../_shared/ports/service-catalog-read-port";

type PublishedOfferDbRow = {
  plan_key: string;
  plan_name: string;
  plan_type: string;
  version: number | string;
  currency: string;
  market: string | null;
  trial_enabled: boolean;
  trial_days: number | string | null;
  effective_from: Date | null;
  effective_to: Date | null;
  features: PublishedOfferFeature[];
  quotas: PublishedOfferQuota[];
  prices: PublishedOfferPrice[];
  offer_hash: string;
  published_at: Date;
  retired_at: Date | null;
};

function toOffer(row: PublishedOfferDbRow): PublishedOffer {
  return {
    planKey: row.plan_key,
    planName: row.plan_name,
    planType: row.plan_type,
    version: Number(row.version),
    currency: row.currency,
    market: row.market,
    trialEnabled: row.trial_enabled,
    trialDays: row.trial_days === null ? null : Number(row.trial_days),
    effectiveFrom: row.effective_from?.toISOString() ?? null,
    effectiveTo: row.effective_to?.toISOString() ?? null,
    features: row.features,
    quotas: row.quotas,
    prices: row.prices,
    offerHash: row.offer_hash,
    publishedAt: row.published_at.toISOString(),
    retiredAt: row.retired_at?.toISOString() ?? null
  };
}

/** Bounded list (`LIMIT 500`), newest version first. */
export async function listPublishedOffers(
  tx: Bun.SQL,
  options: ListPublishedOffersOptions = {}
): Promise<PublishedOffer[]> {
  const rows = (await tx`
    SELECT plan_key, plan_name, plan_type, version, currency, market, trial_enabled, trial_days,
      effective_from, effective_to, features, quotas, prices, offer_hash, published_at, retired_at
    FROM awcms_mini_service_catalog_published_offers
    WHERE (${options.planKey ?? null}::text IS NULL OR plan_key = ${options.planKey ?? null})
      AND (${options.activeOnly ?? false} = false OR retired_at IS NULL)
    ORDER BY plan_key ASC, version DESC
    LIMIT 500
  `) as PublishedOfferDbRow[];
  return rows.map(toOffer);
}

export async function getPublishedOffer(
  tx: Bun.SQL,
  planKey: string,
  version: number
): Promise<PublishedOffer | null> {
  const rows = (await tx`
    SELECT plan_key, plan_name, plan_type, version, currency, market, trial_enabled, trial_days,
      effective_from, effective_to, features, quotas, prices, offer_hash, published_at, retired_at
    FROM awcms_mini_service_catalog_published_offers
    WHERE plan_key = ${planKey} AND version = ${version}
  `) as PublishedOfferDbRow[];
  return rows[0] ? toOffer(rows[0]) : null;
}

export async function getLatestPublishedOffer(
  tx: Bun.SQL,
  planKey: string
): Promise<PublishedOffer | null> {
  const rows = (await tx`
    SELECT plan_key, plan_name, plan_type, version, currency, market, trial_enabled, trial_days,
      effective_from, effective_to, features, quotas, prices, offer_hash, published_at, retired_at
    FROM awcms_mini_service_catalog_published_offers
    WHERE plan_key = ${planKey} AND retired_at IS NULL
    ORDER BY version DESC
    LIMIT 1
  `) as PublishedOfferDbRow[];
  return rows[0] ? toOffer(rows[0]) : null;
}
