import { resolveModuleEnabled } from "../../../../../modules/identity-access/application/auth-context";
import { defaultBusinessScopeHierarchyPortAdapter } from "../../../../../modules/identity-access/application/business-scope-hierarchy-port-adapter";
import { organizationStructureHierarchyPortAdapter } from "../../../../../modules/organization-structure/application/organization-structure-hierarchy-port-adapter";
import type { BusinessScopeHierarchyPort } from "../../../../../modules/_shared/ports/business-scope-hierarchy-port";

const ORGANIZATION_STRUCTURE_MODULE_KEY = "organization_structure";

/**
 * The REAL `BusinessScopeHierarchyPort` composition (Issue #786, follow-up
 * to #746/#749; factored out of `assignments/index.ts` by Issue #802 so
 * `assignments/[id]/revoke.ts` can share the exact same composition root
 * instead of duplicating it). `identity_access`'s own `application`/`domain`
 * tree never imports `organization_structure` — that would be a
 * Core-depends-on-Optional violation, ADR-0013 §1 — so only a route (a
 * real composition root, this file's callers) may decide which adapter to
 * wire in for a given tenant.
 *
 * The real adapter is tried FIRST when `organization_structure` is enabled
 * for this tenant; since it already returns `resolved: false` for any
 * scope type it doesn't own (`"office"` included), falling through to
 * identity-access's own flat adapter is always safe.
 */
export function buildBusinessScopeHierarchyPort(
  organizationStructureEnabled: boolean
): BusinessScopeHierarchyPort {
  return {
    async resolveScope(tx, tenantId, scopeType, scopeId) {
      if (organizationStructureEnabled) {
        const organizationResolution =
          await organizationStructureHierarchyPortAdapter.resolveScope(
            tx,
            tenantId,
            scopeType,
            scopeId
          );
        if (organizationResolution.resolved) {
          return organizationResolution;
        }
      }

      return defaultBusinessScopeHierarchyPortAdapter.resolveScope(
        tx,
        tenantId,
        scopeType,
        scopeId
      );
    }
  };
}

/** Resolves whether `organization_structure` is enabled for `tenantId`, the input `buildBusinessScopeHierarchyPort` needs — thin wrapper kept here so both composition-root routes call it identically. */
export async function resolveOrganizationStructureEnabled(
  tx: Bun.SQL,
  tenantId: string
): Promise<boolean> {
  return resolveModuleEnabled(tx, tenantId, ORGANIZATION_STRUCTURE_MODULE_KEY);
}
