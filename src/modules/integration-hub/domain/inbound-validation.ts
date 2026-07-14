/**
 * Pure pre-signature-verification gates for inbound webhook intake (Issue
 * #754 security requirements: "Unknown adapter, invalid signature, stale
 * timestamp, reused nonce, oversized body, unsupported content type, or
 * tenant mismatch is rejected with safe errors"). Checked BEFORE signature
 * verification runs, in this order, by `application/inbound-webhook-
 * intake.ts` — an inactive endpoint/tenant or oversized/wrong-content-type
 * request never even reaches the (comparatively expensive) HMAC
 * computation.
 */
export type IntakeGateResult = { ok: true } | { ok: false; reason: string };

export function checkEndpointAcceptingTraffic(
  endpointStatus: string,
  tenantStatus: string
): IntakeGateResult {
  if (tenantStatus !== "active") {
    return { ok: false, reason: "tenant_inactive" };
  }

  if (endpointStatus === "disabled") {
    return { ok: false, reason: "endpoint_disabled" };
  }

  if (endpointStatus === "paused") {
    return { ok: false, reason: "endpoint_paused" };
  }

  if (endpointStatus !== "active") {
    return { ok: false, reason: "endpoint_inactive" };
  }

  return { ok: true };
}

export function checkContentType(
  contentType: string | null,
  allowed: readonly string[]
): IntakeGateResult {
  if (!contentType) {
    return { ok: false, reason: "missing_content_type" };
  }

  const base = contentType.split(";")[0]!.trim().toLowerCase();
  const allowedLower = allowed.map((entry) => entry.toLowerCase());

  if (!allowedLower.includes(base)) {
    return { ok: false, reason: "unsupported_content_type" };
  }

  return { ok: true };
}

export function checkBodySize(
  sizeBytes: number,
  maxBytes: number
): IntakeGateResult {
  if (sizeBytes > maxBytes) {
    return { ok: false, reason: "body_too_large" };
  }

  return { ok: true };
}

/** Bound applied to the redacted troubleshooting snippet persisted for a signature-VALID delivery only (data minimization, Issue #754's #745 integration) — never the full raw body. */
export const RAW_BODY_SNIPPET_MAX_LENGTH = 2000;
