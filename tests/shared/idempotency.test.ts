import { describe, expect, test } from "bun:test";
import {
  computeRequestHash,
  evaluateReplay,
  stableStringify,
  requireIdempotencyKey
} from "../../src/modules/_shared/idempotency";
import { ApiError } from "../../src/modules/_shared/api-error";

describe("idempotency wrapper (doc 10/16)", () => {
  test("stableStringify deterministik terhadap urutan key", () => {
    expect(stableStringify({ b: 1, a: [{ y: 2, x: 1 }] })).toBe(
      stableStringify({ a: [{ x: 1, y: 2 }], b: 1 })
    );
  });

  test("hash berbeda untuk body berbeda", () => {
    const a = computeRequestHash("POST", "/api/v1/x", { qty: 1 });
    const b = computeRequestHash("POST", "/api/v1/x", { qty: 2 });
    expect(a).not.toBe(b);
  });

  test("key sama + hash sama + completed → replay response tersimpan", () => {
    const decision = evaluateReplay(
      {
        key: "k1",
        requestHash: "h1",
        status: "completed",
        responseStatus: 201,
        responseBody: { id: "x" }
      },
      "h1"
    );
    expect(decision).toEqual({ kind: "replay", responseStatus: 201, responseBody: { id: "x" } });
  });

  test("key sama + hash beda → 409 IDEMPOTENCY_CONFLICT", () => {
    expect(() =>
      evaluateReplay({ key: "k1", requestHash: "h1", status: "completed" }, "h2")
    ).toThrow(ApiError);
  });

  test("key belum ada → fresh; in_progress → in_progress", () => {
    expect(evaluateReplay(undefined, "h1")).toEqual({ kind: "fresh" });
    expect(evaluateReplay({ key: "k", requestHash: "h1", status: "in_progress" }, "h1")).toEqual({
      kind: "in_progress"
    });
  });

  test("requireIdempotencyKey menolak request tanpa header", () => {
    const request = new Request("http://localhost/api/v1/x", { method: "POST" });
    expect(() => requireIdempotencyKey(request)).toThrow(ApiError);
    const withKey = new Request("http://localhost/api/v1/x", {
      method: "POST",
      headers: { "Idempotency-Key": "abc" }
    });
    expect(requireIdempotencyKey(withKey)).toBe("abc");
  });
});
