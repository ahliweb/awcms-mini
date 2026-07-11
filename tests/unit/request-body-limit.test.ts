import { describe, expect, test } from "bun:test";

import {
  BODY_SIZE_HARD_CEILING_BYTES,
  BODY_SIZE_TIER_BYTES,
  bodyTooLargeResponse,
  checkContentLengthCeiling,
  readFormBody,
  readJsonBody,
  readTextBody
} from "../../src/lib/security/request-body-limit";

function jsonRequest(body: string, overrideContentLength?: number): Request {
  const headers = new Headers({ "content-type": "application/json" });

  if (overrideContentLength !== undefined) {
    headers.set("content-length", String(overrideContentLength));
  }

  return new Request("https://example.test/api/v1/example", {
    method: "POST",
    headers,
    body
  });
}

/**
 * No `Content-Length` at all (the runtime does not auto-compute one for a
 * stream body) — exercises the byte-counting read path, not the
 * declared-length short-circuit.
 */
function streamedRequest(totalBytes: number): Request {
  const chunk = new Uint8Array(1024).fill(97); // 'a' repeated
  let remaining = totalBytes;

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (remaining <= 0) {
        controller.close();
        return;
      }

      const size = Math.min(chunk.byteLength, remaining);
      controller.enqueue(chunk.slice(0, size));
      remaining -= size;
    }
  });

  return new Request("https://example.test/api/v1/example", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: stream,
    // @ts-expect-error -- required by the fetch spec for a streamed body,
    // not yet in the DOM lib type for RequestInit in this TS target.
    duplex: "half"
  });
}

describe("readJsonBody", () => {
  test("valid JSON well within the tier limit parses successfully", async () => {
    const result = await readJsonBody(jsonRequest('{"a":1}'));

    expect(result.tooLarge).toBe(false);
    if (!result.tooLarge) {
      expect(result.value).toEqual({ a: 1 });
    }
  });

  test("empty body yields value: null (same as request.json().catch(() => null))", async () => {
    const result = await readJsonBody(jsonRequest(""));

    expect(result.tooLarge).toBe(false);
    if (!result.tooLarge) {
      expect(result.value).toBeNull();
    }
  });

  test("malformed JSON yields value: null, not tooLarge — a distinct 400 path from 413", async () => {
    const result = await readJsonBody(jsonRequest("{not valid json"));

    expect(result.tooLarge).toBe(false);
    if (!result.tooLarge) {
      expect(result.value).toBeNull();
    }
  });

  test("declared Content-Length above the default tier is rejected without reading the body", async () => {
    const oversizedDeclared = BODY_SIZE_TIER_BYTES.default + 1;
    const result = await readJsonBody(
      jsonRequest('{"a":1}', oversizedDeclared)
    );

    expect(result.tooLarge).toBe(true);
    if (result.tooLarge) {
      expect(result.limitBytes).toBe(BODY_SIZE_TIER_BYTES.default);
    }
  });

  test("boundary size exactly at the tier limit succeeds", async () => {
    // A JSON string value padded to land the whole body exactly at the limit.
    const limit = BODY_SIZE_TIER_BYTES.default;
    const padding = "a".repeat(limit - '{"a":""}'.length);
    const body = `{"a":"${padding}"}`;
    expect(new TextEncoder().encode(body).byteLength).toBe(limit);

    const result = await readJsonBody(jsonRequest(body));
    expect(result.tooLarge).toBe(false);
  });

  test("streamed body (no Content-Length) exceeding the tier limit is rejected mid-stream", async () => {
    const result = await readJsonBody(
      streamedRequest(BODY_SIZE_TIER_BYTES.default + 1)
    );

    expect(result.tooLarge).toBe(true);
    if (result.tooLarge) {
      expect(result.limitBytes).toBe(BODY_SIZE_TIER_BYTES.default);
    }
  });

  test("streamed body within the tier limit succeeds", async () => {
    const result = await readTextBody(
      streamedRequest(BODY_SIZE_TIER_BYTES.default - 10)
    );

    expect(result.tooLarge).toBe(false);
    if (!result.tooLarge) {
      expect(result.value.length).toBe(BODY_SIZE_TIER_BYTES.default - 10);
    }
  });

  test("a declared Content-Length that lies (too small) does not bypass the streamed-byte cap", async () => {
    // Declares a tiny Content-Length but the stream itself carries more
    // bytes than the tier allows — the running byte count must still catch
    // it, since Content-Length is attacker-controlled and not trustworthy
    // on its own.
    const stream = streamedRequest(BODY_SIZE_TIER_BYTES.default + 1);
    stream.headers.set("content-length", "10");

    const result = await readJsonBody(stream);
    expect(result.tooLarge).toBe(true);
  });

  test("the large tier accepts a body too big for the default tier", async () => {
    const size = BODY_SIZE_TIER_BYTES.default + 1024;
    const result = await readTextBody(streamedRequest(size), "large");

    expect(result.tooLarge).toBe(false);
  });
});

