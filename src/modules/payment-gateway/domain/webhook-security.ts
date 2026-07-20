import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Fail-closed inbound webhook security primitives for `payment_gateway` (Issue
 * #877, ADR-0022 §9). PURE — no I/O. Mirrors `integration_hub`'s established
 * signature/timestamp discipline (this repo's precedent): a fixed-length check
 * before `timingSafeEqual` (which THROWS on mismatched buffer lengths rather
 * than returning `false`), `node:crypto`'s `timingSafeEqual` itself (never
 * `===`/`==` on the computed vs provided signature — a plain equality check
 * short-circuits on the first differing byte, leaking timing that lets an
 * attacker discover the signature byte-by-byte), a freshness window, and a
 * DURABLE (DB-persisted, not in-memory) anti-replay identity.
 *
 * Every gate is FAIL-CLOSED: a missing/malformed input returns `false`/`reject`,
 * never a pass. Payment status is NEVER trusted from a browser redirect — only
 * from a signed delivery that clears ALL of these gates, or a reconciliation
 * outcome.
 */

/** The hard upper bound on the inbound freshness window (ADR-0022 §9: "window <= 300s"). A provider account may configure a SMALLER window but never larger; a value above this is clamped down. */
export const MAX_WEBHOOK_TOLERANCE_SECONDS = 300;

export function computeHmacSha256Hex(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Constant-time comparison of two hex-encoded digests. Returns `false` (never
 * throws) for malformed/mismatched-length input — a caller must never be able to
 * distinguish "wrong length" from "right length, wrong bytes" by catching an
 * exception vs a `false` return.
 */
export function timingSafeEqualHex(
  expectedHex: string,
  providedHex: string
): boolean {
  if (
    typeof expectedHex !== "string" ||
    typeof providedHex !== "string" ||
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
 * Clamp a configured tolerance to `[1, MAX_WEBHOOK_TOLERANCE_SECONDS]`. A value
 * above the hard ceiling is clamped DOWN (never trusted to widen the window).
 */
export function effectiveToleranceSeconds(configured: number): number {
  if (!Number.isFinite(configured) || configured < 1) return 1;
  return Math.min(Math.floor(configured), MAX_WEBHOOK_TOLERANCE_SECONDS);
}

/**
 * Freshness/staleness check. `timestampSeconds` is a decimal unix-epoch-seconds
 * string. Fail-closed: a non-numeric/non-finite/non-positive timestamp is stale.
 */
export function isTimestampFresh(
  timestampSeconds: string,
  now: Date,
  toleranceSeconds: number
): boolean {
  const parsed = Number(timestampSeconds);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return false;
  }
  const skewSeconds = Math.abs(now.getTime() / 1000 - parsed);
  return skewSeconds <= effectiveToleranceSeconds(toleranceSeconds);
}

/** Reject an oversized inbound body (byte length) before the (comparatively expensive) HMAC computation. */
export function isBodyWithinLimit(
  sizeBytes: number,
  maxBytes: number
): boolean {
  return (
    Number.isFinite(sizeBytes) &&
    Number.isFinite(maxBytes) &&
    sizeBytes >= 0 &&
    sizeBytes <= maxBytes
  );
}

export type WebhookVerificationInput = {
  rawBody: string;
  /** Lower-cased header map. */
  headers: Readonly<Record<string, string>>;
  secret: string;
  toleranceSeconds: number;
  now: Date;
  /** The provider account's bound `provider_account_ref` — the payload's claimed account MUST equal this (cross-tenant substitution guard). */
  expectedAccountRef: string;
};

export type WebhookVerificationResult =
  | {
      valid: true;
      /** The provider's own event id/nonce — the DURABLE anti-replay identity persisted in the inbox. */
      providerEventId: string;
      providerSessionRef: string | null;
      normalizedStatus: string;
      providerStatusRaw: string | null;
      /** Monotonic ordering signal (out-of-order guard); 0 when the provider gives none. */
      providerSequence: number;
      amountMinor: number | null;
      currency: string | null;
      timestampSeconds: string;
    }
  | { valid: false; reason: string };
