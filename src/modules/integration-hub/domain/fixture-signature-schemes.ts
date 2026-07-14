import type {
  IntegrationInboundVerificationInput,
  IntegrationInboundVerificationResult
} from "../../_shared/ports/integration-adapter-port";
import {
  computeHmacSha256Hex,
  deriveFallbackReplayKey,
  isTimestampWithinTolerance,
  sha256Hex,
  timingSafeEqualHex
} from "./signature-primitives";

/**
 * Two self-contained FIXTURE signature schemes (Issue #754 foundation
 * scope — "ships zero real business integrations", mirroring #643/#742's
 * accepted precedent). Structurally different envelopes on purpose, so
 * tests exercise two genuinely distinct replay-key derivation strategies
 * (Issue #754 acceptance criterion: "At least two fixture signature
 * schemes verify valid messages and reject modified body, stale
 * timestamp, reused nonce, and wrong tenant/endpoint").
 *
 * Both try `secret` first, then `previousSecret` (when present) — this is
 * where key-rotation-with-overlap is actually enforced: a request signed
 * with the OLD secret still verifies while the endpoint's overlap window
 * (`previous_secret_expires_at`) has not yet elapsed (the caller only
 * passes a non-null `previousSecret` when `now` is still inside that
 * window — see `application/inbound-webhook-intake.ts`).
 */

const HEX_SIGNATURE_PATTERN = /^[0-9a-f]+$/i;

// --- Scheme 1: fixture_hmac_sha256 -----------------------------------
// Headers: X-Integration-Signature (hex hmac-sha256 of
// "<timestamp>.<rawBody>"), X-Integration-Timestamp (unix seconds),
// X-Integration-Delivery-Id (optional provider delivery id — used as the
// replay key verbatim when present, matching how GitHub/most webhook
// providers supply a stable per-delivery id). Falls back to a
// signature+timestamp-derived key only when the provider omits a delivery
// id header.

function signHmacSha256(
  secret: string,
  timestamp: string,
  rawBody: string
): string {
  return computeHmacSha256Hex(secret, `${timestamp}.${rawBody}`);
}

export function verifyFixtureHmacSha256(
  input: IntegrationInboundVerificationInput
): IntegrationInboundVerificationResult {
  const providedSignature = input.headers["x-integration-signature"];
  const timestamp = input.headers["x-integration-timestamp"];

  if (!providedSignature) {
    return { valid: false, reason: "missing_signature_header" };
  }

  if (!timestamp) {
    return { valid: false, reason: "missing_timestamp_header" };
  }

  if (!HEX_SIGNATURE_PATTERN.test(providedSignature)) {
    return { valid: false, reason: "malformed_signature" };
  }

  if (
    !isTimestampWithinTolerance(timestamp, input.now, input.toleranceSeconds)
  ) {
    return { valid: false, reason: "timestamp_out_of_tolerance" };
  }

  const expected = signHmacSha256(input.secret, timestamp, input.rawBody);
  let usedPreviousSecret = false;
  let matched = timingSafeEqualHex(expected, providedSignature);

  if (!matched && input.previousSecret) {
    const expectedWithPrevious = signHmacSha256(
      input.previousSecret,
      timestamp,
      input.rawBody
    );
    matched = timingSafeEqualHex(expectedWithPrevious, providedSignature);
    usedPreviousSecret = matched;
  }

  if (!matched) {
    return { valid: false, reason: "signature_mismatch" };
  }

  const providerDeliveryId = input.headers["x-integration-delivery-id"];
  const replayKey =
    providerDeliveryId && providerDeliveryId.trim().length > 0
      ? providerDeliveryId.trim()
      : deriveFallbackReplayKey(providedSignature, timestamp);

  return {
    valid: true,
    replayKey,
    providerDeliveryId: providerDeliveryId || undefined,
    usedPreviousSecret
  };
}

// --- Scheme 2: fixture_shared_secret_nonce ----------------------------
// Headers: X-Integration-Signature-V2 (hex hmac-sha256 of
// "<nonce>:<timestamp>:<sha256(rawBody)>"), X-Integration-Timestamp,
// X-Integration-Nonce (REQUIRED — always the replay key verbatim, never a
// fallback). Signing over the body's digest rather than the raw body
// itself mirrors a common real-world envelope shape (e.g. Twilio/Stripe-
// style canonical strings) — deliberately different from scheme 1's
// direct-raw-body signing, so the two fixtures are not trivial variants
// of the same construction.

function signSharedSecretNonce(
  secret: string,
  nonce: string,
  timestamp: string,
  rawBody: string
): string {
  const bodyDigest = sha256Hex(rawBody);
  return computeHmacSha256Hex(secret, `${nonce}:${timestamp}:${bodyDigest}`);
}

export function verifyFixtureSharedSecretNonce(
  input: IntegrationInboundVerificationInput
): IntegrationInboundVerificationResult {
  const providedSignature = input.headers["x-integration-signature-v2"];
  const timestamp = input.headers["x-integration-timestamp"];
  const nonce = input.headers["x-integration-nonce"];

  if (!providedSignature) {
    return { valid: false, reason: "missing_signature_header" };
  }

  if (!timestamp) {
    return { valid: false, reason: "missing_timestamp_header" };
  }

  if (!nonce || nonce.trim().length === 0) {
    return { valid: false, reason: "missing_replay_key" };
  }

  if (!HEX_SIGNATURE_PATTERN.test(providedSignature)) {
    return { valid: false, reason: "malformed_signature" };
  }

  if (
    !isTimestampWithinTolerance(timestamp, input.now, input.toleranceSeconds)
  ) {
    return { valid: false, reason: "timestamp_out_of_tolerance" };
  }

  const expected = signSharedSecretNonce(
    input.secret,
    nonce,
    timestamp,
    input.rawBody
  );
  let usedPreviousSecret = false;
  let matched = timingSafeEqualHex(expected, providedSignature);

  if (!matched && input.previousSecret) {
    const expectedWithPrevious = signSharedSecretNonce(
      input.previousSecret,
      nonce,
      timestamp,
      input.rawBody
    );
    matched = timingSafeEqualHex(expectedWithPrevious, providedSignature);
    usedPreviousSecret = matched;
  }

  if (!matched) {
    return { valid: false, reason: "signature_mismatch" };
  }

  return {
    valid: true,
    replayKey: nonce.trim(),
    usedPreviousSecret
  };
}

/** Test/fixture-only helpers so callers (and adversarial tests) can compute a valid signature without duplicating the private canonical-string construction above. */
export const fixtureSignatureTestHelpers = {
  signHmacSha256,
  signSharedSecretNonce
};
