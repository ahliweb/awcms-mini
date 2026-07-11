import { describe, expect, test } from "bun:test";

import {
  safeErrorDetail,
  sanitizeErrorForLog
} from "../../src/lib/logging/error-sanitizer";

describe("sanitizeErrorForLog", () => {
  test("plain Error keeps name/message, redacts nothing when message has no secret shape", () => {
    const detail = sanitizeErrorForLog(new Error("connection refused"));

    expect(detail.name).toBe("Error");
    expect(detail.message).toBe("connection refused");
    expect(detail.cause).toBeUndefined();
  });

  test("redacts a password=value pair embedded in the message", () => {
    const detail = sanitizeErrorForLog(
      new Error("login failed: password=hunter2")
    );

    expect(detail.message).not.toContain("hunter2");
    expect(detail.message).toBe("login failed: password=[REDACTED]");
  });

  test("redacts a JWT embedded in the message", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQ_dGVzdF9zaWduYXR1cmU";
    const detail = sanitizeErrorForLog(new Error(`unexpected value: ${jwt}`));

    expect(detail.message).not.toContain(jwt);
    expect(detail.message).toContain("[REDACTED_JWT]");
  });

  test("redacts a connection-string credential embedded in the message", () => {
    const detail = sanitizeErrorForLog(
      new Error(
        "could not connect to postgres://appuser:s3cr3t@db.internal:5432/awcms"
      )
    );

    expect(detail.message).not.toContain("s3cr3t");
    expect(detail.message).toContain(
      "postgres://[REDACTED]@db.internal:5432/awcms"
    );
  });

  test("walks a nested .cause chain, redacting every level", () => {
    const outer = new Error("outer", {
      cause: new Error("inner: password=hunter2")
    });

    const detail = sanitizeErrorForLog(outer);

    expect(detail.message).toBe("outer");
    expect(detail.cause).toBeDefined();
    expect(detail.cause?.message).toBe("inner: password=[REDACTED]");
    expect(detail.cause?.message).not.toContain("hunter2");
  });

  test("walks a multi-level nested .cause chain", () => {
    const root = new Error("root cause: token=abc123");
    const middle = new Error("middle", { cause: root });
    const outer = new Error("outer", { cause: middle });

    const detail = sanitizeErrorForLog(outer);

    expect(detail.message).toBe("outer");
    expect(detail.cause?.message).toBe("middle");
    expect(detail.cause?.cause?.message).toBe("root cause: token=[REDACTED]");
  });

  // PR #712 follow-up (security review, item 8) — locks in that a genuine
  // circular `.cause` chain (a real possibility: nothing in the language
  // prevents `a.cause = b; b.cause = a;`) terminates in bounded time
  // instead of hanging forever. The implementation was already correct
  // (the walk is bounded by a depth COUNTER, not by novelty-tracking a
  // visited set), this test just proves the scenario the code's own doc
  // comment claims to defend against.
  test("terminates in bounded time on a genuine circular .cause chain", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    // `cause` is normally set once at construction, but nothing in the
    // language (or its type, `unknown`) prevents reassigning it after the
    // fact to create a genuine cycle.
    a.cause = b;

    const detail = sanitizeErrorForLog(a);

    // Must return promptly (bun test's own default timeout would fail this
    // test if the walk ever looped unboundedly) and with a finite,
    // bounded-depth cause chain — never `undefined`/never throws.
    expect(detail.message).toBe("a");
    expect(detail.cause?.message).toBe("b");

    let depth = 0;
    let node: typeof detail | undefined = detail;
    while (node?.cause && depth < 100) {
      node = node.cause;
      depth += 1;
    }

    // Bounded by MAX_CAUSE_DEPTH (5) inside sanitizeErrorForLog — well
    // under the depth<100 escape valve above, proving the walk actually
    // stopped on its own rather than merely being cut off by this test.
    expect(depth).toBeLessThan(10);
  });

  test("a non-Error thrown value is still sanitized safely", () => {
    const detail = sanitizeErrorForLog("plain string with password=hunter2");

    expect(detail.name).toBe("NonErrorValue");
    expect(detail.message).not.toContain("hunter2");
  });

  test("stack, when present, is also redacted", () => {
    const error = new Error("failed with authorization: Bearer abc.def.ghi");
    const detail = sanitizeErrorForLog(error);

    if (detail.stack) {
      expect(detail.stack).not.toContain("abc.def.ghi");
    }
  });
});

describe("safeErrorDetail", () => {
  test("returns the redacted message for an Error", () => {
    expect(safeErrorDetail(new Error("password=hunter2"))).toBe(
      "password=[REDACTED]"
    );
  });

  test("returns a redacted String() fallback for a non-Error value", () => {
    expect(safeErrorDetail("secret=abc123")).toBe("secret=[REDACTED]");
  });

  test("leaves an already-safe message untouched", () => {
    expect(safeErrorDetail(new Error("connection refused"))).toBe(
      "connection refused"
    );
  });
});
