/**
 * `organization_structure`'s REAL `BusinessScopeHierarchyPort` adapter
 * (Issue #749, epic #738 platform-evolution Wave 2, ADR-0016). See
 * `_shared/ports/business-scope-hierarchy-port.ts` for the full port
 * contract/rationale, and `identity-access/application/business-scope-
 * hierarchy-port-adapter.ts` for the sibling flat "office" adapter this
 * one does NOT supersede.
 *
 * Handles exactly TWO `scopeType`s, both walking the REAL, effective-
 * dated hierarchy (as-of "now" — this port's contract has no `asOf`
 * parameter) via `organization-unit-hierarchy-service.ts`'s read-only
 * helpers, tenant-scoped, RLS-respecting:
 *
 * - `"legal_entity"`: resolved if the legal entity exists for this tenant
 *   and is not soft-deleted. `ancestorScopes` is always `[]` (a legal
 *   entity is the root of ITS OWN chain — nothing sits above it in this
 *   module's model). `descendantScopes` is every organization unit that
 *   either directly declares this `legal_entity_id`, or is a hierarchy
 *   descendant (any depth) of one that does — all returned as
 *   `{ scopeType: "organization_unit", scopeId }`.
 * - `"organization_unit"`: resolved if the unit exists for this tenant and
 *   is not soft-deleted. `ancestorScopes` walks up the current hierarchy
 *   (immediate parent first); if the topmost unit in that walk has no
 *   further parent edge but DOES declare a `legal_entity_id`, that legal
 *   entity is appended as the final (broadest) ancestor — the
 *   heterogeneous-ancestry case `business-scope-hierarchy-port.ts`'s
 *   header documents (`unit(branch) -> unit(region) -> legal_entity`).
 *   `descendantScopes` is every unit reachable downward through the
 *   hierarchy (any depth), all `{ scopeType: "organization_unit", ... }`.
 *
 * Every OTHER `scopeType` (including `"location"` — deliberately NOT
 * exposed through this port, see ADR-0016 §10: this port is about
 * business-scope authorization/hierarchy, not physical location lookup)
 * resolves to `resolved: false` with empty ancestor/descendant lists, the
 * same safe-default contract `defaultBusinessScopeHierarchyPortAdapter`
 * documents.
 *
 * COMPOSITION: a composition root (route handler, job script) that needs
 * to resolve BOTH "office" (identity-access's default adapter) AND
 * "legal_entity"/"organization_unit" (this adapter) scopes side by side
 * has to choose per-call which adapter to inject based on the requested
 * `scopeType` — no call site in this repo needs both today, so no
 * "composite adapter that tries both" helper exists yet; add one only
 * when a real caller needs it (same "don't build the composite until a
 * real need appears" restraint the port's own header documents for the
 * office/organization-structure split).
 */
import type {
  BusinessScopeHierarchyPort,
  BusinessScopeReference,
  BusinessScopeResolution
} from "../../_shared/ports/business-scope-hierarchy-port";
import { readEdgeMap } from "./organization-unit-hierarchy-service";
import {
  computeAncestorChain,
  computeDescendantClosure,
  computeDescendants
} from "../domain/organization-unit-hierarchy";

const UNRESOLVED: BusinessScopeResolution = {
  resolved: false,
  ancestorScopes: [],
  descendantScopes: []
};

