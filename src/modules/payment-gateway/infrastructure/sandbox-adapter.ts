/**
 * The FAKE / SANDBOX payment provider adapter for `payment_gateway` (Issue
 * #877). This is the ONLY adapter the base repo ships — it exists for TESTS and
 * DOCUMENTATION, never as a production network dependency. It performs NO real
 * network I/O: `createCheckoutSession`/`requestRefund`/`queryStatus` return
 * deterministic, in-memory results, and `verifyWebhook` runs the same real
 * fail-closed HMAC/freshness/account-binding checks a production adapter must.
 *
 * A real provider adapter (Midtrans/Xendit/Stripe/...) is contributed by a
 * derived application through `src/modules/application-registry.ts` and
 * registered in `adapter-registry.ts` — the base never hardcodes one.
 *
 * ## Sandbox signing scheme (documented, so tests + a derived-app author can
 * ## produce a valid signed webhook)
 *   - header `x-sandbox-timestamp`: unix-epoch SECONDS (decimal string)
 *   - header `x-sandbox-signature`: lower-hex HMAC-SHA256 of `${timestamp}.${rawBody}`
 *   - body JSON: `{ event_id, account_ref, session_ref, status, sequence,
 *     amount_minor?, currency? }` where `status` is one of the normalized
 *     statuses (settled/failed/expired/refunded/disputed/pending).
 *
 * `signSandboxWebhook` (exported) builds the header pair for a body/secret so the
 * happy-path is reproducible; `sandboxControl` (exported, mutable) lets a test
 * inject a provider fault (timeout/outage/decline) or a status-query override
 * WITHOUT any real network — production real adapters ignore it entirely.
 */
import {
  computeHmacSha256Hex,
  isBodyWithinLimit,
  isTimestampFresh,
  timingSafeEqualHex,
  type WebhookVerificationInput,
  type WebhookVerificationResult
} from "../domain/webhook-security";
import { isNormalizedPaymentStatus } from "../domain/payment-state";
import type { ProviderErrorClass } from "../domain/provider-errors";
import type {
  PaymentProviderAdapter,
  ProviderCheckoutRequest,
  ProviderCheckoutResult,
  ProviderRefundRequest,
  ProviderRefundResult,
  ProviderStatusRequest,
  ProviderStatusResult
} from "../domain/provider-adapter";

export const SANDBOX_PROVIDER_KEY = "sandbox";

/**
 * Test/documentation control surface (in-memory, process-local). Production real
 * adapters never read this — it only shapes the FAKE adapter's deterministic
 * results so a test can exercise timeout/outage/decline/reconciliation paths
 * without any real network. `reset()` restores the happy path.
 */
export const sandboxControl: {
  checkoutFault: ProviderErrorClass | null;
  refundFault: ProviderErrorClass | null;
  statusFault: ProviderErrorClass | null;
  /** Override the status `queryStatus` reports, keyed by providerSessionRef. */
  statusBySession: Record<string, string>;
  reset(): void;
} = {
  checkoutFault: null,
  refundFault: null,
  statusFault: null,
  statusBySession: {},
  reset() {
    this.checkoutFault = null;
    this.refundFault = null;
    this.statusFault = null;
    this.statusBySession = {};
  }
};

/** Build the `{ timestamp, signature }` header pair for a raw body + secret (test/doc helper — the sandbox signing scheme above). */
export function signSandboxWebhook(
  secret: string,
  rawBody: string,
  timestampSeconds: string
): { timestamp: string; signature: string } {
  return {
    timestamp: timestampSeconds,
    signature: computeHmacSha256Hex(secret, `${timestampSeconds}.${rawBody}`)
  };
}

