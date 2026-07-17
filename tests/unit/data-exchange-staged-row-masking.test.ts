/**
 * Staged-row preview masking (Issue #820, Cacat 1 and Cacat 4).
 *
 * These cover the projection helpers in isolation. The decision of WHICH
 * projection a request gets — the part that was actually broken — is
 * covered against the real route in
 * `tests/integration/data-exchange.integration.test.ts`, since a correct
 * helper that the route never reaches for is precisely the defect class
 * this issue is about.
 */
import { describe, expect, test } from "bun:test";

import {
  maskAllFields,
  maskSensitiveFields,
  PREVIEW_OFFSET_MAX,
  type StagedRowRow
} from "../../src/modules/data-exchange/application/staged-row-directory";
import { MAX_EXCHANGE_ROW_COUNT } from "../../src/modules/data-exchange/domain/exchange-registry";

function row(overrides: Partial<StagedRowRow> = {}): StagedRowRow {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    importBatchId: "00000000-0000-0000-0000-000000000002",
    rowNumber: 1,
    fields: { email: "person@example.com", nik: "3201000000000001", note: "x" },
    naturalKey: "person@example.com",
    proposedAction: "create",
    validationErrors: null,
    validationWarnings: null,
    commitStatus: "pending",
    commitResourceId: null,
    commitError: null,
    committedAt: null,
    ...overrides
  };
}

describe("maskSensitiveFields", () => {
  test("masks only the declared fields", () => {
    const masked = maskSensitiveFields(row(), { fieldNames: ["email", "nik"] });
    expect(masked.fields.email).toBe("[REDACTED]");
    expect(masked.fields.nik).toBe("[REDACTED]");
    expect(masked.fields.note).toBe("x");
  });

  test("masks naturalKey when naturalKeyField is itself sensitive (Cacat 4)", () => {
    const masked = maskSensitiveFields(row(), {
      fieldNames: ["email"],
      naturalKeyField: "email"
    });
    // Masking `fields.email` while echoing the same value back as
    // naturalKey would have masked nothing at all — a profile import's
    // dedup key IS the identifier.
    expect(masked.naturalKey).toBe("[REDACTED]");
  });

  test("leaves naturalKey alone when its source field is not sensitive", () => {
    const masked = maskSensitiveFields(row({ naturalKey: "widget-a" }), {
      fieldNames: ["email"],
      naturalKeyField: "code"
    });
    expect(masked.naturalKey).toBe("widget-a");
    expect(masked.fields.email).toBe("[REDACTED]");
  });

  test("leaves naturalKey alone when no naturalKeyField is declared", () => {
    const masked = maskSensitiveFields(row(), { fieldNames: ["email"] });
    expect(masked.naturalKey).toBe("person@example.com");
  });

  test("a null naturalKey stays null rather than becoming a redaction marker", () => {
    const masked = maskSensitiveFields(row({ naturalKey: null }), {
      fieldNames: ["email"],
      naturalKeyField: "email"
    });
    expect(masked.naturalKey).toBeNull();
  });

  test("an empty fieldNames policy is a pass-through", () => {
    const original = row();
    expect(maskSensitiveFields(original, { fieldNames: [] })).toBe(original);
  });

  test("does not mutate the input row", () => {
    const original = row();
    maskSensitiveFields(original, {
      fieldNames: ["email"],
      naturalKeyField: "email"
    });
    expect(original.fields.email).toBe("person@example.com");
    expect(original.naturalKey).toBe("person@example.com");
  });
});

describe("maskAllFields (default-deny projection, Cacat 1)", () => {
  test("redacts every field value and the naturalKey", () => {
    const masked = maskAllFields(row());
    expect(Object.values(masked.fields)).toEqual([
      "[REDACTED]",
      "[REDACTED]",
      "[REDACTED]"
    ]);
    expect(masked.naturalKey).toBe("[REDACTED]");
  });

  test("keeps field NAMES and non-content metadata so the preview stays navigable", () => {
    const masked = maskAllFields(row());
    expect(Object.keys(masked.fields)).toEqual(["email", "nik", "note"]);
    expect(masked.rowNumber).toBe(1);
    expect(masked.proposedAction).toBe("create");
    expect(masked.commitStatus).toBe("pending");
  });

  test("keeps validationErrors (field name + message) but drops free-text warnings", () => {
    const masked = maskAllFields(
      row({
        validationErrors: [{ field: "nik", message: "must be 16 digits" }],
        // A warning is free text an adapter may have interpolated a raw
        // value into — it cannot be masked field-wise, so it is dropped.
        validationWarnings: ["value 3201000000000001 looks suspicious"]
      })
    );
    expect(masked.validationErrors).toEqual([
      { field: "nik", message: "must be 16 digits" }
    ]);
    expect(masked.validationWarnings).toEqual([]);
  });

  test("a null naturalKey stays null", () => {
    expect(maskAllFields(row({ naturalKey: null })).naturalKey).toBeNull();
  });

  test("does not mutate the input row", () => {
    const original = row();
    maskAllFields(original);
    expect(original.fields.email).toBe("person@example.com");
    expect(original.naturalKey).toBe("person@example.com");
  });
});

describe("PREVIEW_OFFSET_MAX (Issue #831)", () => {
  test("equals the registry's hard cap on rows per batch, so it hides no reachable row", () => {
    expect(PREVIEW_OFFSET_MAX).toBe(MAX_EXCHANGE_ROW_COUNT);
  });
});
