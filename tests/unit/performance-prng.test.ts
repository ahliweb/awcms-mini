/**
 * Unit tests for the deterministic seeded PRNG (Issue #744, epic #738).
 * Pure, no I/O — the whole performance suite's reproducibility guarantee
 * ("Synthetic dataset generation is deterministic") rests on this module.
 */
import { describe, expect, test } from "bun:test";

import {
  createPrng,
  deterministicUuid,
  hashSeed
} from "../../src/lib/performance/prng";

describe("hashSeed", () => {
  test("is deterministic for the same input", () => {
    expect(hashSeed("safe:tenant:3")).toBe(hashSeed("safe:tenant:3"));
  });

  test("differs for different inputs", () => {
    expect(hashSeed("safe:tenant:3")).not.toBe(hashSeed("safe:tenant:4"));
  });
});

describe("createPrng", () => {
  test("the same numeric seed always produces the same sequence", () => {
    const a = createPrng(42);
    const b = createPrng(42);

    const sequenceA = Array.from({ length: 10 }, () => a.next());
    const sequenceB = Array.from({ length: 10 }, () => b.next());

    expect(sequenceA).toEqual(sequenceB);
  });

  test("the same string seed always produces the same sequence", () => {
    const a = createPrng("safe:tenant:0:audit");
    const b = createPrng("safe:tenant:0:audit");

    expect(a.nextInt(0, 1_000_000)).toBe(b.nextInt(0, 1_000_000));
  });

  test("different seeds produce different sequences", () => {
    const a = createPrng("seed-a");
    const b = createPrng("seed-b");

    expect(a.next()).not.toBe(b.next());
  });

  test("next() stays within [0, 1)", () => {
    const prng = createPrng("range-check");

    for (let i = 0; i < 1000; i++) {
      const value = prng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  test("nextInt is inclusive of both bounds and never exceeds them", () => {
    const prng = createPrng("bounds-check");
    const seen = new Set<number>();

    for (let i = 0; i < 500; i++) {
      const value = prng.nextInt(5, 8);
      expect(value).toBeGreaterThanOrEqual(5);
      expect(value).toBeLessThanOrEqual(8);
      seen.add(value);
    }

    // With 500 draws over a 4-value range, every value should appear at
    // least once — a sanity check against a degenerate (e.g. always-0)
    // implementation slipping through.
    expect(seen.size).toBe(4);
  });

  test("nextInt throws when max < min", () => {
    const prng = createPrng("invalid-range");
    expect(() => prng.nextInt(10, 1)).toThrow();
  });

  test("pick only returns elements from the given array", () => {
    const prng = createPrng("pick-check");
    const items = ["a", "b", "c"] as const;

    for (let i = 0; i < 100; i++) {
      expect(items).toContain(prng.pick(items));
    }
  });

  test("pick throws on an empty array", () => {
    const prng = createPrng("empty-pick");
    expect(() => prng.pick([])).toThrow();
  });

  test("hex produces the requested length of lowercase hex characters", () => {
    const prng = createPrng("hex-check");
    const value = prng.hex(40);

    expect(value).toHaveLength(40);
    expect(value).toMatch(/^[0-9a-f]+$/);
  });
});

describe("deterministicUuid", () => {
  test("produces a UUID-shaped string", () => {
    const uuid = deterministicUuid(createPrng("uuid-check"));
    expect(uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  test("is deterministic for the same seed", () => {
    expect(deterministicUuid(createPrng("same-seed"))).toBe(
      deterministicUuid(createPrng("same-seed"))
    );
  });

  test("differs across successive draws from the same stream", () => {
    const prng = createPrng("stream");
    const first = deterministicUuid(prng);
    const second = deterministicUuid(prng);

    expect(first).not.toBe(second);
  });
});
