import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { log } from "../src/lib/logging/logger";

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
