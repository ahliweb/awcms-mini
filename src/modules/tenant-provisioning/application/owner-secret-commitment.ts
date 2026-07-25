/**
 * Keyed commitment to the request-time owner password for
 * `computeProvisioningInputsHash` (CodeQL alerts #63/#64, epic #868). NOT pure —
 * reads the process secret per call.
 *
 * WHY A COMMITMENT EXISTS AT ALL. `POST /api/v1/tenant-provisioning/requests`
 * binds its `Idempotency-Key` to a hash of the whole request payload, so that
 * replaying a key with a DIFFERENT payload is a clean 409 instead of a silent
 * second tenant. The owner password is part of that payload: a retry that keeps
 * the key but changes the password must NOT be answered with a cheerful replay
 * of the original 201, because the caller would then believe a password took
 * effect that never did. Dropping the password from the hash would trade a
 * cracking oracle for a correctness hole, so the password stays represented —
 * but represented by something an attacker cannot invert.
 *
 * WHY THE PREVIOUS `sha256(password)` WAS A REAL WEAKNESS, not a CodeQL
 * false positive. The digest was folded into `inputs_hash`, which is persisted
 * twice: on `awcms_mini_tenant_provisioning_requests` and as the generic
 * idempotency store's `request_hash`. Every OTHER field feeding that outer
 * digest is recoverable by the same reader — `tenantCode`/`tenantName`/`options`
 * sit in the adjacent `inputs` jsonb, and `ownerLoginIdentifier`, `legalName`,
 * `officeCode`, `officeName`, `ownerDisplayName` are all readable from the
 * identity/tenant/office tables the same provisioning run wrote. So anyone with
 * database READ access could enumerate password guesses at two unsalted SHA-256
 * per guess and confirm a hit against a stored column. That is an offline
 * cracking oracle for a tenant's INITIAL ADMINISTRATOR password, reachable
 * without any write privilege — exactly what CodeQL's
 * `js/insufficient-password-hash` describes, and the reason this is fixed rather
 * than dismissed.
 *
 * WHY SCRYPT KEYED BY A PEPPER, AND NOT ARGON2ID OR A BARE HMAC. Real
 * credentials are stored by `src/lib/auth/password.ts` with
 * `Bun.password.hash` (argon2id) and that is untouched. Argon2id cannot be
 * used HERE because this value must be DETERMINISTIC and recomputable from the
 * request body alone on every replay, and argon2id generates a fresh random
 * salt per call, so it could never be compared for equality.
 *
 * scrypt with a FIXED salt is deterministic, and that fixed salt is the
 * process pepper — which buys both properties at once:
 *
 *   - Keyed: the pepper lives in the process environment, never in a column,
 *     so database read access alone cannot reproduce a digest from a guess.
 *   - Costly: even if the pepper leaks (an env dump, a crash log), each guess
 *     costs a full scrypt derivation instead of a SHA-256, so the leak
 *     degrades to a slow attack rather than an instant one.
 *
 * A bare HMAC-SHA256 would give the first property but not the second, and
 * would leave the pepper as a single point of failure.
 *
 * The cost parameters are pinned explicitly rather than left to Node's
 * defaults: this digest is PERSISTED and compared on replay, so a runtime
 * changing its default N/r/p would silently invalidate every stored
 * `inputs_hash`. Measured at ~30 ms per derivation on the development machine.
 * `POST /api/v1/tenant-provisioning/requests` derives twice (once for the
 * idempotency record, once inside the engine), so it pays ~60 ms — against an
 * operation that already runs an argon2id hash for the owner credential and
 * creates a tenant, owner, office, settings, and every step row in one
 * transaction. Async rather than `scryptSync` so that cost is never paid on
 * the event loop.
 *
 * KEY REUSE + DOMAIN SEPARATION. Keyed with `AUTH_JWT_SECRET`, the same
 * required, non-default-enforced secret that keys the audit `ipHash`
 * (`src/lib/security/client-fingerprint.ts`) and the `usage_metering`
 * unique-dimension pseudonym — see the rationale in client-fingerprint.ts for
 * why a second internal pseudonymization secret would be pure operational
 * overhead with nothing to separate FROM. The salt carries a fixed context
 * label alongside the pepper so this commitment's output space stays disjoint
 * from those two, and no derived value can be correlated or cross-checked
 * against them.
 *
 * Read per call, never cached at module load, so a rotated secret — or a test
 * that sets `process.env.AUTH_JWT_SECRET` — takes effect immediately. Throws
 * rather than degrading to an unkeyed digest, because an empty key would
 * silently restore the exact oracle this module exists to remove.
 */
import { scrypt, type ScryptOptions } from "node:crypto";

import { findConfigVarEntry } from "../../../lib/config/registry";

/**
 * Hand-wrapped rather than `promisify(scrypt)`: promisify collapses to the
 * three-argument overload, which silently drops the pinned cost parameters
 * below and would derive with Node's defaults instead.
 */
function deriveScrypt(
  secret: string,
  salt: string,
  keyLength: number,
  options: ScryptOptions
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, keyLength, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

/**
 * Domain-separation context prefixed to the SALT so this commitment never
 * shares an output space with another `AUTH_JWT_SECRET`-keyed digest (the audit
 * `ipHash` prefixes its output; the usage-metering pseudonym prefixes its HMAC
 * input with a different label).
 */
const DOMAIN_SEPARATION = "tenant-provisioning-owner-secret:";

/**
 * Pinned scrypt cost parameters. Persisted digests are compared on replay, so
 * these must never drift with a runtime default. `maxmem` is raised because
 * Node's 32 MB default rejects N=16384/r=8 outright.
 */
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SCRYPT_KEY_LENGTH = 32;

function resolveOwnerSecretCommitmentKey(): string {
  const key = process.env.AUTH_JWT_SECRET;

  if (key === undefined || key.length === 0) {
    throw new Error(
      "AUTH_JWT_SECRET is required: it keys the tenant_provisioning owner-secret commitment (src/modules/tenant-provisioning/application/owner-secret-commitment.ts). Refusing to fall back to an unkeyed digest, which would make every persisted inputs_hash an offline cracking oracle for the tenant owner's initial password."
    );
  }

  const placeholder = findConfigVarEntry("AUTH_JWT_SECRET")?.default;
  if (placeholder !== undefined && key === placeholder) {
    throw new Error(
      "AUTH_JWT_SECRET is still the documented .env.example placeholder: it keys the tenant_provisioning owner-secret commitment, and that placeholder is published in a public repo. Keying with public knowledge would leave every persisted inputs_hash brute-forceable. Set a high-entropy secret, then re-run `bun run config:validate`."
    );
  }

  return key;
}

/**
 * Stable, non-invertible commitment to a request-time owner secret: a
 * scrypt-derived hex digest, salted with the domain-separated process pepper.
 * Same input -> same digest, so idempotent replay detection is unchanged;
 * without the pepper the digest cannot be reproduced from a guess, and even
 * with it each guess costs a full scrypt derivation.
 */
export async function commitOwnerSecret(rawSecret: string): Promise<string> {
  const derived = await deriveScrypt(
    rawSecret,
    DOMAIN_SEPARATION + resolveOwnerSecretCommitmentKey(),
    SCRYPT_KEY_LENGTH,
    SCRYPT_PARAMS
  );

  return derived.toString("hex");
}
