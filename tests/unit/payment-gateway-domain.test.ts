/**
 * `payment_gateway` domain unit tests (Issue #877, epic #868, ADR-0022). Pure,
 * deterministic (no DB). Covers the security-critical primitives per AC:
 * signature verification, timestamp freshness (<=300s), payload size, provider/
 * account binding, replay identity, event ordering, SSRF/open-redirect
 * host-equality (never a prefix), secret-in-env-only, EXACT minor-unit money,
 * the payment/refund state machines, retry/backoff/circuit-breaker, tri-state
 * fail-closed parsing, and idempotency-hash resource-id coverage — plus the
 * MUTATION assertions (skip signature / trust a browser return / accept a
 * cross-tenant account are all REJECTED).
 */
import { describe, expect, test } from "bun:test";

import {
  assertSafePositiveMinor,
  isSafeNonNegativeMinor,
  isSafePositiveMinor,
  MAX_SAFE_MINOR
} from "../../src/modules/payment-gateway/domain/money";
import {
  intentStatusForNormalized,
  isLegalIntentTransition,
  isLegalRefundTransition,
  isNormalizedPaymentStatus,
  isTerminalIntentStatus
} from "../../src/modules/payment-gateway/domain/payment-state";
import {
  computeHmacSha256Hex,
  effectiveToleranceSeconds,
  isBodyWithinLimit,
  isTimestampFresh,
  MAX_WEBHOOK_TOLERANCE_SECONDS,
  timingSafeEqualHex
} from "../../src/modules/payment-gateway/domain/webhook-security";
import { isUrlHostAllowed } from "../../src/modules/payment-gateway/domain/endpoint-allowlist";
import {
  isValidSecretRefShape,
  resolveSecretRef
} from "../../src/modules/payment-gateway/domain/secret-ref";
import { isRetryableErrorClass } from "../../src/modules/payment-gateway/domain/provider-errors";
import {
  applyHealthFailure,
  CIRCUIT_OPEN_THRESHOLD,
  isCircuitOpen,
  isExhausted,
  nextBackoffMs,
  type HealthSnapshot
} from "../../src/modules/payment-gateway/domain/retry-backoff";
import { validateConfigureProviderAccount } from "../../src/modules/payment-gateway/domain/request-validation";
import { validateInitiateCheckout } from "../../src/modules/payment-gateway/domain/request-validation";
import { validateRequestRefund } from "../../src/modules/payment-gateway/domain/request-validation";
import { parseInitiateCheckoutBody } from "../../src/modules/payment-gateway/application/request-parsing";
import {
  initiateCheckoutIdempotencyFields,
  requestRefundIdempotencyFields,
  parseConfigureProviderAccountBody
} from "../../src/modules/payment-gateway/application/request-parsing";
import {
  sandboxAdapter,
  sandboxControl,
  signSandboxWebhook
} from "../../src/modules/payment-gateway/infrastructure/sandbox-adapter";

const SECRET = "whsec_test_secret";
const ACCOUNT_REF = "acct_merchant_123";

function signedWebhook(
  body: Record<string, unknown>,
  now: Date,
  secret = SECRET
) {
  const rawBody = JSON.stringify(body);
  const { timestamp, signature } = signSandboxWebhook(
    secret,
    rawBody,
    String(Math.floor(now.getTime() / 1000))
  );
  return {
    rawBody,
    headers: {
      "x-sandbox-timestamp": timestamp,
      "x-sandbox-signature": signature
    }
  };
}

describe("money — EXACT minor units (no float)", () => {
  test("accepts a positive safe integer, rejects float/zero/negative/overflow", () => {
    expect(isSafePositiveMinor(100)).toBe(true);
    expect(isSafePositiveMinor(10.5)).toBe(false);
    expect(isSafePositiveMinor(0)).toBe(false);
    expect(isSafePositiveMinor(-5)).toBe(false);
    expect(isSafePositiveMinor(MAX_SAFE_MINOR + 1)).toBe(false);
    expect(isSafePositiveMinor(Number.NaN)).toBe(false);
    expect(isSafeNonNegativeMinor(0)).toBe(true);
  });

  test("assertSafePositiveMinor throws on a float (mutation: a float amount is never dispatched)", () => {
    expect(() => assertSafePositiveMinor(9.99, "amountMinor")).toThrow();
    expect(assertSafePositiveMinor(999, "amountMinor")).toBe(999);
  });
});

