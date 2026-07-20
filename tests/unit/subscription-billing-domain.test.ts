/**
 * `subscription_billing` domain unit tests (Issue #876, epic #868, ADR-0022).
 * The FAST, DB-free layer that pins the mutation-critical invariants:
 *   - money is EXACT minor units — a float or an overflow is REJECTED (the
 *     mutation test target: introducing float arithmetic must fail here);
 *   - rounding policy is explicit and reproducible;
 *   - subscription + invoice state machines are forward-legal only;
 *   - period math is deterministic;
 *   - the fail-closed request parser + validator tri-state (present-wrong-type
 *     -> validation error, never coerced).
 */
import { describe, expect, test } from "bun:test";

import {
  assertSafeMinor,
  divideRounded,
  isSafeMinor,
  multiplyMinor,
  prorateMinor,
  sumMinor,
  MAX_SAFE_MINOR
} from "../../src/modules/subscription-billing/domain/money";
import {
  isLegalSubscriptionTransition,
  isTerminalSubscriptionState
} from "../../src/modules/subscription-billing/domain/subscription-state";
import { isLegalInvoiceTransition } from "../../src/modules/subscription-billing/domain/invoice-state";
import {
  daysInPeriod,
  elapsedDays,
  nextPeriodEnd
} from "../../src/modules/subscription-billing/domain/period";
import {
  validateCreditNote,
  validatePaymentAllocation
} from "../../src/modules/subscription-billing/domain/request-validation";
import {
  parseCreditNoteBody,
  parsePaymentAllocationBody
} from "../../src/modules/subscription-billing/application/request-parsing";

describe("money — EXACT minor units (mutation-critical)", () => {
  test("a float amount is rejected (never a valid minor-unit value)", () => {
    expect(isSafeMinor(10.5)).toBe(false);
    expect(isSafeMinor(0.1)).toBe(false);
    expect(isSafeMinor(NaN)).toBe(false);
    expect(isSafeMinor(Infinity)).toBe(false);
    expect(() => assertSafeMinor(10.5, "x")).toThrow();
  });

  test("a safe integer within range is accepted; out-of-range is rejected", () => {
    expect(isSafeMinor(0)).toBe(true);
    expect(isSafeMinor(9900000)).toBe(true);
    expect(isSafeMinor(MAX_SAFE_MINOR)).toBe(true);
    expect(isSafeMinor(-MAX_SAFE_MINOR)).toBe(true);
    expect(isSafeMinor(MAX_SAFE_MINOR + 1)).toBe(false);
  });

  test("sumMinor / multiplyMinor overflow-guard (mutation: overflow must fail)", () => {
    expect(sumMinor([100, 200, 300])).toBe(600);
    expect(multiplyMinor(1000, 3)).toBe(3000);
    expect(() => sumMinor([MAX_SAFE_MINOR, MAX_SAFE_MINOR])).toThrow();
    expect(() => multiplyMinor(MAX_SAFE_MINOR, 2)).toThrow();
  });

  test("rounding policy is explicit and exact on the remainder", () => {
    // 10/3 = 3.333...
    expect(divideRounded(10n, 3n, "floor")).toBe(3n);
    expect(divideRounded(10n, 3n, "ceil")).toBe(4n);
    expect(divideRounded(10n, 3n, "half_up")).toBe(3n);
    // 5/2 = 2.5 -> half_up rounds up, half_even to even (2)
    expect(divideRounded(5n, 2n, "half_up")).toBe(3n);
    expect(divideRounded(5n, 2n, "half_even")).toBe(2n);
    // 7/2 = 3.5 -> half_even to even (4)
    expect(divideRounded(7n, 2n, "half_even")).toBe(4n);
  });

  test("prorateMinor is exact (BigInt), never a float", () => {
    // 9900000 * 15 / 30 = 4950000 exact
    expect(prorateMinor(9900000, 15, 30, "half_up")).toBe(4950000);
    // 100 * 1 / 3 = 33.33 -> half_up = 33
    expect(prorateMinor(100, 1, 3, "half_up")).toBe(33);
    expect(prorateMinor(100, 1, 3, "ceil")).toBe(34);
    expect(() => prorateMinor(100, 4, 3, "half_up")).toThrow(); // numerator > denominator
  });
});

