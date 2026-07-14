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
 *
 * Called TWICE per delivery attempt: once for the subscription's own
 * `target_url` (`deliverOutboundWebhook` below), and once more for EVERY
 * redirect `Location` this client is asked to follow
 * (`followBoundedRedirects` below) — a redirect response is attacker-
 * controlled input from the tenant-configured target exactly like the
 * original URL is, so it gets exactly the same validation, never a
 * shortcut (security-auditor/reviewer finding on PR #784: `fetch()`'s
 * default redirect-follow behavior let a 302/303/307 response point at
 * `169.254.169.254`/any private IP with the SSRF guard only ever having
 * inspected the ORIGINAL `target_url`).
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

/**
 * Bound on how many raw response body BYTES this client will ever buffer
 * from a remote target, read incrementally (never `response.text()`
 * unbounded) — an adversarial/misbehaving target streaming an unbounded
 * body must never be able to exhaust worker memory. Comfortably larger
 * than `MAX_RESPONSE_SNIPPET_LENGTH` (the final STORED size after
 * redaction/truncation) so ordinary error bodies still redact/truncate
 * meaningfully, but small enough to be a real cap, not a formality.
 */
const MAX_RESPONSE_BODY_READ_BYTES = 8192;

async function readCappedResponseText(
  response: Response,
  maxBytes: number
): Promise<string> {
  const body = response.body;

  if (!body) {
    return "";
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      const remaining = maxBytes - total;

      if (remaining <= 0) {
        await reader.cancel().catch(() => {});
        break;
      }

      const slice =
        value.byteLength > remaining ? value.slice(0, remaining) : value;

      chunks.push(slice);
      total += slice.byteLength;

      if (total >= maxBytes) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } catch {
    // A read error mid-stream still returns whatever was captured so far —
    // never throws out of this helper.
  }

  const combined = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(combined);
}

/**
 * A redirect response (`Location` header) is just as attacker-controlled
 * as the original `target_url` — it comes from whatever server the tenant
 * pointed the subscription at, which may not be who they claimed control
 * of at subscription-creation time (or may itself have been compromised
 * since). `fetch()` is called with `redirect: "manual"` specifically so
 * this function decides, hop by hop, whether to follow at all — never
 * `fetch()`'s own default (silently follow anywhere, unconditionally).
 * Bounded to `MAX_REDIRECT_HOPS` hops; exceeding it is a hard, non-
 * retryable failure (a target that redirects this many times is
 * misbehaving or adversarial, not transiently unavailable).
 */
const MAX_REDIRECT_HOPS = 2;

export type RedirectFollowResult =
  | { ok: true; response: Response }
  | {
      ok: false;
      errorCode: string;
      errorMessage: string;
      retryable: boolean;
    };

/**
 * Exported for direct testability (mirrors `fixtureSignatureTestHelpers`'s
 * precedent elsewhere in this module) — `tests/unit/integration-hub-
 * outbound-http-client.test.ts`'s adversarial redirect tests call this
 * directly with a REAL local fixture server as `initialUrl` (unchecked by
 * this function itself — the caller, `deliverOutboundWebhook`, validates
 * the initial URL before ever calling this) so the test can prove the
 * REDIRECT target specifically gets validated and rejected, without that
 * assertion being confounded by the local test server's own address
 * (127.0.0.1) also being a private/blocked literal.
 */
export async function followBoundedRedirects(
  initialUrl: string,
  init: { method: string; headers: Record<string, string>; body: string },
  allowPrivateTargets: boolean
): Promise<RedirectFollowResult> {
  let currentUrl = initialUrl;

  for (let hop = 0; ; hop += 1) {
    const response = await fetch(currentUrl, { ...init, redirect: "manual" });

    const isRedirect = response.status >= 300 && response.status < 400;

    if (!isRedirect) {
      return { ok: true, response };
    }

    if (hop >= MAX_REDIRECT_HOPS) {
      return {
        ok: false,
        errorCode: "too_many_redirects",
        errorMessage: `Outbound target exceeded the ${MAX_REDIRECT_HOPS}-hop redirect limit.`,
        retryable: false
      };
    }

    const location = response.headers.get("location");

    if (!location) {
      return {
        ok: false,
        errorCode: "redirect_without_location",
        errorMessage:
          "Outbound target responded with a redirect but no Location header.",
        retryable: false
      };
    }

    let nextUrl: string;

    try {
      nextUrl = new URL(location, currentUrl).toString();
    } catch {
      return {
        ok: false,
        errorCode: "redirect_invalid_location",
        errorMessage:
          "Outbound target's redirect Location header was not a valid URL.",
        retryable: false
      };
    }

    // SAME validation as the original target_url — write-time validation
    // (subscription-directory.ts) and the pre-fetch check below only ever
    // see the ORIGINAL url; this is the one place a redirect hop itself
    // gets checked, every single hop, unconditionally.
    const redirectCheck = await validateOutboundDestination(
      nextUrl,
      allowPrivateTargets
    );

    if (!redirectCheck.ok) {
      return {
        ok: false,
        errorCode: "ssrf_blocked_redirect",
        errorMessage: `Outbound redirect destination rejected: ${redirectCheck.reason}`,
        retryable: false
      };
    }

    currentUrl = nextUrl;
  }
}

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

  // The ENTIRE exchange — every redirect hop's fetch() AND the final
  // capped body read — runs inside ONE timeout window. A previous version
  // only bounded the initial fetch() call, leaving the subsequent
  // response.text() read (and, now, any redirect hops) unbounded —
  // reviewer finding on PR #784.
  let outcome: RedirectFollowResult;

  try {
    outcome = await withTimeout(
      followBoundedRedirects(
        request.url,
        { method: "POST", headers, body: request.body },
        request.allowPrivateTargets
      ),
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

  if (!outcome.ok) {
    return {
      ok: false,
      retryable: outcome.retryable,
      errorCode: outcome.errorCode,
      errorMessage: outcome.errorMessage
    };
  }

  const response = outcome.response;

  let text: string;

  try {
    text = await withTimeout(
      readCappedResponseText(response, MAX_RESPONSE_BODY_READ_BYTES),
      request.timeoutMs,
      "integration-hub:outbound:body-read"
    );
  } catch {
    text = "";
  }

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
