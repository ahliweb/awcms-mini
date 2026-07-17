/**
 * Organization-unit hierarchy service (Issue #749, epic #738
 * platform-evolution Wave 2, ADR-0016) — the transactional writer for
 * `awcms_mini_organization_unit_hierarchies`.
 *
 * TRACEABILITY (issue #749 explicit warning — "validator built but never
 * wired to the real write path" has recurred across #746/#747 in this
 * epic): `reparentUnit` below is the ONLY function in this module that
 * INSERTs/UPDATEs `awcms_mini_organization_unit_hierarchies`, and the
 * `POST /api/v1/organization-structure/hierarchy/reparent` route is the
 * ONLY caller — there is no separate "initial parent on unit create" path
 * (`createOrganizationUnit` never writes a hierarchy edge; a newly created
 * unit starts top-level/unparented until an explicit reparent call) and no
 * "bulk import" path in this issue (seed/import hooks are documented as
 * future, optional, `data_exchange`-contract work, issue #749 scope). This
 * single call site, in order:
 *   1. Re-validates `unitId`/`candidateParentId` belong to THIS tenant and
 *      are not soft-deleted (cross-tenant/soft-deleted references
 *      rejected).
 *   2. Acquires a TENANT-WIDE `pg_advisory_xact_lock` — this is what
 *      closes the race between two concurrent reparents of DIFFERENT
 *      units that together would form a cycle (row-level locking alone
 *      cannot catch that, since the two writes touch different rows).
 *      The lock auto-releases at transaction end (commit or rollback).
 *   3. Re-reads the current (`effective_to IS NULL`) adjacency map, fresh,
 *      now that the lock is held — specifically the candidate parent's
 *      ancestor chain via `readAncestorChainEdgeMap`'s recursive CTE, which
 *      is the only part of the map the cycle check can read (Issue #834;
 *      this used to be a whole-tenant `readEdgeMap`, making the critical
 *      section scale with tenant SIZE rather than hierarchy DEPTH). Still
 *      read strictly AFTER the lock — that ordering is the race fix.
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
  MAX_ANCESTOR_WALK,
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
 * The CURRENT (`effective_to IS NULL`) unit -> parent edges along the
 * ancestor chain of `startUnitId` ONLY — `startUnitId`'s own edge, its
 * parent's edge, its grandparent's edge, and so on up to the root — as a
 * `HierarchyEdgeMap` shaped exactly like `readEdgeMap`'s, just narrower.
 *
 * WHY THIS EXISTS (Issue #834). `reparentUnit` must read the adjacency map
 * AFTER taking the tenant-wide `pg_advisory_xact_lock` (reading before the
 * lock would reintroduce the very race the lock closes). It used to call
 * `readEdgeMap`, pulling EVERY edge in the tenant inside that critical
 * section — so reparent throughput per tenant degraded linearly with the
 * TENANT'S SIZE rather than with its hierarchy DEPTH, which is the only
 * thing the cycle check actually depends on.
 *
 * `validateReparent` only ever calls `isAncestorOf(edges, candidateParentId,
 * unitId)`, which walks strictly UPWARD from `candidateParentId`. It can
 * therefore never read an entry outside that chain, so this narrower map
 * yields a bit-for-bit identical verdict while touching O(depth) rows
 * instead of O(tenant). The lock itself, and the read-fresh-under-the-lock
 * ordering, are UNCHANGED — only the amount of work inside the lock shrinks.
 *
 * This is the repo's FIRST and (today) ONLY recursive CTE. The prevailing
 * "one bulk query loads the whole tenant adjacency, walk it in memory"
 * pattern is genuinely right everywhere else — those are unlocked read
 * paths where the full map is the actual answer being computed. It is wrong
 * *here* specifically because this read sits inside a tenant-wide lock and
 * needs a single root-ward path, so the bulk read's cost is pure contention
 * with no compensating benefit. Do not cargo-cult it into the read paths.
 *
 * NO NEW INDEX/MIGRATION IS NEEDED: each recursive step is a point lookup on
 * `(tenant_id, organization_unit_id)`, already served by sql/063's existing
 * indexes — `EXPLAIN ANALYZE` at 10k units confirms a Nested Loop driving an
 * Index Scan per level (the planner picks `..._unit_history_idx`; the
 * partial `..._current_key` covers the same predicate), no sequential scan.
 *
 * DEPTH CAP: bounded at `MAX_ANCESTOR_WALK + 1` levels, one MORE than the
 * in-memory walk's own bound, so a corrupted (cyclic) graph terminates the
 * recursion here while still handing `isAncestorOf` enough rows to reach its
 * own limit and report `max_depth_exceeded`. Capping BELOW the in-memory
 * bound would truncate the chain into a false "no cycle" verdict.
 */
export async function readAncestorChainEdgeMap(
  tx: Bun.SQL,
  tenantId: string,
  startUnitId: string
): Promise<HierarchyEdgeMap> {
  const rows = (await tx`
    WITH RECURSIVE ancestor_chain AS (
      SELECT h.organization_unit_id, h.parent_organization_unit_id, 1 AS depth
      FROM awcms_mini_organization_unit_hierarchies h
      WHERE h.tenant_id = ${tenantId}
        AND h.organization_unit_id = ${startUnitId}
        AND h.effective_to IS NULL
      UNION ALL
      SELECT h.organization_unit_id, h.parent_organization_unit_id, chain.depth + 1
      FROM awcms_mini_organization_unit_hierarchies h
      JOIN ancestor_chain chain
        ON h.organization_unit_id = chain.parent_organization_unit_id
      WHERE h.tenant_id = ${tenantId}
        AND h.effective_to IS NULL
        AND chain.depth <= ${MAX_ANCESTOR_WALK}
    )
    SELECT organization_unit_id, parent_organization_unit_id FROM ancestor_chain
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
  // reading the adjacency map used for cycle validation below: reading it
  // BEFORE the lock (or revalidating an optimistically pre-fetched map) is
  // exactly the race this lock exists to close, so the read stays here,
  // inside the critical section. Issue #834 only shrank WHAT is read (the
  // candidate parent's ancestor chain, O(depth)) from the whole tenant's
  // edge map (O(tenant size)) — the lock, and this ordering, are unchanged.
  await acquireHierarchyAdvisoryLock(tx, tenantId);

  // `null` (move to top-level) can never create a cycle, so `validateReparent`
  // returns early without reading the map at all — skip the query entirely.
  const currentEdges: HierarchyEdgeMap =
    candidateParentId === null
      ? new Map()
      : await readAncestorChainEdgeMap(tx, tenantId, candidateParentId);

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