describe("readTextBody", () => {
  test("returns the raw text unmodified when within the limit", async () => {
    const result = await readTextBody(jsonRequest("raw-body-text"));

    expect(result.tooLarge).toBe(false);
    if (!result.tooLarge) {
      expect(result.value).toBe("raw-body-text");
    }
  });
});

describe("readFormBody", () => {
  test("parses application/x-www-form-urlencoded within the limit", async () => {
    const request = new Request("https://example.test/api/v1/example", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "field=value"
    });

    const result = await readFormBody(request);

    expect(result.tooLarge).toBe(false);
    if (!result.tooLarge) {
      expect(result.value?.get("field")).toBe("value");
    }
  });

  test("declared Content-Length above the limit is rejected", async () => {
    const request = new Request("https://example.test/api/v1/example", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "content-length": String(BODY_SIZE_TIER_BYTES.default + 1)
      },
      body: "field=value"
    });

    const result = await readFormBody(request);
    expect(result.tooLarge).toBe(true);
  });
});

describe("bodyTooLargeResponse", () => {
  test("returns a 413 with the standard error envelope shape", async () => {
    const response = bodyTooLargeResponse(BODY_SIZE_TIER_BYTES.default);

    expect(response.status).toBe(413);
    const body = (await response.json()) as {
      success: boolean;
      error: { code: string };
    };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  test("sends Connection: close so a keep-alive client doesn't reuse a connection with an undrained body (security-auditor finding, PR #704)", () => {
    const response = bodyTooLargeResponse(BODY_SIZE_TIER_BYTES.default);

    expect(response.headers.get("connection")).toBe("close");
  });
});

describe("checkContentLengthCeiling (middleware backstop)", () => {
  test("allows a request with no Content-Length header", () => {
    const request = new Request("https://example.test/api/v1/example");
    expect(checkContentLengthCeiling(request)).toBe(true);
  });

  test("allows a request declared at or below the hard ceiling", () => {
    const request = new Request("https://example.test/api/v1/example", {
      headers: { "content-length": String(BODY_SIZE_HARD_CEILING_BYTES) }
    });
    expect(checkContentLengthCeiling(request)).toBe(true);
  });

  test("rejects a request declared above the hard ceiling", () => {
    const request = new Request("https://example.test/api/v1/example", {
      headers: {
        "content-length": String(BODY_SIZE_HARD_CEILING_BYTES + 1)
      }
    });
    expect(checkContentLengthCeiling(request)).toBe(false);
  });
});

describe("tier configuration invariant", () => {
  test("no tier exceeds the documented hard ceiling", () => {
    for (const bytes of Object.values(BODY_SIZE_TIER_BYTES)) {
      expect(bytes).toBeLessThanOrEqual(BODY_SIZE_HARD_CEILING_BYTES);
    }
  });
});