describe("payment intent state machine (ADR-0022 §11.5)", () => {
  test("forward-legal transitions only", () => {
    expect(isLegalIntentTransition("initiated", "pending")).toBe(true);
    expect(isLegalIntentTransition("pending", "settled")).toBe(true);
    expect(isLegalIntentTransition("settled", "refunded")).toBe(true);
    expect(isLegalIntentTransition("failed", "initiated")).toBe(true);
    // Regressions rejected (a settled intent never goes back to pending).
    expect(isLegalIntentTransition("settled", "pending")).toBe(false);
    expect(isLegalIntentTransition("expired", "settled")).toBe(false);
    expect(isLegalIntentTransition("settled", "settled")).toBe(false);
  });

  test("normalized status maps to an intent status (no-op for pending/unknown)", () => {
    expect(intentStatusForNormalized("settled")).toBe("settled");
    expect(intentStatusForNormalized("failed")).toBe("failed");
    expect(intentStatusForNormalized("pending")).toBeNull();
    expect(intentStatusForNormalized("unknown")).toBeNull();
    expect(isNormalizedPaymentStatus("settled")).toBe(true);
    expect(isNormalizedPaymentStatus("bogus")).toBe(false);
  });

  test("terminal statuses", () => {
    expect(isTerminalIntentStatus("expired")).toBe(true);
    expect(isTerminalIntentStatus("pending")).toBe(false);
  });

  test("refund transitions", () => {
    // Issue #879 (ADR-0022 §5 CRITICAL-1) — refund maker/checker state machine:
    // requested -> approved -> pending -> {succeeded, failed}. Money-out is only
    // enqueued on the approve step, so `requested` can NEVER skip straight to
    // `pending` (that would dispatch without a distinct approver).
    expect(isLegalRefundTransition("requested", "approved")).toBe(true);
    expect(isLegalRefundTransition("approved", "pending")).toBe(true);
    expect(isLegalRefundTransition("pending", "succeeded")).toBe(true);
    // The new invariant: no approval-skipping path from requested to pending.
    expect(isLegalRefundTransition("requested", "pending")).toBe(false);
    expect(isLegalRefundTransition("succeeded", "failed")).toBe(false);
  });
});

describe("webhook security — timing-safe HMAC", () => {
  test("timingSafeEqualHex: equal true, different false, malformed/length-mismatch false", () => {
    const a = computeHmacSha256Hex(SECRET, "message");
    const b = computeHmacSha256Hex(SECRET, "message");
    expect(timingSafeEqualHex(a, b)).toBe(true);
    expect(timingSafeEqualHex(a, computeHmacSha256Hex(SECRET, "other"))).toBe(
      false
    );
    expect(timingSafeEqualHex(a, "")).toBe(false);
    expect(timingSafeEqualHex(a, a.slice(0, -2))).toBe(false);
    expect(timingSafeEqualHex(a, "zz" + a.slice(2))).toBe(false); // non-hex
  });

  test("freshness window <=300s, clamped", () => {
    const now = new Date("2026-07-20T12:00:00.000Z");
    const fresh = String(Math.floor(now.getTime() / 1000) - 10);
    const stale = String(Math.floor(now.getTime() / 1000) - 400);
    expect(isTimestampFresh(fresh, now, 300)).toBe(true);
    expect(isTimestampFresh(stale, now, 300)).toBe(false);
    // A configured tolerance above the ceiling is clamped DOWN (never widened).
    expect(effectiveToleranceSeconds(99999)).toBe(
      MAX_WEBHOOK_TOLERANCE_SECONDS
    );
    expect(isTimestampFresh(stale, now, 99999)).toBe(false);
    // Fail-closed on a non-numeric timestamp.
    expect(isTimestampFresh("not-a-number", now, 300)).toBe(false);
  });

  test("body-size guard", () => {
    expect(isBodyWithinLimit(100, 65536)).toBe(true);
    expect(isBodyWithinLimit(70000, 65536)).toBe(false);
  });
});

describe("SSRF / open-redirect — host EQUALITY, never a prefix", () => {
  test("exact host allowed; a prefix/suffix trick is rejected", () => {
    expect(
      isUrlHostAllowed("https://api.provider.com/checkout", "api.provider.com")
        .ok
    ).toBe(true);
    // The classic bypass: attacker host with the trusted host as a prefix label.
    expect(
      isUrlHostAllowed(
        "https://api.provider.com.evil.tld/x",
        "api.provider.com"
      ).ok
    ).toBe(false);
    // A subdomain is NOT the allow-listed host.
    expect(
      isUrlHostAllowed("https://evil.api.provider.com/x", "api.provider.com").ok
    ).toBe(false);
    // Non-https rejected by default.
    expect(
      isUrlHostAllowed("http://api.provider.com/x", "api.provider.com").ok
    ).toBe(false);
    // Garbage URL rejected.
    expect(isUrlHostAllowed("not a url", "api.provider.com").ok).toBe(false);
  });
});

