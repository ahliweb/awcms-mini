/**
 * Pure unit tests for `organization-structure/domain/organization-unit-
 * hierarchy.ts` (Issue #749). These exercise the DECISION LOGIC in
 * isolation (no database) — the transactional wiring that actually
 * enforces this on every real write path is covered separately by
 * `tests/integration/organization-structure.integration.test.ts`'s
 * adversarial cycle tests through the real HTTP reparent endpoint (per
 * this epic's own recurring "validator built but never wired" warning,
 * a pure unit test alone is NOT sufficient evidence the guard is real).
 */
import { describe, expect, test } from "bun:test";
import {
  computeAncestorChain,
  computeDescendantClosure,
  computeDescendants,
  computeMaxDepth,
  validateEffectivePeriodForReparent,
  validateReparent,
  type HierarchyEdgeMap
} from "../../src/modules/organization-structure/domain/organization-unit-hierarchy";

describe("validateReparent", () => {
  test("allows moving a unit to top-level (parent = null)", () => {
    const errors = validateReparent({
      unitId: "unit-a",
      candidateParentId: null,
      currentEdges: new Map()
    });
    expect(errors).toEqual([]);
  });

  test("rejects self-parent", () => {
    const errors = validateReparent({
      unitId: "unit-a",
      candidateParentId: "unit-a",
      currentEdges: new Map()
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.reason).toBe("self_parent");
  });

  test("rejects a direct cycle (A is currently B's parent, try to make B the parent of A)", () => {
    const edges: HierarchyEdgeMap = new Map([["unit-b", "unit-a"]]);
    const errors = validateReparent({
      unitId: "unit-a",
      candidateParentId: "unit-b",
      currentEdges: edges
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.reason).toBe("cycle");
  });

  test("rejects a transitive cycle (A -> B -> C, try to make C the parent of A)", () => {
    const edges: HierarchyEdgeMap = new Map([
      ["unit-b", "unit-a"],
      ["unit-c", "unit-b"]
    ]);
    const errors = validateReparent({
      unitId: "unit-a",
      candidateParentId: "unit-c",
      currentEdges: edges
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.reason).toBe("cycle");
  });

  test("allows a legitimate reparent that does not create a cycle", () => {
    const edges: HierarchyEdgeMap = new Map([
      ["unit-b", "unit-a"],
      ["unit-c", null]
    ]);
    const errors = validateReparent({
      unitId: "unit-b",
      candidateParentId: "unit-c",
      currentEdges: edges
    });
    expect(errors).toEqual([]);
  });

  test("reports max_depth_exceeded instead of hanging forever on a corrupted graph", () => {
    // Build a 600-long chain (deliberately over MAX_ANCESTOR_WALK) so
    // walking from the candidate parent upward never terminates via
    // `null` before the bound kicks in.
    const edges = new Map<string, string | null>();
    for (let i = 1; i <= 600; i += 1) {
      edges.set(`unit-${i}`, `unit-${i - 1}`);
    }
    const errors = validateReparent({
      unitId: "unit-0",
      candidateParentId: "unit-600",
      currentEdges: edges
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.reason).toBe("max_depth_exceeded");
  });
});

describe("computeAncestorChain", () => {
  test("returns immediate parent first, root last", () => {
    const edges: HierarchyEdgeMap = new Map([
      ["unit-c", "unit-b"],
      ["unit-b", "unit-a"],
      ["unit-a", null]
    ]);
    expect(computeAncestorChain(edges, "unit-c")).toEqual(["unit-b", "unit-a"]);
  });

  test("returns an empty chain for a top-level unit", () => {
    const edges: HierarchyEdgeMap = new Map([["unit-a", null]]);
    expect(computeAncestorChain(edges, "unit-a")).toEqual([]);
  });
});

describe("computeDescendants", () => {
  test("returns every descendant at any depth", () => {
    const childrenByParent = new Map<string, readonly string[]>([
      ["unit-a", ["unit-b", "unit-c"]],
      ["unit-b", ["unit-d"]]
    ]);
    const descendants = computeDescendants(childrenByParent, "unit-a");
    expect(new Set(descendants)).toEqual(
      new Set(["unit-b", "unit-c", "unit-d"])
    );
  });

  test("returns an empty array for a leaf unit", () => {
    const childrenByParent = new Map<string, readonly string[]>();
    expect(computeDescendants(childrenByParent, "unit-z")).toEqual([]);
  });
});

describe("computeDescendantClosure (Issue #834)", () => {
  test("includes the seeds themselves plus every unit reachable downward", () => {
    const childrenByParent = new Map<string, readonly string[]>([
      ["unit-a", ["unit-b"]],
      ["unit-b", ["unit-c"]],
      ["unit-x", ["unit-y"]]
    ]);
    expect(
      new Set(computeDescendantClosure(childrenByParent, ["unit-a", "unit-x"]))
    ).toEqual(new Set(["unit-a", "unit-b", "unit-c", "unit-x", "unit-y"]));
  });

  test("emits every unit exactly once when seed subtrees overlap", () => {
    // `unit-b` is BOTH a seed and a descendant of the seed `unit-a`.
    const childrenByParent = new Map<string, readonly string[]>([
      ["unit-a", ["unit-b"]],
      ["unit-b", ["unit-c"]]
    ]);
    const closure = computeDescendantClosure(childrenByParent, [
      "unit-a",
      "unit-b",
      "unit-c"
    ]);
    expect(closure.length).toBe(new Set(closure).size);
    expect(new Set(closure)).toEqual(new Set(["unit-a", "unit-b", "unit-c"]));
  });

  test("no seed re-walks another seed's subtree: total work stays linear, not quadratic", () => {
    // THE regression this function exists to prevent (Issue #834). The old
    // shape — one fresh-`visited`-set `computeDescendants` call per seed —
    // re-walked every shared subtree once per seed above it. On this shape
    // (a 200-deep chain where EVERY unit declares the same legal entity, so
    // every unit is a seed) that is ~200*200/2 = ~20_000 lookups; the shared
    // multi-source traversal does ~200.
    //
    // Asserted by COUNTING lookups, not by timing — a wall-clock assertion
    // would be flaky, and the point is the complexity class, not the speed.
    const depth = 200;
    const backing = new Map<string, readonly string[]>();
    const seeds: string[] = [];
    for (let index = 0; index < depth; index += 1) {
      seeds.push(`unit-${index}`);
      if (index > 0) {
        backing.set(`unit-${index - 1}`, [`unit-${index}`]);
      }
    }

    let lookups = 0;
    const counting: ReadonlyMap<string, readonly string[]> = {
      ...backing,
      get(key: string) {
        lookups += 1;
        return backing.get(key);
      }
    } as unknown as ReadonlyMap<string, readonly string[]>;

    const closure = computeDescendantClosure(counting, seeds);

    expect(new Set(closure).size).toBe(depth);
    // Linear bound with generous headroom: one lookup per node visited.
    // The quadratic shape blows through this by two orders of magnitude.
    expect(lookups).toBeLessThanOrEqual(depth * 2);
  });
});

describe("computeMaxDepth", () => {
  test("computes the deepest chain across a forest of roots", () => {
    const childrenByParent = new Map<string, readonly string[]>([
      ["unit-a", ["unit-b"]],
      ["unit-b", ["unit-c"]],
      ["unit-x", []]
    ]);
    expect(computeMaxDepth(childrenByParent, ["unit-a", "unit-x"])).toBe(2);
  });

  test("returns 0 for a forest of only top-level units", () => {
    const childrenByParent = new Map<string, readonly string[]>();
    expect(computeMaxDepth(childrenByParent, ["unit-a", "unit-b"])).toBe(0);
  });
});

describe("validateEffectivePeriodForReparent", () => {
  test("accepts a new effectiveFrom at or after the previously open edge's effectiveFrom", () => {
    const previous = new Date("2026-01-01T00:00:00Z");
    const errors = validateEffectivePeriodForReparent({
      effectiveFrom: new Date("2026-02-01T00:00:00Z"),
      previousOpenEffectiveFrom: previous
    });
    expect(errors).toEqual([]);
  });

  test("rejects a new effectiveFrom before the previously open edge's effectiveFrom", () => {
    const previous = new Date("2026-02-01T00:00:00Z");
    const errors = validateEffectivePeriodForReparent({
      effectiveFrom: new Date("2026-01-01T00:00:00Z"),
      previousOpenEffectiveFrom: previous
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.reason).toBe("invalid_period");
  });

  test("accepts any effectiveFrom when there is no previously open edge", () => {
    const errors = validateEffectivePeriodForReparent({
      effectiveFrom: new Date("2020-01-01T00:00:00Z"),
      previousOpenEffectiveFrom: null
    });
    expect(errors).toEqual([]);
  });
});
