/**
 * The ONE place a projection's per-tenant accessibility is decided (Issue
 * #880, epic #868 Wave 3 operations).
 *
 * ## Why this exists
 *
 * Until issue #880 every registered `ProjectionDescriptor` was owned by
 * `reporting` itself — a base module every tenant always has — so
 * `isProjectionPermitted` (the caller holds the descriptor's own
 * `requiredPermission`) was the whole decision. The control-plane modules
 * that now contribute their own descriptors are `defaultTenantState:
 * "disabled"` (ADR-0022 §7): a tenant that never opted into
 * `subscription_billing` has no reachable `subscription_billing` endpoint at
 * all, and `resolveModuleEnabled` answers `false` for it WITHOUT any row in
 * `awcms_mini_tenant_modules`.
 *
 * Permission alone is not that decision. `fetchGrantedPermissionKeys` does
 * not filter disabled modules out of its result, so a subject keeps every
 * permission key of a module switched off for their tenant — the exact
 * parity failure PR #839's security review found in `data_exchange` (see
 * `data-exchange/application/descriptor-authorization.ts`, whose ordering
 * this file follows: module state FIRST, exactly as `authorizeInTransaction`
 * orders it, then RBAC). Without this gate a tenant without the control
 * plane would still see `subscription_billing.invoice_lifecycle` and
 * `payment_gateway.payment_processing_outcomes` listed — with live counts —
 * on `GET /api/v1/reports/projections` and on the admin projections screen,
 * while every route of the owning module answered `403 MODULE_DISABLED`.
 *
 * ## Chokepoint, not per-route
 *
 * The decision lives HERE and not in each of the six routes that resolve a
 * descriptor (list, detail, reconcile, rebuild, rebuild-cancel, export
 * create/trigger) plus the SSR screen and the two workers — the lesson from
 * issue #841 (SSR admin pages rendered data for modules whose API answered
 * 403 because the gate had been written per-route). `tests/unit/
 * reporting-projection-access-chokepoint.test.ts` fails if any file other
 * than this one imports the permission-only helper, so a future call site
 * cannot re-introduce the looser check by accident.
 *
 * Fail-closed: `resolveModuleEnabled` throwing (database unavailable,
 * permission denied on the lookup) propagates to the caller rather than
 * being swallowed into "accessible" — an indeterminate module state is never
 * an allow (ADR-0022 §4).
 */
import { resolveModuleEnabled } from "../../identity-access/application/auth-context";
import { isProjectionPermitted } from "../domain/projection-permission-filter";
import type { ProjectionDescriptor } from "../../_shared/module-contract";

/**
 * Is this projection readable by this caller, for this tenant, right now?
 *
 * Module state first (a permission key belonging to a module this tenant has
 * disabled grants nothing, however the key was obtained), then the
 * descriptor's own declared permission.
 */
export async function isProjectionAccessibleForTenant(
  tx: Bun.SQL,
  tenantId: string,
  descriptor: ProjectionDescriptor,
  grantedPermissionKeys: ReadonlySet<string>
): Promise<boolean> {
  if (!(await isProjectionOwnerModuleEnabled(tx, tenantId, descriptor))) {
    return false;
  }

  return isProjectionPermitted(descriptor, grantedPermissionKeys);
}

/**
 * The module half of the decision on its own — for the two UNATTENDED
 * workers (`projection-incremental-worker.ts`,
 * `scheduled-export-dispatch.ts`), which have no caller and therefore no
 * permission set, but must still treat a module a tenant has not enabled as
 * fully inert (ADR-0022 §7: a LAN/offline deployment that never activates
 * the control plane does no control-plane work at all).
 */
export async function isProjectionOwnerModuleEnabled(
  tx: Bun.SQL,
  tenantId: string,
  descriptor: ProjectionDescriptor
): Promise<boolean> {
  return resolveModuleEnabled(tx, tenantId, descriptor.ownerModuleKey);
}

/**
 * Keeps only the descriptors accessible to this caller for this tenant —
 * "filter, never partially reveal", the posture a LIST endpoint needs (a
 * single-item lookup instead REJECTS; see each route's own handling).
 *
 * Sequential, NOT `Promise.all`: every iteration issues a query on the SAME
 * transaction/connection (`tx`), and a single Postgres connection processes
 * one query at a time — running these concurrently produced a real hang in
 * this repo (see `projection-reconciliation.ts`'s matching comment).
 */
export async function filterAccessibleProjectionDescriptors(
  tx: Bun.SQL,
  tenantId: string,
  descriptors: readonly ProjectionDescriptor[],
  grantedPermissionKeys: ReadonlySet<string>
): Promise<ProjectionDescriptor[]> {
  const accessible: ProjectionDescriptor[] = [];

  for (const descriptor of descriptors) {
    if (
      await isProjectionAccessibleForTenant(
        tx,
        tenantId,
        descriptor,
        grantedPermissionKeys
      )
    ) {
      accessible.push(descriptor);
    }
  }

  return accessible;
}
