/**
 * Organization-unit hierarchy domain rules (Issue #749, epic #738
 * platform-evolution Wave 2, ADR-0016). Pure functions only — no I/O, no
 * database — the actual current-parent adjacency map is read by
 * `application/organization-unit-hierarchy-service.ts` and passed in here.
 *
 * CRITICAL (issue #749 explicit warning: this epic has a confirmed
 * recurring "validator built but never wired to the real write path"
 * pattern across #746/#747). This file is ONLY the pure decision logic —
 * it is USELESS unless `organization-unit-hierarchy-service.ts` calls
 * `validateReparent` inside the SAME transaction as every real INSERT/
 * UPDATE against `awcms_mini_organization_unit_hierarchies`, after
 * acquiring the tenant-wide advisory lock and re-reading the current
 * adjacency map fresh. Grep that service file's own header for the
 * traceability note confirming every write path (create edge, reparent,
 * bulk import) calls this validator before committing.
 *
 * Cycle detection: setting `unitId`'s parent to `candidateParentId` would
 * create a cycle if and only if `candidateParentId` is already a
 * DESCENDANT of `unitId` in the CURRENT graph (equivalently: `unitId` is
 * already an ancestor of `candidateParentId`) — because after the change,
 * `unitId -> candidateParentId -> ... -> unitId` would be a closed loop.
 * Self-parent (`candidateParentId === unitId`) is checked separately as
 * the trivial, zero-hop case of the same disease.
 */

export type HierarchyEdgeMap = ReadonlyMap<string, string | null>;

export type HierarchyValidationError = {
  field: string;
  message: string;
  reason:
    | "self_parent"
    | "cycle"
    | "invalid_period"
    | "cross_tenant"
    | "max_depth_exceeded";
};

/**
 * Hard bound on how many hops any upward walk may take before it declares
 * the graph corrupted. Exported because `application/organization-unit-
 * hierarchy-service.ts`'s ancestor-chain recursive CTE must fetch AT LEAST
 * this many levels — if the SQL cap were tighter than this in-memory cap,
 * the walk would silently see a truncated chain and MISS a cycle instead of
 * reporting `max_depth_exceeded` (a false "no cycle" = hierarchy corruption,
 * which is exactly what `validateReparent` exists to prevent).
 */
export const MAX_ANCESTOR_WALK = 500;

/**
 * Walks UP from `startUnitId` following `edges` (unit -> current parent)
 * and returns `true` if `targetUnitId` is found anywhere in that ancestor
 * chain (including zero hops, i.e. `startUnitId === targetUnitId`).
 * Bounded by `MAX_ANCESTOR_WALK` — a corrupted graph (should be
 * impossible given this validator runs on every write) must never spin
 * this function forever; exceeding the bound is itself reported as an
 * error by `validateReparent` rather than silently truncating the walk.
 */
function isAncestorOf(
  edges: HierarchyEdgeMap,
  startUnitId: string,
  targetUnitId: string
): { found: boolean; depthExceeded: boolean } {
  let current: string | null = startUnitId;
  let steps = 0;

  while (current !== null) {
    if (current === targetUnitId) {
      return { found: true, depthExceeded: false };
    }
    if (steps >= MAX_ANCESTOR_WALK) {
      return { found: false, depthExceeded: true };
    }
    current = edges.get(current) ?? null;
    steps += 1;
  }

  return { found: false, depthExceeded: false };
}

export type ValidateReparentInput = {
  /** The unit whose parent is being set/changed. */
  unitId: string;
  /** `null` means "move to top-level, directly under the tenant". */
  candidateParentId: string | null;
  /**
   * Current (as-of "now") unit -> parent adjacency map, read fresh AFTER
   * the tenant-wide advisory lock is held.
   *
   * MINIMUM CONTRACT (Issue #834): this map must contain the complete
   * current ancestor chain of `candidateParentId`, up to at least
   * `MAX_ANCESTOR_WALK` hops. It may contain the whole tenant (read paths
   * still pass a full map, which trivially satisfies this) but does NOT
   * have to — `isAncestorOf` below only ever walks UPWARD from
   * `candidateParentId`, so entries outside that chain are never read.
   * `reparentUnit` exploits this to pass an ancestor-chain-only map fetched
   * with a recursive CTE, keeping the advisory lock's critical section
   * O(depth) instead of O(tenant size). A map that violates this contract
   * by truncating the chain early would make the walk terminate at a
   * missing entry and report NO cycle — the exact corruption this validator
   * exists to prevent — which is why the SQL depth cap is derived from
   * `MAX_ANCESTOR_WALK` rather than hardcoded independently.
   */
  currentEdges: HierarchyEdgeMap;
};

/**
 * Structural validation only (self-parent/cycle/max-depth) — tenant
 * ownership of `unitId`/`candidateParentId` and invalid-period checks are
 * separate concerns validated by the caller (existence/tenant-match needs
 * a DB read; period validity is checked against the caller-supplied
 * timestamps, see `validateEffectivePeriodForReparent` below) — kept
 * distinct so this function stays pure and testable with a plain
 * in-memory map, no database at all.
 */
