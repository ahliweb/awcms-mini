import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  getLogSink,
  log,
  setLogSink,
  type LogEntry
} from "../src/lib/logging/logger";

describe("structured JSON logger", () => {
  let originalLogLevel: string | undefined;
  let originalConsoleLog: typeof console.log;
  let lines: string[];

  beforeEach(() => {
    originalLogLevel = process.env.LOG_LEVEL;
    originalConsoleLog = console.log;
    lines = [];
    console.log = (line: string) => {
      lines.push(line);
    };
  });

  afterEach(() => {
    console.log = originalConsoleLog;

    if (originalLogLevel === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = originalLogLevel;
    }
  });

  test("writes one JSON line with timestamp, level, and message", () => {
    process.env.LOG_LEVEL = "info";
    log("info", "hello world", { moduleKey: "logging" });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);

    expect(parsed.level).toBe("info");
    expect(parsed.message).toBe("hello world");
    expect(parsed.moduleKey).toBe("logging");
    expect(typeof parsed.timestamp).toBe("string");
  });

  test("default LOG_LEVEL=info suppresses debug lines", () => {
    delete process.env.LOG_LEVEL;
    log("debug", "should be suppressed");

    expect(lines).toHaveLength(0);
  });

  test("LOG_LEVEL=debug allows debug lines through", () => {
    process.env.LOG_LEVEL = "debug";
    log("debug", "should appear");

    expect(lines).toHaveLength(1);
  });

  test("warning/error are always emitted regardless of default level", () => {
    delete process.env.LOG_LEVEL;
    log("warning", "warn line");
    log("error", "error line");

    expect(lines).toHaveLength(2);
  });

  test("redacts sensitive context keys before serializing", () => {
    process.env.LOG_LEVEL = "info";
    log("info", "login attempt", { email: "user@example.com", tenantId: "t1" });

    const parsed = JSON.parse(lines[0]!);

    expect(parsed.email).toBe("[REDACTED]");
    expect(parsed.tenantId).toBe("t1");
  });
});

// Issue #447 — observability extension point. Default is `null` (no-op):
// every one of the tests above ran with no sink registered and behaved
// identically to before this issue. These tests cover the opt-in path a
// derived application (e.g. AWPOS) would use to attach its own
// alerting/export consumer.
describe("setLogSink extension point", () => {
  let originalConsoleLog: typeof console.log;
  let originalConsoleError: typeof console.error;
  let originalLogLevel: string | undefined;

  beforeEach(() => {
    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    originalLogLevel = process.env.LOG_LEVEL;
    console.log = () => {};
    console.error = () => {};
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    setLogSink(null);

    if (originalLogLevel === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = originalLogLevel;
    }
  });

  test("default sink is null (no-op) — nothing registered until an app opts in", () => {
    expect(getLogSink()).toBeNull();
  });

  test("a registered sink receives the same redacted entry written to stdout", () => {
    const received: LogEntry[] = [];
    setLogSink((entry) => {
      received.push(entry);
    });

    log("info", "checkout completed", {
      moduleKey: "sales_pos",
      email: "customer@example.com"
    });

    expect(received).toHaveLength(1);
    expect(received[0]!.message).toBe("checkout completed");
    expect(received[0]!.moduleKey).toBe("sales_pos");
    // Redaction already applied before the sink sees it — a sink can never
    // receive raw PII the logger itself wouldn't have printed to stdout.
    expect(received[0]!.email).toBe("[REDACTED]");
  });

  test("a sink is never called for a line suppressed by LOG_LEVEL", () => {
    const received: LogEntry[] = [];
    setLogSink((entry) => {
      received.push(entry);
    });
    delete process.env.LOG_LEVEL;

    log("debug", "suppressed at default info level");

    expect(received).toHaveLength(0);
  });

  test("a throwing sink is swallowed and never breaks the caller", () => {
    setLogSink(() => {
      throw new Error("derived app sink exploded");
    });

    expect(() => log("info", "still works")).not.toThrow();
  });

  test("setLogSink(null) detaches a previously registered sink", () => {
    const received: LogEntry[] = [];
    setLogSink((entry) => received.push(entry));
    setLogSink(null);

    log("info", "no listener anymore");

    expect(received).toHaveLength(0);
    expect(getLogSink()).toBeNull();
  });
});
