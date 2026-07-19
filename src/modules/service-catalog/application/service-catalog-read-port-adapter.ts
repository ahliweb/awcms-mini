/**
 * `service_catalog_read` capability adapter (Issue #870, epic #868, ADR-0022
 * §2/§4). `service_catalog` PROVIDES this port; downstream control-plane
 * modules (`tenant_entitlement`, #871) and any tenant-plane consumer wire it
 * at their composition root instead of importing `service_catalog`'s
 * application/domain code directly (enforced by
 * `tests/unit/module-boundary.test.ts`). Read-only, published-only — it reads
 * exclusively the tenant-readable projection via `service-catalog-read-query.ts`.
 *
 * The adapter is bound to an already tenant-scoped `tx` (the caller's
 * `withTenant` transaction), mirroring `reference-data`'s
 * `reference-data-port-adapter.ts`.
 */
import type {
  ListPublishedOffersOptions,
  PublishedOffer,
  ServiceCatalogReadPort
} from "../../_shared/ports/service-catalog-read-port";
import {
  getLatestPublishedOffer,
  getPublishedOffer,
  listPublishedOffers
} from "./service-catalog-read-query";

export function createServiceCatalogReadPort(
  tx: Bun.SQL
): ServiceCatalogReadPort {
  return {
    listPublishedOffers(
      options?: ListPublishedOffersOptions
    ): Promise<PublishedOffer[]> {
      return listPublishedOffers(tx, options);
    },
    getPublishedOffer(
      planKey: string,
      version: number
    ): Promise<PublishedOffer | null> {
      return getPublishedOffer(tx, planKey, version);
    },
    getLatestPublishedOffer(planKey: string): Promise<PublishedOffer | null> {
      return getLatestPublishedOffer(tx, planKey);
    }
  };
}