export function validateReparent(
  input: ValidateReparentInput
): HierarchyValidationError[] {
  const errors: HierarchyValidationError[] = [];

  if (input.candidateParentId === null) {
    return errors;
  }

  if (input.candidateParentId === input.unitId) {
    errors.push({
      field: "parentOrganizationUnitId",
      message: "An organization unit cannot be its own parent.",
      reason: "self_parent"
    });
    return errors;
  }

  const ancestryCheck = isAncestorOf(
    input.currentEdges,
    input.candidateParentId,
    input.unitId
  );

  if (ancestryCheck.depthExceeded) {
    errors.push({
      field: "parentOrganizationUnitId",
      message:
        "Hierarchy depth exceeded while checking for a cycle — the existing graph may be corrupted.",
      reason: "max_depth_exceeded"
    });
    return errors;
  }

  if (ancestryCheck.found) {
    errors.push({
      field: "parentOrganizationUnitId",
      message:
        "This reparent would create a cycle: the candidate parent is currently a descendant of this unit.",
      reason: "cycle"
    });
  }

  return errors;
}

/**
 * Computes the ancestor chain (immediate parent first, root last) for
 * `unitId` from a current adjacency map — used both by the tree/as-of read
 * paths and by the `BusinessScopeHierarchyPort` adapter.
 */
export function computeAncestorChain(
  edges: HierarchyEdgeMap,
  unitId: string
): string[] {
  const chain: string[] = [];
  let current = edges.get(unitId) ?? null;
  let steps = 0;

  while (current !== null && steps < MAX_ANCESTOR_WALK) {
    chain.push(current);
    current = edges.get(current) ?? null;
    steps += 1;
  }

  return chain;
}

/**
 * MULTI-SOURCE downward closure: every unit in `seedUnitIds`, plus every
 * unit reachable downward from any of them at any depth — computed in ONE
 * traversal with a SINGLE SHARED `visited` set.
 *
 * The shared set is the whole point (Issue #834). The previous shape —
 * calling a single-seed `computeDescendants` once per seed — allocated a
 * FRESH `visited` set per call, so overlapping subtrees were re-walked once
 * per seed above them: O(S x depth), degenerating to O(U^2) on a deep chain
 * where every unit is a seed (a legal entity whose units are nested inside
 * one another — see `application/organization-structure-hierarchy-port-
 * adapter.ts`'s `resolveLegalEntityScope`, the caller that motivated this).
 * Sharing the set makes every node cost O(1) exactly once: O(U + E) total,
 * regardless of how many seeds there are or how they overlap.
 */
export function computeDescendantClosure(
  childrenByParent: ReadonlyMap<string, readonly string[]>,
  seedUnitIds: Iterable<string>
): string[] {
  const result: string[] = [];
  const visited = new Set<string>();
  const stack = [...seedUnitIds];

  while (stack.length > 0) {
    const next = stack.pop()!;
    if (visited.has(next)) {
      continue;
    }
    visited.add(next);
    result.push(next);
    for (const child of childrenByParent.get(next) ?? []) {
      stack.push(child);
    }
  }

  return result;
}

/**
 * Every descendant (any depth) of `unitId`, EXCLUDING `unitId` itself, from
 * a current adjacency map given as a children-lookup (`parentId ->
 * childIds[]`). Thin single-seed wrapper over `computeDescendantClosure`:
 * seeding with `unitId`'s direct children yields exactly its strict
 * descendants.
 */
export function computeDescendants(
  childrenByParent: ReadonlyMap<string, readonly string[]>,
  unitId: string
): string[] {
  return computeDescendantClosure(
    childrenByParent,
    childrenByParent.get(unitId) ?? []
  );
}

/** Maximum depth of the whole tenant's hierarchy forest (root = depth 0) — used for the `organization_structure_hierarchy_max_depth` metric. */
export function computeMaxDepth(
  childrenByParent: ReadonlyMap<string, readonly string[]>,
  rootUnitIds: readonly string[]
): number {
  let maxDepth = 0;

  function walk(unitId: string, depth: number, visiting: Set<string>): void {
    if (visiting.has(unitId) || depth > MAX_ANCESTOR_WALK) {
      // Defensive — should be unreachable given no-cycle enforcement, but
      // never loop forever over a corrupted graph while computing a
      // metric.
      return;
    }
    visiting.add(unitId);
    maxDepth = Math.max(maxDepth, depth);
    for (const child of childrenByParent.get(unitId) ?? []) {
      walk(child, depth + 1, visiting);
    }
    visiting.delete(unitId);
  }

  for (const rootId of rootUnitIds) {
    walk(rootId, 0, new Set());
  }

  return maxDepth;
}

export type ReparentEffectivePeriodInput = {
  effectiveFrom: Date;
  previousOpenEffectiveFrom: Date | null;
};

/**
 * "No overlapping invalid effective periods for the same unit" (issue
 * #749) — enforced structurally by ALWAYS closing/opening hierarchy edges
 * at the current server time (`now()`), never a client-supplied backdated
 * timestamp, so the only possible violation is clock skew across a
 * transaction boundary: a new edge's `effectiveFrom` must never be before
 * the previously-open edge's own `effectiveFrom` (which would imply a
 * negative-duration or overlapping period once the old one is closed at
 * the same instant).
 */
export function validateEffectivePeriodForReparent(
  input: ReparentEffectivePeriodInput
): HierarchyValidationError[] {
  const errors: HierarchyValidationError[] = [];

  if (
    input.previousOpenEffectiveFrom !== null &&
    input.effectiveFrom < input.previousOpenEffectiveFrom
  ) {
    errors.push({
      field: "effectiveFrom",
      message:
        "The new hierarchy edge's effectiveFrom must not precede the currently open edge's effectiveFrom.",
      reason: "invalid_period"
    });
  }

  return errors;
}