describe("secret resolution — env pointer ONLY", () => {
  test("valid pointer shape; a literal secret is never a valid shape", () => {
    expect(isValidSecretRefShape("env:PAYMENT_GW_SECRET")).toBe(true);
    expect(isValidSecretRefShape("whsec_literal_secret")).toBe(false);
    expect(isValidSecretRefShape("env:lowercase")).toBe(false);
  });

  test("resolves from a provided env map; unset/malformed fail closed", () => {
    const env = { PAYMENT_GW_SECRET: "resolved-value" };
    const ok = resolveSecretRef("env:PAYMENT_GW_SECRET", env);
    expect(ok.ok && ok.value).toBe("resolved-value");
    expect(resolveSecretRef("env:MISSING", env).ok).toBe(false);
    expect(resolveSecretRef("whsec_literal", env).ok).toBe(false);
  });
});

describe("provider error classification + retry/backoff/circuit", () => {
  test("retryable vs terminal", () => {
    expect(isRetryableErrorClass("timeout")).toBe(true);
    expect(isRetryableErrorClass("unavailable")).toBe(true);
    expect(isRetryableErrorClass("declined")).toBe(false);
    expect(isRetryableErrorClass("invalid_request")).toBe(false);
  });

  test("exponential backoff + exhaustion + circuit breaker", () => {
    expect(nextBackoffMs(1)).toBeLessThan(nextBackoffMs(2));
    expect(isExhausted(5, 5)).toBe(true);
    expect(isExhausted(3, 5)).toBe(false);
    const now = new Date();
    let next: HealthSnapshot = {
      state: "up",
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      circuitOpenUntil: null
    };
    for (let i = 0; i < CIRCUIT_OPEN_THRESHOLD; i += 1) {
      next = applyHealthFailure(next, now);
    }
    expect(next.state).toBe("down");
    expect(isCircuitOpen(next, now)).toBe(true);
  });
});

describe("request validation — fail-closed tri-state", () => {
  test("configure provider account rejects a LITERAL secret (only env: pointer)", () => {
    const errs = validateConfigureProviderAccount(
      parseConfigureProviderAccountBody({
        providerKey: "sandbox",
        providerAccountRef: ACCOUNT_REF,
        signingSecretRef: "whsec_literal_secret",
        endpointHost: "api.provider.com"
      })
    );
    expect(errs.some((e) => e.field === "signingSecretRef")).toBe(true);
  });

  test("initiate checkout rejects a float amount (never coerced)", () => {
    const errs = validateInitiateCheckout(
      parseInitiateCheckoutBody({
        providerAccountId: "11111111-1111-1111-1111-111111111111",
        invoiceId: "22222222-2222-2222-2222-222222222222",
        amountMinor: 12.5,
        currency: "IDR",
        reason: "test"
      })
    );
    expect(errs.some((e) => e.field === "amountMinor")).toBe(true);
  });

  test("refund requires a mandatory reason", () => {
    expect(
      validateRequestRefund({ amountMinor: 100, reason: "" }).length
    ).toBeGreaterThan(0);
    expect(
      validateRequestRefund({ amountMinor: 100, reason: "duplicate charge" })
    ).toEqual([]);
  });
});

describe("idempotency hash covers the RESOURCE id (lesson: missing resource id recurs)", () => {
  test("initiate-checkout fields include invoiceId + providerAccountId + money", () => {
    const fields = initiateCheckoutIdempotencyFields("tenant-1", {
      providerAccountId: "acc-1",
      invoiceId: "inv-1",
      subscriptionId: null,
      amountMinor: 500,
      currency: "IDR",
      expiresInMinutes: null,
      reason: "x"
    });
    expect(fields.invoiceId).toBe("inv-1");
    expect(fields.providerAccountId).toBe("acc-1");
    expect(fields.amountMinor).toBe(500);
  });

  test("refund fields include intentId + amount", () => {
    const fields = requestRefundIdempotencyFields("tenant-1", "intent-9", {
      amountMinor: 250,
      reason: "y"
    });
    expect(fields.intentId).toBe("intent-9");
    expect(fields.amountMinor).toBe(250);
  });
});

