/**
 * Cardinality-preserving pseudonymization of a `unique_count` meter's distinct
 * key (Issue #902 L2, epic #868, ADR-0022 §3/§8). NOT pure — reads the process
 * secret per call.
 *
 * The domain (`domain/usage-event.ts`) already forbids a raw payload as the
 * distinct key (charset gate). This adds the second, decisive control: for a
 * meter whose #874 `privacyClassification` is NOT `non_personal` (i.e.
 * `pseudonymous` or `personal`), the write path replaces the caller-supplied
 * distinct key with a keyed HMAC-SHA256 hex digest BEFORE it is persisted to
 * `awcms_mini_usage_events.unique_dimension`, so an email/handle a producer used
 * as the distinct key is never stored verbatim (and never leaks through the
 * `listUsageEvents` DTO). The mapping is deterministic — the SAME input always
 * yields the SAME digest — so the distinct-count a `unique_count` meter measures
 * is preserved exactly (the hash is a stable pseudonym, not a random token).
 *
 * KEY REUSE + DOMAIN SEPARATION. Keyed with `AUTH_JWT_SECRET`, the same required,
 * non-default-enforced secret `src/lib/security/client-fingerprint.ts` keys the
 * audit `ipHash` with — provisioning a second internal pseudonymization secret
 * to rotate and validate would be pure overhead with nothing to separate FROM
 * (that secret signs nothing else; see the rationale in client-fingerprint.ts).
 * To keep this pseudonym's output space DISJOINT from the ipHash's (so the two
 * derived values can never be correlated or cross-checked), the HMAC input is
 * prefixed with a fixed context label — domain separation on the INPUT, distinct
 * from client-fingerprint's output prefix.
 *
 * Read per call (never cached at module load), exactly like `resolveIpHashKey`,
 * so a rotated secret — or a test that sets `process.env.AUTH_JWT_SECRET` — takes
 * effect immediately. Throws rather than degrading to an unkeyed digest (an empty
 * key would make every persisted pseudonym reversible), and rejects the published
 * `.env.example` placeholder for the same reason client-fingerprint does.
 */
import { createHmac } from "node:crypto";

import { findConfigVarEntry } from "../../../lib/config/registry";

/**
 * Domain-separation context prefixed to the HMAC INPUT so this pseudonym's
 * output never shares a space with any other `AUTH_JWT_SECRET`-keyed digest
 * (e.g. the audit `ipHash`, which prefixes its OUTPUT instead).
 */
const DOMAIN_SEPARATION = "usage-unique-dimension:";

function resolveUniqueDimensionKey(): string {
  const key = process.env.AUTH_JWT_SECRET;

  if (key === undefined || key.length === 0) {
    throw new Error(
      "AUTH_JWT_SECRET is required: it keys the usage_metering unique_dimension pseudonym HMAC (src/modules/usage-metering/application/unique-dimension-pseudonym.ts). Refusing to fall back to an unkeyed digest, which would make every persisted pseudonym reversible."
    );
  }

  const placeholder = findConfigVarEntry("AUTH_JWT_SECRET")?.default;
  if (placeholder !== undefined && key === placeholder) {
    throw new Error(
      "AUTH_JWT_SECRET is still the documented .env.example placeholder: it keys the usage_metering unique_dimension pseudonym HMAC, and that placeholder is published in a public repo. Refusing to key the pseudonym with public knowledge. Set a high-entropy secret, then re-run `bun run config:validate`."
    );
  }

  return key;
}

/**
 * Cardinality-preserving pseudonym for a `unique_count` distinct key: a stable,
 * non-reversible HMAC-SHA256 hex digest (64 chars — satisfies the column's 1..200
 * length CHECK and the domain charset). Same input -> same digest, so distinct
 * counts are unchanged.
 */
export function pseudonymizeUniqueDimension(rawDistinctKey: string): string {
  return createHmac("sha256", resolveUniqueDimensionKey())
    .update(DOMAIN_SEPARATION + rawDistinctKey)
    .digest("hex");
}
