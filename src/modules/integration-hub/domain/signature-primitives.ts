import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Shared HMAC/timing-safe primitives (Issue #754). Mirrors `sync-storage/
 * domain/sync-hmac.ts`'s established pattern EXACTLY (this repo's own
 * precedent for "how HMAC verification is done here") — a fixed-length
 * check before `timingSafeEqual` (which throws on mismatched buffer
 * lengths rather than returning `false`), and `node:crypto`'s
 * `timingSafeEqual` itself (never `===`/`==` on the computed vs provided
 * signature — a plain string/Buffer equality check short-circuits on the
 * first differing byte, leaking timing information that lets an attacker
 * discover the correct signature byte-by-byte).
 */

export function computeHmacSha256Hex(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Constant-time comparison of two hex-encoded digests. Returns `false`
 * (never throws) for malformed/mismatched-length input — a caller must
 * never be able to distinguish "wrong length" from "right length, wrong
 * bytes" by catching an exception vs a `false` return, since that itself
 * would be a (coarser) timing/behavioral side-channel.
 */
export function timingSafeEqualHex(
  expectedHex: string,
  providedHex: string
): boolean {
  if (
    expectedHex.length === 0 ||
    providedHex.length === 0 ||
    expectedHex.length !== providedHex.length ||
    !/^[0-9a-f]+$/i.test(expectedHex) ||
    !/^[0-9a-f]+$/i.test(providedHex)
  ) {
    return false;
  }

  const expectedBuffer = Buffer.from(expectedHex, "hex");
  const providedBuffer = Buffer.from(providedHex, "hex");

  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, providedBuffer);
}

/**
 * Timestamp replay/staleness window check — mirrors `sync-storage/domain/
 * sync-hmac.ts`'s `isTimestampWithinSkew`. `timestampSeconds` is a decimal
 * unix-epoch-seconds string (the shape both fixture schemes below send).
 */
export function isTimestampWithinTolerance(
  timestampSeconds: string,
  now: Date,
  toleranceSeconds: number
): boolean {
  const parsed = Number(timestampSeconds);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return false;
  }

  const skewSeconds = Math.abs(now.getTime() / 1000 - parsed);

  return skewSeconds <= toleranceSeconds;
}

/** Fallback replay key when a scheme has no explicit delivery-id/nonce header — a stable hash of the signature itself (never the raw body, which may be large/sensitive) plus the timestamp, so two genuinely different deliveries can never collide, but the exact same delivery replayed always derives the same key. */
export function deriveFallbackReplayKey(
  signatureHex: string,
  timestampSeconds: string
): string {
  return sha256Hex(`${signatureHex}.${timestampSeconds}`);
}
