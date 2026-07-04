import { describe, expect, test } from "bun:test";
import { ok, created, fail, toErrorResponse } from "../../src/modules/_shared/api-response";
import { apiError, ApiError } from "../../src/modules/_shared/api-error";

describe("api-response envelope (doc 05/10)", () => {
  test("ok() menghasilkan { success:true, data, meta }", async () => {
    const response = ok({ hello: "world" }, { requestId: "req_1" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ success: true, data: { hello: "world" }, meta: { requestId: "req_1" } });
  });

  test("created() memakai status 201", async () => {
    const response = created({ id: "x" });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.success).toBe(true);
  });

  test("fail() menghasilkan envelope error standard", async () => {
    const response = fail(403, "ACCESS_DENIED", "Tidak punya akses.", {
      correlationId: "corr_1"
    });
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("ACCESS_DENIED");
    expect(body.error.correlationId).toBe("corr_1");
  });

  test("toErrorResponse memetakan ApiError sesuai status/code", async () => {
    const response = toErrorResponse(apiError("RESOURCE_NOT_FOUND", "Tidak ada."));
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("RESOURCE_NOT_FOUND");
  });

  test("toErrorResponse menyembunyikan error internal (tanpa stack/pesan asli)", async () => {
    const response = toErrorResponse(new Error("rahasia stack trace"));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(body)).not.toContain("rahasia");
  });

  test("ApiError menyimpan status/code/details", () => {
    const error = new ApiError({
      status: 400,
      code: "VALIDATION_ERROR",
      message: "Data tidak valid.",
      details: [{ field: "name", message: "wajib" }]
    });
    expect(error.status).toBe(400);
    expect(error.details?.[0]?.field).toBe("name");
  });
});
