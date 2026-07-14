/**
 * Unit tests for numbering-sequence domain rules (Issue #751) — pure, no
 * I/O. The REAL concurrency-safe allocation lives in `application/
 * document-number-reservation-service.ts` and is exercised by
 * `tests/integration/document-infrastructure-numbering.integration.test.ts`;
 * this file only covers the pure period/counter math those functions
 * build on.
 */
import { describe, expect, test } from "bun:test";

import {
  computeNextSequenceValue,
  computePeriodKey,
  validateCancelReservationInput,
  validateDefineSequenceInput,
  validateReviseSequenceInput
} from "../../src/modules/document-infrastructure/domain/document-number-sequence";

describe("computePeriodKey", () => {
  const date = new Date("2026-07-14T10:00:00Z");

  test("never -> null (no period concept)", () => {
    expect(computePeriodKey("never", date)).toBeNull();
  });

  test("yearly -> YYYY", () => {
    expect(computePeriodKey("yearly", date)).toBe("2026");
  });

  test("monthly -> YYYY-MM", () => {
    expect(computePeriodKey("monthly", date)).toBe("2026-07");
  });

  test("daily -> YYYY-MM-DD", () => {
    expect(computePeriodKey("daily", date)).toBe("2026-07-14");
  });
});

describe("computeNextSequenceValue", () => {
  test("increments within the same period", () => {
    expect(computeNextSequenceValue(5, "2026-07", "2026-07")).toBe(6);
  });

  test("resets to 1 on a period rollover", () => {
    expect(computeNextSequenceValue(99, "2026-06", "2026-07")).toBe(1);
  });

  test("resets to 1 the first time a period-based sequence is used (currentPeriodKey null)", () => {
    expect(computeNextSequenceValue(0, null, "2026-07")).toBe(1);
  });

  test("never rolls over — both period keys stay null, counter just increments", () => {
    expect(computeNextSequenceValue(10, null, null)).toBe(11);
  });
});

describe("validateDefineSequenceInput", () => {
  const BASE = {
    scopeType: "tenant",
    scopeId: null,
    sequenceKey: "invoice",
    formatTemplate: "INV/{YYYY}/{SEQ:6}",
    resetPolicy: "yearly"
  };

  test("accepts a well-formed definition", () => {
    expect(validateDefineSequenceInput(BASE)).toEqual([]);
  });

  test("rejects a non-snake_case scopeType", () => {
    const errors = validateDefineSequenceInput({
      ...BASE,
      scopeType: "Tenant"
    });
    expect(errors.some((e) => e.field === "scopeType")).toBe(true);
  });

  test("rejects a blank (whitespace-only) scopeId", () => {
    const errors = validateDefineSequenceInput({ ...BASE, scopeId: "   " });
    expect(errors.some((e) => e.field === "scopeId")).toBe(true);
  });

  test("rejects an invalid resetPolicy", () => {
    const errors = validateDefineSequenceInput({
      ...BASE,
      resetPolicy: "weekly"
    });
    expect(errors.some((e) => e.field === "resetPolicy")).toBe(true);
  });

  test("propagates formatTemplate validation errors", () => {
    const errors = validateDefineSequenceInput({
      ...BASE,
      formatTemplate: "no-seq-token"
    });
    expect(errors.some((e) => e.field === "formatTemplate")).toBe(true);
  });
});

describe("validateReviseSequenceInput", () => {
  test("requires a non-blank revisionReason", () => {
    const errors = validateReviseSequenceInput({
      formatTemplate: "{SEQ}",
      resetPolicy: "never",
      revisionReason: ""
    });
    expect(errors.some((e) => e.field === "revisionReason")).toBe(true);
  });

  test("accepts a well-formed revision", () => {
    expect(
      validateReviseSequenceInput({
        formatTemplate: "{SEQ:4}",
        resetPolicy: "monthly",
        revisionReason: "Switching to monthly reset per finance request."
      })
    ).toEqual([]);
  });
});

describe("validateCancelReservationInput", () => {
  test("requires a non-blank cancelReason", () => {
    expect(
      validateCancelReservationInput({ cancelReason: "" }).some(
        (e) => e.field === "cancelReason"
      )
    ).toBe(true);
  });

  test("accepts a non-blank cancelReason", () => {
    expect(
      validateCancelReservationInput({
        cancelReason: "Document creation abandoned."
      })
    ).toEqual([]);
  });
});
