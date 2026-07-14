import { describe, expect, test } from "bun:test";

import {
  canTransitionImportBatchStatus,
  isImportBatchCancellable,
  isImportBatchRetryable,
  isTerminalImportBatchStatus,
  type ImportBatchStatus
} from "../../src/modules/data-exchange/domain/import-batch-state";

describe("canTransitionImportBatchStatus", () => {
  const allowed: [ImportBatchStatus, ImportBatchStatus][] = [
    ["staged", "validating"],
    ["staged", "cancelled"],
    ["validating", "previewed"],
    ["validating", "failed"],
    ["validating", "cancelled"],
    ["previewed", "committing"],
    ["previewed", "cancelled"],
    ["committing", "committed"],
    ["committing", "partially_committed"],
    ["committing", "committing"],
    ["partially_committed", "committing"],
    ["failed", "committing"],
    ["failed", "cancelled"]
  ];

  for (const [from, to] of allowed) {
    test(`${from} -> ${to} is allowed`, () => {
      expect(canTransitionImportBatchStatus(from, to)).toBe(true);
    });
  }

  const forbidden: [ImportBatchStatus, ImportBatchStatus][] = [
    ["staged", "committed"],
    ["staged", "previewed"],
    ["committed", "committing"],
    ["committed", "cancelled"],
    ["cancelled", "staged"],
    ["previewed", "staged"],
    ["partially_committed", "committed"],
    ["partially_committed", "cancelled"]
  ];

  for (const [from, to] of forbidden) {
    test(`${from} -> ${to} is forbidden`, () => {
      expect(canTransitionImportBatchStatus(from, to)).toBe(false);
    });
  }
});

describe("isTerminalImportBatchStatus", () => {
  test("committed and cancelled are terminal", () => {
    expect(isTerminalImportBatchStatus("committed")).toBe(true);
    expect(isTerminalImportBatchStatus("cancelled")).toBe(true);
  });

  test("every other status is non-terminal", () => {
    const nonTerminal: ImportBatchStatus[] = [
      "staged",
      "validating",
      "previewed",
      "committing",
      "partially_committed",
      "failed"
    ];
    for (const status of nonTerminal) {
      expect(isTerminalImportBatchStatus(status)).toBe(false);
    }
  });
});

describe("isImportBatchCancellable", () => {
  test("staged/validating/previewed/failed are cancellable", () => {
    expect(isImportBatchCancellable("staged")).toBe(true);
    expect(isImportBatchCancellable("validating")).toBe(true);
    expect(isImportBatchCancellable("previewed")).toBe(true);
    expect(isImportBatchCancellable("failed")).toBe(true);
  });

  test("committing/committed/partially_committed/cancelled are NOT cancellable", () => {
    expect(isImportBatchCancellable("committing")).toBe(false);
    expect(isImportBatchCancellable("committed")).toBe(false);
    expect(isImportBatchCancellable("partially_committed")).toBe(false);
    expect(isImportBatchCancellable("cancelled")).toBe(false);
  });
});

describe("isImportBatchRetryable", () => {
  test("only partially_committed and failed are retryable", () => {
    expect(isImportBatchRetryable("partially_committed")).toBe(true);
    expect(isImportBatchRetryable("failed")).toBe(true);
  });

  test("every other status is not retryable", () => {
    const notRetryable: ImportBatchStatus[] = [
      "staged",
      "validating",
      "previewed",
      "committing",
      "committed",
      "cancelled"
    ];
    for (const status of notRetryable) {
      expect(isImportBatchRetryable(status)).toBe(false);
    }
  });
});
