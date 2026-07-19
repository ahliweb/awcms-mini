/**
 * `service_catalog_read` capability port (Issue #870, epic #868 SaaS control
 * plane, ADR-0022 §2/§4). This is the ONLY contract through which a
 * tenant-plane / downstream control-plane module (starting with
 * `tenant_entitlement`, #871) ever reads the catalog — READ-ONLY, and it
 * returns ONLY `published` offer versions (never draft/retired working data,
 * never operator-only internal prices). The provider adapter
 * (`service-catalog/application/service-catalog-read-port-adapter.ts`) reads
 * exclusively the tenant-readable published projection
 * (`awcms_mini_service_catalog_published_offers`); it never touches the
 * operator authoring tables.
 *
 * Consumers wire the adapter at their composition root (a route handler),
 * exactly the port pattern `_shared/ports/*.ts` already establishes
 * (`news-media-port`, `reference-data-port`) — never a direct cross-module
 * import of `service_catalog`'s application/domain code (enforced by
 * `tests/unit/module-boundary.test.ts`). There is no write side: the catalog
 * is mutated only by `service_catalog`'s own platform-operator endpoints.
 */

/** One published price component visible to a tenant — the PUBLIC subset only (internal-visibility prices never cross this boundary). Amount is EXACT minor units (integer), never a float. */
export type PublishedOfferPrice = {
  componentKey: string;
  amountMinor: number;
  currency: string;
  interval: string;
  metadata: Record<string, unknown>;
};

/** One published feature grant or whole-module entitlement in an offer. */
export type PublishedOfferFeature = {
  featureKind: "feature" | "module";
  featureKey: string;
  enabled: boolean;
  metadata: Record<string, unknown>;
};

/** One published usage quota/limit in an offer. `limitValue` is `null` iff `isUnlimited`. */
export type PublishedOfferQuota = {
  meterKey: string;
  isUnlimited: boolean;
  limitValue: number | null;
  unit: string;
  resetPolicy: string;
  metadata: Record<string, unknown>;
};

/** An immutable published offer version — the reproducible commercial snapshot a tenant may be subscribed to. */
export type PublishedOffer = {
  planKey: string;
  planName: string;
  planType: string;
  version: number;
  currency: string;
  market: string | null;
  trialEnabled: boolean;
  trialDays: number | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  features: PublishedOfferFeature[];
  quotas: PublishedOfferQuota[];
  prices: PublishedOfferPrice[];
  offerHash: string;
  publishedAt: string;
  /** Set when the source version has been retired; the offer stays readable regardless. */
  retiredAt: string | null;
};

export type ListPublishedOffersOptions = {
  /** When `true`, retired offers are excluded (default `false` — retired offers remain readable for reproducibility). */
  activeOnly?: boolean;
  /** Optional filter to a single plan. */
  planKey?: string;
};

export type ServiceCatalogReadPort = {
  /** List published offers (bounded), newest version first. */
  listPublishedOffers(
    options?: ListPublishedOffersOptions
  ): Promise<PublishedOffer[]>;
  /** Fetch one published offer by plan + version, or `null` if none. */
  getPublishedOffer(
    planKey: string,
    version: number
  ): Promise<PublishedOffer | null>;
  /** Fetch the latest (highest-version) non-retired published offer for a plan, or `null`. */
  getLatestPublishedOffer(planKey: string): Promise<PublishedOffer | null>;
};
