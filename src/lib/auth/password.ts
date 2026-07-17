export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password);
}

export function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return Bun.password.verify(password, hash);
}

/**
 * A throwaway secret that only ever exists to be hashed once, so
 * `verifyPasswordOrDummy` has something argon2id-shaped to burn a verify
 * against when there is no real hash. Randomized per process purely as
 * defense in depth: the verify result on that path is discarded
 * unconditionally (see below), so even a caller who knew this value could
 * not turn it into a login.
 */
const DUMMY_PASSWORD_SOURCE = crypto.randomUUID();

let dummyPasswordHashPromise: Promise<string> | null = null;

/**
 * Produced by `hashPassword` itself rather than by a hardcoded literal, so
 * the dummy carries byte-for-byte the same argon2id parameters (algorithm,
 * memory cost, time cost) as every real `awcms_mini_identities.password_hash`
 * this deployment writes — that parameter match is the entire point, since
 * verification cost is a function of the parameters encoded in the hash. A
 * pinned literal would silently stop matching the moment Bun's defaults moved,
 * re-opening the very gap this closes.
 *
 * Computed lazily and memoized: at most one extra hash per process, on the
 * first unknown identifier seen, instead of an ~80 ms hash on every boot.
 */
function getDummyPasswordHash(): Promise<string> {
  dummyPasswordHashPromise ??= hashPassword(DUMMY_PASSWORD_SOURCE);

  return dummyPasswordHashPromise;
}

/**
 * Issue #840 — verifies `password` against `hash`, or, when `hash` is `null`
 * (no such identity), performs an equivalent argon2id verification against a
 * dummy hash and returns `false`.
 *
 * WHY: `POST /auth/login` used to skip `verifyPassword` entirely for an
 * unknown `loginIdentifier` (`identityRow ? await verifyPassword(...) :
 * false`). Measured on this repo's own integration harness, that made an
 * unknown identifier answer in a median of **4.1 ms** against **80.1 ms** for
 * a known one — a ~19x gap, which is a far cheaper and more reliable account
 * enumeration oracle than any response-body difference: one request, no
 * lockout to trip, default configuration, every deployment. Collapsing the
 * response bodies alone (the rest of Issue #840) would have left it wide open.
 *
 * The dummy-verify result is discarded rather than returned: this function
 * must answer `false` for a nonexistent identity even in the impossible case
 * that `password` collided with `DUMMY_PASSWORD_SOURCE`. `hash === null` is
 * the ONLY thing that selects this path — never a property of `password` — so
 * the work performed does not vary with attacker-controlled input.
 *
 * This equalizes the dominant cost (the KDF), not every last instruction: the
 * caller still skips a couple of identity-scoped SELECTs for an unknown
 * identifier. Those are ~1-2 ms of loopback Postgres against an ~80-90 ms
 * hash, and they do not surface above the noise — measured on the same
 * harness after this change, known 90.29 ms vs unknown 90.46 ms (ratio
 * 1.002, medians of 8 interleaved samples), against 80.13 vs 4.13 (ratio
 * 0.052) before. Not a constant-time proof, and not claimed as one: a
 * motivated attacker with enough samples may still resolve a sub-millisecond
 * difference. See tests/integration/login-enumeration.integration.test.ts.
 */
export async function verifyPasswordOrDummy(
  password: string,
  hash: string | null
): Promise<boolean> {
  if (hash === null) {
    await verifyPassword(password, await getDummyPasswordHash());

    return false;
  }

  return verifyPassword(password, hash);
}
