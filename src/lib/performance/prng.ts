/**
 * Deterministic seeded PRNG (Issue #744, epic #738 platform-evolution).
 * Every synthetic fixture generator in this directory MUST derive all of
 * its randomness from this module — never `Math.random()`, never
 * `crypto.randomUUID()` — so that the same `(scaleProfile, seed)` pair
 * always produces byte-identical fixture data across runs/machines. That
 * determinism is a hard acceptance-criterion requirement ("Synthetic
 * dataset generation is deterministic, configurable...") and is also what
 * makes the query-plan regression fixture reproducible: a "deliberately
 * introduced regression" only proves anything if the same seed always
 * reproduces the same table shape.
 *
 * Algorithm: mulberry32 — a small, fast, public-domain 32-bit PRNG. Not
 * cryptographically secure (irrelevant here: this only ever generates
 * synthetic, non-secret fixture data, never a real credential/token), but
 * has good statistical distribution for generating varied fixture shapes
 * and is trivially deterministic across every runtime.
 */

export type Prng = {
  /** Next float in [0, 1). */
  next(): number;
  /** Next integer in [min, max] inclusive. */
  nextInt(min: number, max: number): number;
  /** Picks one element deterministically from a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /** Returns `true` with probability `probability` (0..1). */
  chance(probability: number): boolean;
  /** Deterministic lowercase hex string of `length` characters. */
  hex(length: number): string;
};

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Hashes an arbitrary string seed (e.g. `"safe:tenant:3"`) into a 32-bit
 * integer seed for `mulberry32` — lets callers derive many independent,
 * deterministic sub-streams (one per tenant, one per table) from a single
 * top-level numeric/string seed without ever reseeding from wall-clock time.
 * FNV-1a, chosen for being tiny and dependency-free, not for cryptographic
 * properties (same non-secret-data rationale as the module header).
 */
export function hashSeed(input: string): number {
  let hash = 0x811c9dc5;

  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }

  return hash >>> 0;
}

export function createPrng(seed: number | string): Prng {
  const numericSeed = typeof seed === "string" ? hashSeed(seed) : seed >>> 0;
  const random = mulberry32(numericSeed);

  const prng: Prng = {
    next: random,
    nextInt(min, max) {
      if (max < min) {
        throw new Error(`nextInt: max (${max}) must be >= min (${min}).`);
      }
      return min + Math.floor(random() * (max - min + 1));
    },
    pick(items) {
      if (items.length === 0) {
        throw new Error("pick: items must be non-empty.");
      }
      return items[prng.nextInt(0, items.length - 1)] as (typeof items)[number];
    },
    chance(probability) {
      return random() < probability;
    },
    hex(length) {
      let out = "";
      while (out.length < length) {
        out += Math.floor(random() * 16).toString(16);
      }
      return out.slice(0, length);
    }
  };

  return prng;
}

/**
 * Deterministic, RFC-4122-*shaped* (version nibble fixed to "4", variant
 * nibble fixed to one of 8/9/a/b) UUID string derived from a PRNG stream —
 * NOT a cryptographically random UUID (`crypto.randomUUID()` would break
 * determinism). Only ever used to populate synthetic fixture rows, never a
 * real identity/session/security token.
 */
export function deterministicUuid(prng: Prng): string {
  const hex = prng.hex(30);
  const variantNibble = "89ab"[prng.nextInt(0, 3)];

  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(12, 15)}-` +
    `${variantNibble}${hex.slice(15, 18)}-${hex.slice(18, 30)}`
  );
}
