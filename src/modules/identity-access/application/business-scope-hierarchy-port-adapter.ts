/**
 * Default/flat `BusinessScopeHierarchyPort` adapter (Issue #746, epic #738
 * platform-evolution Wave 2). See `_shared/ports/business-scope-hierarchy-
 * port.ts` for the full rationale — no optional organization module
 * (`organization_structure`, ADR-0013 §1 Wave 2 candidate) exists in this
 * repo yet, so identity-access supplies the only implementation today.
 *
 * Validates exactly ONE `scopeType`: `"office"`, against
 * `awcms_mini_offices` (owned by `tenant_admin`) — a FLAT resolution (no
 * ancestors/descendants; `awcms_mini_offices.parent_office_id` exists in
 * the schema but this default adapter deliberately does not walk it,
 * leaving hierarchy-aware office trees to a future `organization_
 * structure` adapter that supersedes this one for that scope type; see the
 * port's own header for how a composition root swaps adapters). Every
 * OTHER `scopeType` resolves to `resolved: false` with empty ancestor/
 * descendant lists — the safe default this port's contract requires (no
 * crash, no silent hierarchy propagation), until a real owning module
 * registers its own adapter for that scope type.
 *
 * Reading `awcms_mini_offices` directly here (a `tenant_admin`-owned
 * table) rather than through a NEW capability port is a deliberate,
 * PRECEDENTED choice, not a shortcut: `identity-access/application/
 * password-reset.ts`, `google-oidc.ts`, and `tenant-sso.ts` already read
 * `awcms_mini_tenants` (also owned by `tenant_admin`) directly via raw SQL
 * with no port at all — `identity_access` already lists `tenant_admin` as
 * a lifecycle `dependencies` entry (`module.ts`), and ADR-0013 §6's
 * "no shared-table WRITE" rule (the actual guardrail this repo enforces
 * structurally, `tests/unit/module-boundary-cycles.test.ts`) is about
 * writes, not reads, between modules that already have a declared lifecycle
 * dependency on each other. Introducing a brand-new port for a read this
 * codebase already has an established precedent for would add indirection
 * without closing any real gap — `BusinessScopeHierarchyPort` itself
 * exists for the cases that DO need one: an optional module that
 * identity-access has (and must have) no lifecycle dependency on at all.
 *
 * A composition root (a route handler, the expiry job script, or an
 * integration test) is the only thing that should import this file —
 * `application/business-scope-assignment-service.ts`/`sod-exception-
 * service.ts` receive the port as an injected parameter instead, exactly
 * the pattern `legal-hold-guard-port-adapter.ts` documents.
 */
import type {
  BusinessScopeHierarchyPort,
  BusinessScopeResolution
} from "../../_shared/ports/business-scope-hierarchy-port";

const UNRESOLVED: BusinessScopeResolution = {
  resolved: false,
  ancestorScopeIds: [],
  descendantScopeIds: []
};

export const defaultBusinessScopeHierarchyPortAdapter: BusinessScopeHierarchyPort =
  {
    async resolveScope(tx, tenantId, scopeType, scopeId) {
      if (scopeType !== "office") {
        return UNRESOLVED;
      }

      const rows = (await tx`
        SELECT id
        FROM awcms_mini_offices
        WHERE tenant_id = ${tenantId} AND id = ${scopeId} AND deleted_at IS NULL
      `) as { id: string }[];

      if (rows.length === 0) {
        return UNRESOLVED;
      }

      return {
        resolved: true,
        ancestorScopeIds: [],
        descendantScopeIds: []
      };
    }
  };
