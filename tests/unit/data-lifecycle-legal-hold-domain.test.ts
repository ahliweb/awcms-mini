/**
 * Unit tests for the legal hold PURE domain rules (Issue #745) —
 * `evaluateLegalHoldForDescriptor`/`isLegalHoldActive`/validation. No
 * database. The critical invariant under test: "legal hold overrides
 * ordinary retention/purge and cannot be silently bypassed by tenant
 * policy" — this file proves the MATCHING logic itself is correct in
 * isolation; `tests/integration/data-lifecycle-dry-run.integration.test.ts`
 * proves the SAME logic actually blocks purge end-to-end against real
 * Postgres.
 */
import { describe, expect, test } from "bun:test";

import {
  evaluateLegalHoldForDescriptor,
  isLegalHoldActive,
  validateCreateLegalHoldInput,
  validateReleaseLegalHoldInput,
  type LegalHoldRecord
} from "../../src/modules/data-lifecycle/domain/legal-hold";

function hold(overrides: Partial<LegalHoldRecord> = {}): LegalHoldRecord {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    tenantId: "22222222-2222-2222-2222-222222222222",
    descriptorKey: "logging.audit_events",
    status: "active",
    ...overrides
  };
}

describe("isLegalHoldActive", () => {
  test("true only for status active", () => {
    expect(isLegalHoldActive({ status: "active" })).toBe(true);
    expect(isLegalHoldActive({ status: "released" })).toBe(false);
  });
});

describe("evaluateLegalHoldForDescriptor", () => {
  test("no holds at all -> not held", () => {
    const result = evaluateLegalHoldForDescriptor([], "logging.audit_events");
    expect(result.held).toBe(false);
    expect(result.matchedHoldIds).toEqual([]);
  });

  test("a hold targeting the exact same descriptor key -> held", () => {
    const targeted = hold({ descriptorKey: "logging.audit_events" });
    const result = evaluateLegalHoldForDescriptor(
      [targeted],
      "logging.audit_events"
    );

    expect(result.held).toBe(true);
    expect(result.matchedHoldIds).toEqual([targeted.id]);
  });

  test("a hold targeting a DIFFERENT descriptor key -> not held", () => {
    const other = hold({ descriptorKey: "visitor_analytics.visit_events" });
    const result = evaluateLegalHoldForDescriptor(
      [other],
      "logging.audit_events"
    );

    expect(result.held).toBe(false);
  });

  test("a tenant-wide hold (descriptorKey: null) applies to EVERY descriptor", () => {
    const tenantWide = hold({ descriptorKey: null });

    expect(
      evaluateLegalHoldForDescriptor([tenantWide], "logging.audit_events").held
    ).toBe(true);
    expect(
      evaluateLegalHoldForDescriptor([tenantWide], "form_drafts.form_drafts")
        .held
    ).toBe(true);
    expect(
      evaluateLegalHoldForDescriptor([tenantWide], "anything.at_all").held
    ).toBe(true);
  });

  test("a RELEASED hold never applies, even if it targets the exact descriptor or is tenant-wide", () => {
    const released = hold({
      descriptorKey: "logging.audit_events",
      status: "released"
    });
    const releasedTenantWide = hold({
      descriptorKey: null,
      status: "released"
    });

    expect(
      evaluateLegalHoldForDescriptor([released], "logging.audit_events").held
    ).toBe(false);
    expect(
      evaluateLegalHoldForDescriptor(
        [releasedTenantWide],
        "logging.audit_events"
      ).held
    ).toBe(false);
  });

  test("multiple holds: matchedHoldIds includes every matching active hold, not just the first", () => {
    const first = hold({
      id: "aaaaaaaa-0000-0000-0000-000000000001",
      descriptorKey: null
    });
    const second = hold({
      id: "aaaaaaaa-0000-0000-0000-000000000002",
      descriptorKey: "logging.audit_events"
    });
    const unrelated = hold({
      id: "aaaaaaaa-0000-0000-0000-000000000003",
      descriptorKey: "form_drafts.form_drafts"
    });

    const result = evaluateLegalHoldForDescriptor(
      [first, second, unrelated],
      "logging.audit_events"
    );

    expect(result.held).toBe(true);
    expect(result.matchedHoldIds.sort()).toEqual([first.id, second.id].sort());
  });

  test("mixed active/released holds for the same descriptor: only the active one counts", () => {
    const releasedOne = hold({
      id: "aaaaaaaa-0000-0000-0000-000000000001",
      descriptorKey: "logging.audit_events",
      status: "released"
    });
    const activeOne = hold({
      id: "aaaaaaaa-0000-0000-0000-000000000002",
      descriptorKey: "logging.audit_events",
      status: "active"
    });

    const result = evaluateLegalHoldForDescriptor(
      [releasedOne, activeOne],
      "logging.audit_events"
    );

    expect(result.held).toBe(true);
    expect(result.matchedHoldIds).toEqual([activeOne.id]);
  });
});

