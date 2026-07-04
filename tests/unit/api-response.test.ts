import { describe, expect, test } from "bun:test";
import { fail, ok } from "../../src/modules/_shared/api-response";

describe("api response helper", () => {
  test("returns standard success envelope", async () => {
    const response = ok({ status: "ok" }, { requestId: "req_1" });
    expect(await response.json()).toEqual({
      success: true,
      data: { status: "ok" },
      meta: { requestId: "req_1" },
    });
  });

  test("returns standard error envelope", async () => {
    const response = fail(403, "ACCESS_DENIED", "Tidak punya akses.", {
      correlationId: "corr_1",
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      success: false,
      error: {
        code: "ACCESS_DENIED",
        message: "Tidak punya akses.",
        correlationId: "corr_1",
      },
    });
  });
});
