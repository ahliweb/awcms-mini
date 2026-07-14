import { describe, expect, test } from "bun:test";

import {
  canTransitionExportJobStatus,
  isExportJobCancellable,
  isExportJobRetryable,
  type ExportJobStatus
} from "../../src/modules/data-exchange/domain/export-job-state";

describe("canTransitionExportJobStatus", () => {
  const allowed: [ExportJobStatus, ExportJobStatus][] = [
    ["queued", "running"],
    ["queued", "cancelled"],
    ["running", "completed"],
    ["running", "failed"],
    ["running", "cancelled"],
    ["failed", "running"]
  ];

  for (const [from, to] of allowed) {
    test(`${from} -> ${to} is allowed`, () => {
      expect(canTransitionExportJobStatus(from, to)).toBe(true);
    });
  }

  const forbidden: [ExportJobStatus, ExportJobStatus][] = [
    ["queued", "completed"],
    ["completed", "running"],
    ["cancelled", "running"],
    ["completed", "cancelled"]
  ];

  for (const [from, to] of forbidden) {
    test(`${from} -> ${to} is forbidden`, () => {
      expect(canTransitionExportJobStatus(from, to)).toBe(false);
    });
  }
});

describe("isExportJobCancellable", () => {
  test("queued/running are cancellable", () => {
    expect(isExportJobCancellable("queued")).toBe(true);
    expect(isExportJobCancellable("running")).toBe(true);
  });

  test("completed/failed/cancelled are not cancellable", () => {
    expect(isExportJobCancellable("completed")).toBe(false);
    expect(isExportJobCancellable("failed")).toBe(false);
    expect(isExportJobCancellable("cancelled")).toBe(false);
  });
});

describe("isExportJobRetryable", () => {
  test("only failed is retryable", () => {
    expect(isExportJobRetryable("failed")).toBe(true);
    expect(isExportJobRetryable("queued")).toBe(false);
    expect(isExportJobRetryable("running")).toBe(false);
    expect(isExportJobRetryable("completed")).toBe(false);
    expect(isExportJobRetryable("cancelled")).toBe(false);
  });
});
