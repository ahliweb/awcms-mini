/**
 * Organization-unit hierarchy service (Issue #749, epic #738
 * platform-evolution Wave 2, ADR-0016) — the transactional writer for
 * `awcms_mini_organization_unit_hierarchies`.
 *
 * TRACEABILITY (issue #749 explicit warning — "validator built but never
 * wired to the real write path" has recurred across #746/#747 in this
 * epic): `reparentUnit` below is the ONLY function in this module that
 * INSERTs/UPDATEs `awcms_mini_organization_unit_hierarchies`. It is called
 * from THREE real call sites: `createHierarchyEdge` (initial parent
 * assignment for a newly created unit, exported below), the
 * `POST /api/v1/organization-structure/hierarchy/reparent` route
 * (reparent an existing unit), and nowhere else — there is no separate
 * "bulk import" path in this issue (seed/import hooks are documented as
 * future, optional, `data_exchange`-contract work, issue #749 scope). Every
 * one of those calls `reparentUnit`, which in order:
 *   1. Re-validates `unitId`/`candidateParentId` belong to THIS tenant and
 *      are not soft-deleted (cross-tenant/soft-deleted references
 *      rejected).
 *   2. Acquires a TENANT-WIDE `pg_advisory_xact_lock` — this is what
 *      closes the race between two concurrent reparents of DIFFERENT
 *      units that together would form a cycle (row-level locking alone
 *      cannot catch that, since the two writes touch different rows).
 *      The lock auto-releases at transaction end (commit or rollback).
 *   3. Re-reads the current (`effective_to IS NULL`) adjacency map for the
 *      WHOLE tenant, fresh, now that the lock is held.
 *   4. Calls `domain/organization-unit-hierarchy.ts`'s `validateReparent`
 *      (self-parent/cycle) against that fresh map — ANY rejection
 *      increments `organization_structure_hierarchy_invalid_attempts_total`
 *      by `reason` and returns a discriminated-union failure, writing
 *      NOTHING.
 *   5. `SELECT ... FOR UPDATE` locks this unit's own current open edge row
 *      (defense in depth alongside the advisory lock, and what the
 *      subsequent `UPDATE ... WHERE effective_to IS NULL` naturally
 *      re-checks) before closing it.
 *   6. Closes the current open edge (`effective_to = now()`) and opens a
 *      new one (`effective_from = now()`) in the SAME transaction — never
 *      an in-place `UPDATE ... SET parent_organization_unit_id`.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import { recordCounter } from "../../../lib/observability/metrics-port";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import {
  ORGANIZATION_STRUCTURE_EVENT_VERSION,
  ORGANIZATION_STRUCTURE_HIERARCHY_CHANGED_EVENT_TYPE
} from "../../domain-event-runtime/domain/event-type-registry";
import {
  computeAncestorChain,
  computeDescendants,
  computeMaxDepth,
  validateEffectivePeriodForReparent,
  validateReparent,
  type HierarchyEdgeMap
} from "../domain/organization-unit-hierarchy";

const MODULE_KEY = "organization_structure";

export type HierarchyEdgeRow = {
  id: string;
  tenantId: string;
  organizationUnitId: string;
  parentOrganizationUnitId: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  reason: string | null;
};

type HierarchyEdgeDbRow = {
  id: string;
  tenant_id: string;
  organization_unit_id: string;
  parent_organization_unit_id: string | null;
  effective_from: Date;
  effective_to: Date | null;
  reason: string | null;
};

function toRow(row: HierarchyEdgeDbRow): HierarchyEdgeRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    organizationUnitId: row.organization_unit_id,
    parentOrganizationUnitId: row.parent_organization_unit_id,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    reason: row.reason
  };
}

/** Acquires a per-tenant advisory lock scoped to THIS transaction — see file header for why this (not just row-level locking) is required to close the cross-row concurrent-reparent race. */
async function acquireHierarchyAdvisoryLock(
  tx: Bun.SQL,
  tenantId: string
): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtext('awcms_mini_organization_unit_hierarchy:' || ${tenantId}::text))`;
}

/** Reads the CURRENT (`effective_to IS NULL`) unit -> parent adjacency map for the whole tenant, or the AS-OF map for a given timestamp when `asOf` is provided. */
export async function readEdgeMap(
  tx: Bun.SQL,
  tenantId: string,
  asOf: Date | null = null
): Promise<HierarchyEdgeMap> {
  const rows = (await tx`
    SELECT organization_unit_id, parent_organization_unit_id
    FROM awcms_mini_organization_unit_hierarchies
    WHERE tenant_id = ${tenantId}
      AND (
        (${asOf}::timestamptz IS NULL AND effective_to IS NULL)
        OR (
          ${asOf}::timestamptz IS NOT NULL
          AND effective_from <= ${asOf}
          AND (effective_to IS NULL OR effective_to > ${asOf})
        )
      )
  `) as {
    organization_unit_id: string;
    parent_organization_unit_id: string | null;
  }[];

  const map = new Map<string, string | null>();
  for (const row of rows) {
    map.set(row.organization_unit_id, row.parent_organization_unit_id);
  }
  return map;
}

/**
 * Every organization-unit id for the tenant that existed as of `asOf`
 * (defaults to now — soft-deleted/not-yet-effective units excluded).
 * NEEDED because `readEdgeMap` only returns rows for units that have an
 * actual hierarchy edge row — a unit that was created but never subject
 * to `reparentUnit` (whether as the unit being reparented, or simply
 * never touched at all) has NO row in
 * `awcms_mini_organization_unit_hierarchies`, even though it may still be
 * pointed to as another unit's PARENT. Root detection below must consider
 * the full unit universe, not just `edges.keys()`, or such a unit
 * silently vanishes from the tree/max-depth computation.
 */
async function fetchActiveUnitIds(
  tx: Bun.SQL,
  tenantId: string,
  asOf: Date | null = null
): Promise<string[]> {
  const rows = (await tx`
    SELECT id FROM awcms_mini_organization_units
    WHERE tenant_id = ${tenantId}
      AND (
        (${asOf}::timestamptz IS NULL AND deleted_at IS NULL)
        OR (
          ${asOf}::timestamptz IS NOT NULL
          AND effective_from <= ${asOf}
          AND (effective_to IS NULL OR effective_to > ${asOf})
        )
      )
  `) as { id: string }[];
  return rows.map((row) => row.id);
}

function buildChildrenMap(edges: HierarchyEdgeMap): Map<string, string[]> {
  const childrenByParent = new Map<string, string[]>();
  for (const [unitId, parentId] of edges.entries()) {
    const key = parentId ?? "__root__";
    const list = childrenByParent.get(key) ?? [];
    list.push(unitId);
    childrenByParent.set(key, list);
  }
  return childrenByParent;
}

export type ReparentResult =
  | { ok: true; edge: HierarchyEdgeRow }
  | { ok: false; reason: "unit_not_found" }
  | { ok: false; reason: "parent_not_found" }
  | {
      ok: false;
      reason: "invalid";
      validationReason:
        "self_parent" | "cycle" | "invalid_period" | "max_depth_exceeded";
      message: string;
    };

/**
 * The SOLE mutating entry point for the hierarchy table — see file header
 * for the full traceability note. `candidateParentId: null` moves the unit
 * to top-level (directly under the tenant).
 */
export async function reparentUnit(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  unitId: string,
  candidateParentId: string | null,
  reason: string | null,
  correlationId?: string
): Promise<ReparentResult> {
  const unitRows = (await tx`
    SELECT id FROM awcms_mini_organization_units
    WHERE tenant_id = ${tenantId} AND id = ${unitId} AND deleted_at IS NULL
  `) as { id: string }[];
  if (!unitRows[0]) {
    return { ok: false, reason: "unit_not_found" };
  }

  if (candidateParentId !== null) {
    const parentRows = (await tx`
      SELECT id FROM awcms_mini_organization_units
      WHERE tenant_id = ${tenantId} AND id = ${candidateParentId} AND deleted_at IS NULL
    `) as { id: string }[];
    if (!parentRows[0]) {
      return { ok: false, reason: "parent_not_found" };
    }
  }

  // Tenant-wide serialization point — see file header. MUST happen before
  // reading the adjacency map used for cycle validation below.
  await acquireHierarchyAdvisoryLock(tx, tenantId);

  const currentEdges = await readEdgeMap(tx, tenantId, null);

  const structuralErrors = validateReparent({
    unitId,
    candidateParentId,
    currentEdges
  });

  if (structuralErrors.length > 0) {
    const error = structuralErrors[0]!;
    recordCounter("organization_structure_hierarchy_invalid_attempts_total", {
      reason: error.reason
    });
    return {
      ok: false,
      reason: "invalid",
      validationReason: error.reason as
        "self_parent" | "cycle" | "max_depth_exceeded",
      message: error.message
    };
  }

  // Lock (and read) this unit's own current open edge row, if any — belt
  // and suspenders alongside the advisory lock (file header point 5).
  const currentOpenRows = (await tx`
    SELECT id, effective_from
    FROM awcms_mini_organization_unit_hierarchies
    WHERE tenant_id = ${tenantId} AND organization_unit_id = ${unitId} AND effective_to IS NULL
    FOR UPDATE
  `) as { id: string; effective_from: Date }[];

  const now = new Date();
  const previousOpen = currentOpenRows[0] ?? null;

  const periodErrors = validateEffectivePeriodForReparent({
    effectiveFrom: now,
    previousOpenEffectiveFrom: previousOpen?.effective_from ?? null
  });

  if (periodErrors.length > 0) {
    const error = periodErrors[0]!;
    recordCounter("organization_structure_hierarchy_invalid_attempts_total", {
      reason: error.reason
    });
    return {
      ok: false,
      reason: "invalid",
      validationReason: "invalid_period",
      message: error.message
    };
  }

  if (previousOpen) {
    await tx`
      UPDATE awcms_mini_organization_unit_hierarchies
      SET effective_to = ${now}
      WHERE id = ${previousOpen.id} AND tenant_id = ${tenantId} AND effective_to IS NULL
    `;
  }

  const insertedRows = (await tx`
    INSERT INTO awcms_mini_organization_unit_hierarchies
      (tenant_id, organization_unit_id, parent_organization_unit_id, effective_from,
       reason, changed_by_tenant_user_id)
    VALUES (
      ${tenantId}, ${unitId}, ${candidateParentId}, ${now}, ${reason}, ${actorTenantUserId}
    )
    RETURNING id, tenant_id, organization_unit_id, parent_organization_unit_id,
      effective_from, effective_to, reason
  `) as HierarchyEdgeDbRow[];

  const edge = toRow(insertedRows[0]!);

  await appendDomainEvent(tx, tenantId, {
    eventType: ORGANIZATION_STRUCTURE_HIERARCHY_CHANGED_EVENT_TYPE,
    eventVersion: ORGANIZATION_STRUCTURE_EVENT_VERSION,
    aggregateType: "organization_unit_hierarchy",
    aggregateId: unitId,
    producerModule: MODULE_KEY,
    correlationId,
    actorTenantUserId,
    payload: {
      organizationUnitId: unitId,
      parentOrganizationUnitId: candidateParentId
    }
  });

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "assign",
    resourceType: "organization_unit_hierarchy",
    resourceId: unitId,
    severity: "critical",
    message: `Organization unit reparented (new parent: ${candidateParentId ?? "top-level"}).`,
    attributes: { parentOrganizationUnitId: candidateParentId, reason },
    correlationId
  });

  return { ok: true, edge };
}

export type OrganizationUnitTreeNode = {
  organizationUnitId: string;
  children: OrganizationUnitTreeNode[];
};

function buildTreeNode(
  unitId: string,
  childrenByParent: ReadonlyMap<string, string[]>,
  visiting: Set<string>
): OrganizationUnitTreeNode {
  if (visiting.has(unitId)) {
    // Defensive — should be unreachable given no-cycle enforcement.
    return { organizationUnitId: unitId, children: [] };
  }
  visiting.add(unitId);
  const children = (childrenByParent.get(unitId) ?? []).map((childId) =>
    buildTreeNode(childId, childrenByParent, visiting)
  );
  visiting.delete(unitId);
  return { organizationUnitId: unitId, children };
}

/** Builds the full forest (or the subtree rooted at `rootUnitId`) as of `asOf` (defaults to now). */
export async function buildOrganizationUnitTree(
  tx: Bun.SQL,
  tenantId: string,
  rootUnitId: string | null = null,
  asOf: Date | null = null
): Promise<OrganizationUnitTreeNode[]> {
  const edges = await readEdgeMap(tx, tenantId, asOf);
  const childrenByParent = buildChildrenMap(edges);

  if (rootUnitId !== null) {
    return [buildTreeNode(rootUnitId, childrenByParent, new Set())];
  }

  const allUnitIds = await fetchActiveUnitIds(tx, tenantId, asOf);
  const rootIds = allUnitIds.filter((id) => (edges.get(id) ?? null) === null);
  return rootIds.map((id) => buildTreeNode(id, childrenByParent, new Set()));
}

export type AncestorDescendantChains = {
  ancestorUnitIds: string[];
  descendantUnitIds: string[];
};

/** Ancestor chain (immediate parent first) and full descendant set for `unitId`, as of `asOf` (defaults to now). */
export async function resolveAncestryChains(
  tx: Bun.SQL,
  tenantId: string,
  unitId: string,
  asOf: Date | null = null
): Promise<AncestorDescendantChains> {
  const edges = await readEdgeMap(tx, tenantId, asOf);
  const childrenByParent = buildChildrenMap(edges);

  return {
    ancestorUnitIds: computeAncestorChain(edges, unitId),
    descendantUnitIds: computeDescendants(childrenByParent, unitId)
  };
}

/** Current max hierarchy depth for the tenant (root = depth 0) — feeds the `organization_structure_hierarchy_max_depth` gauge. */
export async function computeCurrentMaxDepth(
  tx: Bun.SQL,
  tenantId: string
): Promise<number> {
  const edges = await readEdgeMap(tx, tenantId, null);
  const childrenByParent = buildChildrenMap(edges);
  const allUnitIds = await fetchActiveUnitIds(tx, tenantId, null);
  const rootIds = allUnitIds.filter((id) => (edges.get(id) ?? null) === null);
  return computeMaxDepth(childrenByParent, rootIds);
}

/** History of hierarchy edges for one unit, newest first — bounded (`LIMIT 200`). */
export async function listHierarchyHistoryForUnit(
  tx: Bun.SQL,
  tenantId: string,
  unitId: string
): Promise<HierarchyEdgeRow[]> {
  const rows = (await tx`
    SELECT id, tenant_id, organization_unit_id, parent_organization_unit_id,
      effective_from, effective_to, reason
    FROM awcms_mini_organization_unit_hierarchies
    WHERE tenant_id = ${tenantId} AND organization_unit_id = ${unitId}
    ORDER BY effective_from DESC
    LIMIT 200
  `) as HierarchyEdgeDbRow[];

  return rows.map(toRow);
}
