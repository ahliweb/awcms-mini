import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { withTimeout } from "../../../lib/integration/timeout";
import { redactSecretsInText } from "../../_shared/redaction";
import { computeHmacSha256Hex } from "../domain/signature-primitives";
import {
  isBlockedIpAddress,
  validateOutboundUrlShape
} from "../domain/ssrf-guard";

/**
 * The generic outbound HTTP delivery client (Issue #754's "generic HTTP
 * fixture" — the `generic_http_webhook` adapter,
 * `infrastructure/adapter-registry.ts`). Called ONLY by the outbound
 * dispatch job (`application/outbound-dispatch.ts`), OUTSIDE any DB
 * transaction (ADR-0006/AGENTS.md rule #11 — a provider/network call must
 * never run inside a transaction). Never called with a raw tenant-supplied
 * secret VALUE — callers resolve `secret_reference` to a value from
 * `process.env` immediately before this call and never persist/log it.
 */

const MAX_RESPONSE_SNIPPET_LENGTH = 500;

export type OutboundDestinationCheck =
  { ok: true } | { ok: false; reason: string };

/**
 * Two-layer SSRF check: (1) literal URL/host shape (`validateOutboundUrlShape`,
 * synchronous, no I/O) and (2) a DNS resolution of the hostname, with every
 * resolved address also checked — defense in depth against a public
 * hostname that simply always resolves to a private/reserved address.
 * Skipped entirely when `allowPrivateTargets` (the explicit trusted-
 * deployment opt-in, `INTEGRATION_HUB_ALLOW_PRIVATE_TARGETS`) is `true`.
 * See `domain/ssrf-guard.ts`'s header comment for the documented residual
 * DNS-rebinding (TOCTOU) limitation this does NOT close.
 */
export async function validateOutboundDestination(
  rawUrl: string,
  allowPrivateTargets: boolean
): Promise<OutboundDestinationCheck> {
  const shapeResult = validateOutboundUrlShape(rawUrl, { allowPrivateTargets });

  if (!shapeResult.ok) {
    return shapeResult;
  }

  if (allowPrivateTargets) {
    return { ok: true };
  }

  if (isIP(shapeResult.hostname) !== 0) {
    // Already validated as a safe IP literal by validateOutboundUrlShape.
    return { ok: true };
  }

  try {
    const records = await dnsLookup(shapeResult.hostname, { all: true });

    if (records.some((record) => isBlockedIpAddress(record.address))) {
      return { ok: false, reason: "resolved_private_or_reserved_address" };
    }

    if (records.length === 0) {
      return { ok: false, reason: "dns_resolution_empty" };
    }
  } catch {
    return { ok: false, reason: "dns_resolution_failed" };
  }

  return { ok: true };
}

export type OutboundDeliveryRequest = {
  url: string;
  headers: Readonly<Record<string, string>>;
  body: string;
  timeoutMs: number;
  /** Resolved secret VALUE (from `process.env`), or `null`/omitted to send an unsigned request. Never logged. */
  secret?: string | null;
  allowPrivateTargets: boolean;
};

export type OutboundDeliveryResult =
  | { ok: true; httpStatus: number; responseSnippet: string }
  | {
      ok: false;
      retryable: boolean;
      errorCode: string;
      errorMessage: string;
      httpStatus?: number;
    };

export async function deliverOutboundWebhook(
  request: OutboundDeliveryRequest
): Promise<OutboundDeliveryResult> {
  const destinationCheck = await validateOutboundDestination(
    request.url,
    request.allowPrivateTargets
  );

  if (!destinationCheck.ok) {
    return {
      ok: false,
      retryable: false,
      errorCode: "ssrf_blocked_destination",
      errorMessage: `Outbound destination rejected: ${destinationCheck.reason}`
    };
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...request.headers
  };

  if (request.secret) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    headers["x-integration-signature"] = computeHmacSha256Hex(
      request.secret,
      `${timestamp}.${request.body}`
    );
    headers["x-integration-timestamp"] = timestamp;
  }

  let response: Response;

  try {
    response = await withTimeout(
      fetch(request.url, {
        method: "POST",
        headers,
        body: request.body
      }),
      request.timeoutMs,
      "integration-hub:outbound"
    );
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      return {
        ok: false,
        retryable: true,
        errorCode: "timeout",
        errorMessage: `Outbound delivery timed out after ${request.timeoutMs}ms.`
      };
    }

    // Deliberately not interpolating error.message — some fetch
    // implementations can embed request details (same convention
    // telegram-provider-adapter.ts's callTelegramApi already documents).
    return {
      ok: false,
      retryable: true,
      errorCode: "network_error",
      errorMessage: "Outbound delivery failed (network error)."
    };
  }

  const text = await response.text().catch(() => "");
  const snippet = redactSecretsInText(
    text.slice(0, MAX_RESPONSE_SNIPPET_LENGTH)
  );

  if (response.ok) {
    return { ok: true, httpStatus: response.status, responseSnippet: snippet };
  }

  return {
    ok: false,
    retryable: response.status >= 500 || response.status === 429,
    errorCode: `http_${response.status}`,
    errorMessage: snippet || `HTTP ${response.status}`,
    httpStatus: response.status
  };
}