describe("sandbox adapter verifyWebhook — fail-closed gates (mutation coverage)", () => {
  const now = new Date("2026-07-20T12:00:00.000Z");

  test("a valid signed webhook verifies", () => {
    const body = {
      event_id: "evt_1",
      account_ref: ACCOUNT_REF,
      session_ref: "sbx_sess_x",
      status: "settled",
      sequence: 1
    };
    const { rawBody, headers } = signedWebhook(body, now);
    const result = sandboxAdapter.verifyWebhook({
      rawBody,
      headers,
      secret: SECRET,
      toleranceSeconds: 300,
      now,
      expectedAccountRef: ACCOUNT_REF
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.providerEventId).toBe("evt_1");
      expect(result.normalizedStatus).toBe("settled");
    }
  });

  test("MUTATION: skipping/forging the signature is rejected", () => {
    const body = {
      event_id: "evt_2",
      account_ref: ACCOUNT_REF,
      status: "settled",
      sequence: 1
    };
    const rawBody = JSON.stringify(body);
    // No signature headers at all (a browser return posting the body).
    const missing = sandboxAdapter.verifyWebhook({
      rawBody,
      headers: {},
      secret: SECRET,
      toleranceSeconds: 300,
      now,
      expectedAccountRef: ACCOUNT_REF
    });
    expect(missing.valid).toBe(false);
    // A forged signature.
    const forged = sandboxAdapter.verifyWebhook({
      rawBody,
      headers: {
        "x-sandbox-timestamp": String(Math.floor(now.getTime() / 1000)),
        "x-sandbox-signature": "deadbeef"
      },
      secret: SECRET,
      toleranceSeconds: 300,
      now,
      expectedAccountRef: ACCOUNT_REF
    });
    expect(forged.valid).toBe(false);
  });

  test("MUTATION: a stale timestamp is rejected", () => {
    const body = {
      event_id: "evt_3",
      account_ref: ACCOUNT_REF,
      status: "settled",
      sequence: 1
    };
    const staleNow = new Date(now.getTime() - 400_000);
    const { rawBody, headers } = signedWebhook(body, staleNow);
    const result = sandboxAdapter.verifyWebhook({
      rawBody,
      headers,
      secret: SECRET,
      toleranceSeconds: 300,
      now, // verify 400s later
      expectedAccountRef: ACCOUNT_REF
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("stale_timestamp");
  });

  test("MUTATION: a cross-tenant account_ref is rejected (binding guard)", () => {
    const body = {
      event_id: "evt_4",
      account_ref: "acct_ANOTHER_tenant",
      status: "settled",
      sequence: 1
    };
    const { rawBody, headers } = signedWebhook(body, now);
    const result = sandboxAdapter.verifyWebhook({
      rawBody,
      headers,
      secret: SECRET,
      toleranceSeconds: 300,
      now,
      expectedAccountRef: ACCOUNT_REF // bound to a DIFFERENT account
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("account_binding_mismatch");
  });

  test("a missing event_id (no anti-replay identity) is rejected", () => {
    const body = { account_ref: ACCOUNT_REF, status: "settled", sequence: 1 };
    const { rawBody, headers } = signedWebhook(body, now);
    const result = sandboxAdapter.verifyWebhook({
      rawBody,
      headers,
      secret: SECRET,
      toleranceSeconds: 300,
      now,
      expectedAccountRef: ACCOUNT_REF
    });
    expect(result.valid).toBe(false);
  });

  test("sandbox checkout fault injection surfaces a provider error class", async () => {
    sandboxControl.reset();
    sandboxControl.checkoutFault = "timeout";
    const res = await sandboxAdapter.createCheckoutSession({
      intentId: "i1",
      invoiceId: "inv1",
      amountMinor: 100,
      currency: "IDR",
      endpointHost: "api.provider.com",
      callbackUrl: null,
      providerAccountRef: ACCOUNT_REF
    });
    expect(res.ok).toBe(false);
    sandboxControl.reset();
    const ok = await sandboxAdapter.createCheckoutSession({
      intentId: "i1",
      invoiceId: "inv1",
      amountMinor: 100,
      currency: "IDR",
      endpointHost: "api.provider.com",
      callbackUrl: null,
      providerAccountRef: ACCOUNT_REF
    });
    expect(ok.ok).toBe(true);
    if (ok.ok)
      expect(ok.checkoutUrl.startsWith("https://api.provider.com/")).toBe(true);
  });
});