describe("validateCreateLegalHoldInput", () => {
  const validInput = {
    descriptorKey: null,
    scopeDescription: "All sales records related to case #123.",
    reason: "Ongoing litigation regarding contract dispute.",
    authorityReference: "District Court Order No. 45/PID/2026",
    endsAt: null
  };

  test("accepts a fully valid tenant-wide hold input", () => {
    expect(validateCreateLegalHoldInput(validInput)).toEqual([]);
  });

  test("accepts a fully valid descriptor-scoped hold input", () => {
    expect(
      validateCreateLegalHoldInput({
        ...validInput,
        descriptorKey: "logging.audit_events"
      })
    ).toEqual([]);
  });

  test("rejects an empty or too-short reason", () => {
    const empty = validateCreateLegalHoldInput({ ...validInput, reason: "" });
    expect(empty.some((error) => error.field === "reason")).toBe(true);

    const short = validateCreateLegalHoldInput({
      ...validInput,
      reason: "too short"
    });
    expect(short.some((error) => error.field === "reason")).toBe(true);
  });

  test("rejects a missing authorityReference", () => {
    const errors = validateCreateLegalHoldInput({
      ...validInput,
      authorityReference: ""
    });
    expect(errors.some((error) => error.field === "authorityReference")).toBe(
      true
    );
  });

  test("rejects a missing scopeDescription", () => {
    const errors = validateCreateLegalHoldInput({
      ...validInput,
      scopeDescription: ""
    });
    expect(errors.some((error) => error.field === "scopeDescription")).toBe(
      true
    );
  });

  test("rejects an invalid endsAt date", () => {
    const errors = validateCreateLegalHoldInput({
      ...validInput,
      endsAt: new Date("not-a-real-date")
    });
    expect(errors.some((error) => error.field === "endsAt")).toBe(true);
  });

  test("rejects an empty-string descriptorKey (must be null for tenant-wide, not empty string)", () => {
    const errors = validateCreateLegalHoldInput({
      ...validInput,
      descriptorKey: ""
    });
    expect(errors.some((error) => error.field === "descriptorKey")).toBe(true);
  });
});

describe("validateReleaseLegalHoldInput", () => {
  test("accepts a sufficiently long releaseReason", () => {
    expect(
      validateReleaseLegalHoldInput({
        releaseReason: "Litigation concluded, hold no longer needed."
      })
    ).toEqual([]);
  });

  test("rejects an empty or too-short releaseReason — release is reason-required, same as create", () => {
    const empty = validateReleaseLegalHoldInput({ releaseReason: "" });
    expect(empty.some((error) => error.field === "releaseReason")).toBe(true);

    const short = validateReleaseLegalHoldInput({ releaseReason: "done" });
    expect(short.some((error) => error.field === "releaseReason")).toBe(true);
  });
});
