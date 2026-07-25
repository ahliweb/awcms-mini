/**
 * Unit tests for the evidence-export window and shape (Issue #930 Wave 5).
 *
 * The bounding rules are pure, so they are tested without a database. The
 * property that matters most is not that clamping happens — it is that
 * clamping is REPORTED. "You asked for a year and got 90 days" and "this
 * tenant had no activity before 90 days ago" produce identical-looking data
 * and mean opposite things; an operator who cannot tell them apart will draw
 * the wrong conclusion from a quiet export.
 */
import { describe, expect, test } from "bun:test";

import {
  EVIDENCE_MAX_WINDOW_DAYS,
  EVIDENCE_SECTION_ROW_LIMIT,
  resolveEvidenceWindow
} from "../../src/modules/logging/application/control-plane-evidence";

const NOW = new Date("2026-07-25T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function daysBefore(reference: Date, days: number): Date {
  return new Date(reference.getTime() - days * DAY_MS);
}

describe("evidence window bounding", () => {
  test("no window requested falls back to the maximum, and is NOT reported as clamped", () => {
    // Nothing was narrowed — the operator expressed no preference — so
    // flagging this as clamped would cry wolf on the default path and train
    // operators to ignore the flag when it matters.
    const window = resolveEvidenceWindow(null, null, NOW);

    expect(window.to).toEqual(NOW);
    expect(window.from).toEqual(daysBefore(NOW, EVIDENCE_MAX_WINDOW_DAYS));
    expect(window.clamped).toBe(false);
  });

  test("a window wider than the cap is narrowed AND reported", () => {
    const window = resolveEvidenceWindow(daysBefore(NOW, 365), null, NOW);

    expect(window.from).toEqual(daysBefore(NOW, EVIDENCE_MAX_WINDOW_DAYS));
    expect(window.clamped).toBe(true);
  });

  test("a window inside the cap is honoured exactly", () => {
    const from = daysBefore(NOW, 7);
    const window = resolveEvidenceWindow(from, null, NOW);

    expect(window.from).toEqual(from);
    expect(window.clamped).toBe(false);
  });

  test("a `to` in the future is treated as now — an operator cannot widen the window forward", () => {
    const future = new Date(NOW.getTime() + 30 * DAY_MS);
    const window = resolveEvidenceWindow(null, future, NOW);

    expect(window.to).toEqual(NOW);
  });

  test("the cap is measured from `to`, not from now, so a historical window is a full span", () => {
    // Investigating an incident from six months ago must still yield 90 days
    // of context around it, not zero rows because the whole window is older
    // than "90 days before now".
    const to = daysBefore(NOW, 180);
    const window = resolveEvidenceWindow(daysBefore(NOW, 365), to, NOW);

    expect(window.to).toEqual(to);
    expect(window.from).toEqual(daysBefore(to, EVIDENCE_MAX_WINDOW_DAYS));
    expect(window.clamped).toBe(true);
  });

  test("the caps are the documented ones", () => {
    // Pinned because both numbers appear in the OpenAPI description and the
    // runbook; changing one silently would make the published contract wrong.
    expect(EVIDENCE_MAX_WINDOW_DAYS).toBe(90);
    expect(EVIDENCE_SECTION_ROW_LIMIT).toBe(100);
  });
});