describe("subscription state machine", () => {
  test("forward-legal transitions only", () => {
    expect(isLegalSubscriptionTransition("pending", "active")).toBe(true);
    expect(isLegalSubscriptionTransition("active", "past_due")).toBe(true);
    expect(isLegalSubscriptionTransition("past_due", "active")).toBe(true);
    expect(isLegalSubscriptionTransition("active", "canceled")).toBe(true);
    // illegal
    expect(isLegalSubscriptionTransition("canceled", "active")).toBe(false);
    expect(isLegalSubscriptionTransition("expired", "active")).toBe(false);
    expect(isLegalSubscriptionTransition("pending", "past_due")).toBe(false);
  });
  test("canceled/expired are terminal", () => {
    expect(isTerminalSubscriptionState("canceled")).toBe(true);
    expect(isTerminalSubscriptionState("expired")).toBe(true);
    expect(isTerminalSubscriptionState("active")).toBe(false);
  });
});

describe("invoice state machine", () => {
  test("draft -> issued|void; issued -> paid|void; paid/void terminal", () => {
    expect(isLegalInvoiceTransition("draft", "issued")).toBe(true);
    expect(isLegalInvoiceTransition("draft", "void")).toBe(true);
    expect(isLegalInvoiceTransition("issued", "paid")).toBe(true);
    expect(isLegalInvoiceTransition("issued", "void")).toBe(true);
    // illegal — an issued invoice can never go back to draft; paid is terminal
    expect(isLegalInvoiceTransition("issued", "draft")).toBe(false);
    expect(isLegalInvoiceTransition("paid", "void")).toBe(false);
    expect(isLegalInvoiceTransition("void", "issued")).toBe(false);
    expect(isLegalInvoiceTransition("draft", "paid")).toBe(false);
  });
});

describe("period math", () => {
  test("nextPeriodEnd advances by interval (UTC)", () => {
    const start = new Date("2026-01-15T00:00:00.000Z");
    expect(nextPeriodEnd(start, "month").toISOString()).toBe(
      "2026-02-15T00:00:00.000Z"
    );
    expect(nextPeriodEnd(start, "year").toISOString()).toBe(
      "2027-01-15T00:00:00.000Z"
    );
  });
  test("daysInPeriod / elapsedDays are deterministic and clamped", () => {
    const start = new Date("2026-01-01T00:00:00.000Z");
    const end = new Date("2026-01-31T00:00:00.000Z");
    expect(daysInPeriod(start, end)).toBe(30);
    expect(elapsedDays(start, end, new Date("2026-01-16T00:00:00.000Z"))).toBe(
      15
    );
    expect(elapsedDays(start, end, new Date("2025-12-01T00:00:00.000Z"))).toBe(
      0
    );
    expect(elapsedDays(start, end, new Date("2027-01-01T00:00:00.000Z"))).toBe(
      30
    );
  });
});

describe("request parser + validator — fail-closed tri-state (mutation: float amount rejected)", () => {
  test("credit note: a float amountMinor is a 400 (parsed verbatim, validator rejects)", () => {
    const parsed = parseCreditNoteBody({ amountMinor: 10.5, reason: "x" });
    expect(parsed.amountMinor).toBe(10.5); // verbatim, NOT coerced
    const errors = validateCreditNote(parsed);
    expect(errors.some((e) => e.field === "amountMinor")).toBe(true);
  });
  test("credit note: absent amount -> NaN -> rejected", () => {
    const parsed = parseCreditNoteBody({ reason: "x" });
    expect(Number.isNaN(parsed.amountMinor)).toBe(true);
    expect(
      validateCreditNote(parsed).some((e) => e.field === "amountMinor")
    ).toBe(true);
  });
  test("credit note: a valid positive integer passes", () => {
    const parsed = parseCreditNoteBody({ amountMinor: 5000, reason: "refund" });
    expect(validateCreditNote(parsed)).toEqual([]);
  });
  test("payment allocation: a float amount is rejected", () => {
    const parsed = parsePaymentAllocationBody({
      amountMinor: 12.34,
      allocationSource: "manual"
    });
    expect(
      validatePaymentAllocation(parsed).some((e) => e.field === "amountMinor")
    ).toBe(true);
  });
  test("payment allocation: a signed integer (reversal) passes", () => {
    const parsed = parsePaymentAllocationBody({
      amountMinor: -5000,
      allocationSource: "provider",
      outcome: "reversed",
      providerReference: "ref-1"
    });
    expect(validatePaymentAllocation(parsed)).toEqual([]);
  });
});