export const sandboxAdapter: PaymentProviderAdapter = {
  key: SANDBOX_PROVIDER_KEY,

  async createCheckoutSession(
    req: ProviderCheckoutRequest
  ): Promise<ProviderCheckoutResult> {
    if (sandboxControl.checkoutFault) {
      return { ok: false, errorClass: sandboxControl.checkoutFault };
    }
    const providerSessionRef = `sbx_sess_${req.intentId}`;
    // Deterministic hosted-checkout URL on the allow-listed host (the caller has
    // already host-equality-validated `endpointHost`).
    const checkoutUrl = `https://${req.endpointHost}/checkout/${providerSessionRef}`;
    return { ok: true, providerSessionRef, checkoutUrl };
  },

  verifyWebhook(input: WebhookVerificationInput): WebhookVerificationResult {
    const {
      rawBody,
      headers,
      secret,
      toleranceSeconds,
      now,
      expectedAccountRef
    } = input;

    // (d) payload size guard (defence — the route also enforces it).
    if (!isBodyWithinLimit(Buffer.byteLength(rawBody, "utf8"), 1_048_576)) {
      return { valid: false, reason: "body_too_large" };
    }

    const timestamp = headers["x-sandbox-timestamp"];
    const signature = headers["x-sandbox-signature"];
    if (typeof timestamp !== "string" || typeof signature !== "string") {
      return { valid: false, reason: "missing_signature_headers" };
    }

    // (b) freshness window (<= 300s, clamped by the domain helper).
    if (!isTimestampFresh(timestamp, now, toleranceSeconds)) {
      return { valid: false, reason: "stale_timestamp" };
    }

    // (a) HMAC signature (timing-safe).
    const expected = computeHmacSha256Hex(secret, `${timestamp}.${rawBody}`);
    if (!timingSafeEqualHex(expected, signature)) {
      return { valid: false, reason: "signature_mismatch" };
    }

    // Body must be a JSON object with the required identity fields.
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return { valid: false, reason: "invalid_json" };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { valid: false, reason: "invalid_payload" };
    }
    const body = parsed as Record<string, unknown>;

    // (c) provider/account binding — the payload's claimed account MUST equal the
    // bound account_ref (cross-tenant substitution guard). Fail-closed.
    if (
      typeof body.account_ref !== "string" ||
      body.account_ref !== expectedAccountRef
    ) {
      return { valid: false, reason: "account_binding_mismatch" };
    }

    // (e) anti-replay identity — the provider event id/nonce is required.
    if (
      typeof body.event_id !== "string" ||
      body.event_id.length === 0 ||
      body.event_id.length > 200
    ) {
      return { valid: false, reason: "missing_event_id" };
    }

    const status = typeof body.status === "string" ? body.status : "unknown";
    if (!isNormalizedPaymentStatus(status)) {
      return { valid: false, reason: "unknown_status" };
    }

    const sequenceRaw = body.sequence;
    const providerSequence =
      typeof sequenceRaw === "number" &&
      Number.isInteger(sequenceRaw) &&
      sequenceRaw >= 0
        ? sequenceRaw
        : 0;

    const amountMinor =
      typeof body.amount_minor === "number" &&
      Number.isInteger(body.amount_minor) &&
      body.amount_minor >= 0
        ? body.amount_minor
        : null;
    const currency =
      typeof body.currency === "string" && /^[A-Z]{3}$/.test(body.currency)
        ? body.currency
        : null;

    return {
      valid: true,
      providerEventId: body.event_id,
      providerSessionRef:
        typeof body.session_ref === "string" ? body.session_ref : null,
      normalizedStatus: status,
      providerStatusRaw:
        typeof body.provider_status === "string"
          ? body.provider_status.slice(0, 100)
          : null,
      providerSequence,
      amountMinor,
      currency,
      timestampSeconds: timestamp
    };
  },

  async requestRefund(
    req: ProviderRefundRequest
  ): Promise<ProviderRefundResult> {
    if (sandboxControl.refundFault) {
      return { ok: false, errorClass: sandboxControl.refundFault };
    }
    return {
      ok: true,
      providerRefundRef: `sbx_rf_${req.refundId}`,
      status: "succeeded"
    };
  },

  async queryStatus(req: ProviderStatusRequest): Promise<ProviderStatusResult> {
    if (sandboxControl.statusFault) {
      return { ok: false, errorClass: sandboxControl.statusFault };
    }
    const override = sandboxControl.statusBySession[req.providerSessionRef];
    return { ok: true, normalizedStatus: override ?? "unknown" };
  }
};