async function resolveLegalEntityScope(
  tx: Bun.SQL,
  tenantId: string,
  legalEntityId: string
): Promise<BusinessScopeResolution> {
  const entityRows = (await tx`
    SELECT id FROM awcms_mini_legal_entities
    WHERE tenant_id = ${tenantId} AND id = ${legalEntityId} AND deleted_at IS NULL
  `) as { id: string }[];

  if (!entityRows[0]) {
    return UNRESOLVED;
  }

  // SEED SET = every unit that DECLARES this legal entity — deliberately
  // NOT "only the root units of this entity" (Issue #834 proposed filtering
  // these rows down to roots; that proposal is wrong twice over):
  //
  //   1. There is no root to filter ON. `awcms_mini_organization_units` has
  //      no `parent_id` column at all — the hierarchy lives in the separate,
  //      effective-dated `awcms_mini_organization_unit_hierarchies` table
  //      (sql/063), so a `parent_id IS NULL` predicate cannot be written
  //      against this query in the first place.
  //   2. It would SILENTLY NARROW an authorization scope. A unit that
  //      declares this entity while sitting UNDER a parent that does not
  //      (a different entity's unit, or an unaffiliated grouping unit) is
  //      not a root by any definition — filtering to roots would drop it AND
  //      its entire subtree from `descendantScopes`, contradicting this
  //      file's documented contract ("every unit that either directly
  //      declares this legal_entity_id, or is a hierarchy descendant of one
  //      that does").
  //
  // The DOWNWARD WALK IS LOAD-BEARING, not redundant: descendants routinely
  // do NOT declare the entity themselves (they inherit it structurally), so
  // the closure is strictly larger than this seed set. The real defect was
  // the walk's SHAPE — one fresh-`visited`-set `computeDescendants` call per
  // seed re-walked every shared subtree once per seed above it (O(S x depth),
  // worst O(U^2)). `computeDescendantClosure` does the same job as a single
  // multi-source traversal over one shared `visited` set: O(U + E).
  const entityUnitRows = (await tx`
    SELECT id FROM awcms_mini_organization_units
    WHERE tenant_id = ${tenantId} AND legal_entity_id = ${legalEntityId} AND deleted_at IS NULL
  `) as { id: string }[];

  const edges = await readEdgeMap(tx, tenantId, null);
  const childrenByParent = new Map<string, string[]>();
  for (const [unitId, parentId] of edges.entries()) {
    if (parentId === null) {
      continue;
    }
    const list = childrenByParent.get(parentId) ?? [];
    list.push(unitId);
    childrenByParent.set(parentId, list);
  }

  const descendantScopes: BusinessScopeReference[] = computeDescendantClosure(
    childrenByParent,
    entityUnitRows.map((row) => row.id)
  ).map((scopeId) => ({ scopeType: "organization_unit", scopeId }));

  return {
    resolved: true,
    ancestorScopes: [],
    descendantScopes
  };
}

async function resolveOrganizationUnitScope(
  tx: Bun.SQL,
  tenantId: string,
  unitId: string
): Promise<BusinessScopeResolution> {
  const unitRows = (await tx`
    SELECT id, legal_entity_id FROM awcms_mini_organization_units
    WHERE tenant_id = ${tenantId} AND id = ${unitId} AND deleted_at IS NULL
  `) as { id: string; legal_entity_id: string | null }[];

  if (!unitRows[0]) {
    return UNRESOLVED;
  }

  const edges = await readEdgeMap(tx, tenantId, null);
  const ancestorUnitIds = computeAncestorChain(edges, unitId);

  const ancestorScopes: BusinessScopeReference[] = ancestorUnitIds.map(
    (scopeId) => ({ scopeType: "organization_unit" as const, scopeId })
  );

  // Heterogeneous-ancestry termination: if the topmost ancestor (or the
  // unit itself, when it has no parent edge at all) declares a legal
  // entity, append it as the final/broadest ancestor.
  const topmostUnitId = ancestorUnitIds[ancestorUnitIds.length - 1] ?? unitId;
  const topmostRows =
    topmostUnitId === unitId
      ? unitRows
      : ((await tx`
          SELECT id, legal_entity_id FROM awcms_mini_organization_units
          WHERE tenant_id = ${tenantId} AND id = ${topmostUnitId} AND deleted_at IS NULL
        `) as { id: string; legal_entity_id: string | null }[]);

  const topmostLegalEntityId = topmostRows[0]?.legal_entity_id ?? null;
  if (topmostLegalEntityId !== null) {
    ancestorScopes.push({
      scopeType: "legal_entity",
      scopeId: topmostLegalEntityId
    });
  }

  const childrenByParent = new Map<string, string[]>();
  for (const [childUnitId, parentId] of edges.entries()) {
    if (parentId === null) {
      continue;
    }
    const list = childrenByParent.get(parentId) ?? [];
    list.push(childUnitId);
    childrenByParent.set(parentId, list);
  }

  const descendantScopes: BusinessScopeReference[] = computeDescendants(
    childrenByParent,
    unitId
  ).map((scopeId) => ({ scopeType: "organization_unit" as const, scopeId }));

  return {
    resolved: true,
    ancestorScopes,
    descendantScopes
  };
}

export const organizationStructureHierarchyPortAdapter: BusinessScopeHierarchyPort =
  {
    async resolveScope(tx, tenantId, scopeType, scopeId) {
      if (scopeType === "legal_entity") {
        return resolveLegalEntityScope(tx, tenantId, scopeId);
      }
      if (scopeType === "organization_unit") {
        return resolveOrganizationUnitScope(tx, tenantId, scopeId);
      }
      return UNRESOLVED;
    }
  };
