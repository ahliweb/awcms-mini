/**
 * The PROVIDER-NEUTRAL adapter contract for `payment_gateway` (Issue #877,
 * ADR-0022). PURE TYPES — no I/O, no concrete provider. A real provider
 * (Midtrans/Xendit/Stripe/...) is NEVER hardcoded in the base repo: an adapter
 * is OPTIONAL CONFIGURATION contributed by a derived application through
 * `src/modules/application-registry.ts` and registered in
 * `infrastructure/adapter-registry.ts`. The base ships ONLY a fake/sandbox
 * adapter (`infrastructure/sandbox-adapter.ts`) for tests + documentation, never
 * a production network dependency — a LAN/offline/manual-payment deployment runs
 * with NO adapter configured at all.
 *
 * Every method is designed so the CALLER (engine/worker) owns the DB transaction
 * boundary: `createCheckoutSession`/`requestRefund`/`queryStatus` are async
 * provider calls the OUTBOX worker runs OUTSIDE any transaction (ADR-0006);
 * `verifyWebhook` is a PURE, synchronous signature/freshness/binding check.
 */
import type { ProviderErrorClass } from "./provider-errors";
import type {
  WebhookVerificationInput,
  WebhookVerificationResult
} from "./webhook-security";

export type ProviderCheckoutRequest = {
  intentId: string;
  invoiceId: string;
  amountMinor: number;
  currency: string;
  /** The allow-listed provider API host (SSRF host-equality is enforced by the caller before dispatch). */
  endpointHost: string;
  /** The allow-listed return/callback URL (open-redirect host-equality enforced by the caller), or null. */
  callbackUrl: string | null;
  providerAccountRef: string;
};

export type ProviderCheckoutResult =
  | { ok: true; providerSessionRef: string; checkoutUrl: string }
  | { ok: false; errorClass: ProviderErrorClass };

export type ProviderRefundRequest = {
  intentId: string;
  refundId: string;
  amountMinor: number;
  currency: string;
  providerSessionRef: string;
  endpointHost: string;
  providerAccountRef: string;
};

export type ProviderRefundResult =
  | { ok: true; providerRefundRef: string; status: "succeeded" | "pending" }
  | { ok: false; errorClass: ProviderErrorClass };

export type ProviderStatusRequest = {
  intentId: string;
  providerSessionRef: string;
  endpointHost: string;
  providerAccountRef: string;
};

export type ProviderStatusResult =
  | { ok: true; normalizedStatus: string }
  | { ok: false; errorClass: ProviderErrorClass };

export type PaymentProviderAdapter = {
  key: string;
  /** Async — dispatched by the outbox worker OUTSIDE any DB transaction (ADR-0006). */
  createCheckoutSession(
    req: ProviderCheckoutRequest
  ): Promise<ProviderCheckoutResult>;
  /** PURE, synchronous — never trusts a browser redirect; verifies signature + freshness + account binding fail-closed. */
  verifyWebhook(input: WebhookVerificationInput): WebhookVerificationResult;
  /** Async — outbox worker, outside any DB transaction. */
  requestRefund(req: ProviderRefundRequest): Promise<ProviderRefundResult>;
  /** Async — used by the reconciliation worker to compare provider vs local state. */
  queryStatus(req: ProviderStatusRequest): Promise<ProviderStatusResult>;
};
