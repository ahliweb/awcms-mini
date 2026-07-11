import { describe, expect, test } from "bun:test";

import {
  findConsoleErrorWarnCalls,
  findRawIdiomAssignments,
  isDangerousConsoleCall,
  scanSourceForLoggingProblems
} from "../../scripts/logging-lint-check";

describe("findConsoleErrorWarnCalls", () => {
  test("extracts a single-line call", () => {
    const source = 'console.error("failed", error);';
    const calls = findConsoleErrorWarnCalls(source);

    expect(calls).toHaveLength(1);
    // Extraction stops at the matching close-paren — the trailing `;` is
    // not part of the call's own argument-list text.
    expect(calls[0]!.text).toBe('console.error("failed", error)');
  });

  test("extracts a call wrapped across multiple lines", () => {
    const source = [
      "    console.error(",
      '      "admin/foo.astro: failed to load data",',
      "      error",
      "    );"
    ].join("\n");

    const calls = findConsoleErrorWarnCalls(source);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain("error");
  });
});

describe("isDangerousConsoleCall", () => {
  test("flags a bare error object passed as the second argument", () => {
    const reason = isDangerousConsoleCall(
      'console.error("admin/foo.astro: failed to load data", error)'
    );

    expect(reason).not.toBeNull();
  });

  test("flags inline error.message interpolation with no sanitizer", () => {
    const reason = isDangerousConsoleCall(
      "console.error(`FAILED — ${error.message}`)"
    );

    expect(reason).not.toBeNull();
  });

  test("passes when the call routes through logAdminPageError-approved sanitizer", () => {
    const reason = isDangerousConsoleCall(
      "console.error(`FAILED — ${safeErrorDetail(error)}`)"
    );

    expect(reason).toBeNull();
  });

  test("passes a call that never references an error/err value at all", () => {
    const reason = isDangerousConsoleCall("console.error(problem.message)");

    expect(reason).toBeNull();
  });
});

describe("findRawIdiomAssignments", () => {
  test("finds the hand-rolled instanceof-Error/String() extraction idiom", () => {
    const source =
      "const detail = error instanceof Error ? error.message : String(error);";

    const found = findRawIdiomAssignments(source);

    expect(found).toHaveLength(1);
    expect(found[0]!.variableName).toBe("detail");
  });

  test("does not match ordinary instanceof Error guards", () => {
    const source = [
      "if (error instanceof Error) {",
      "  handle(error);",
      "}"
    ].join("\n");

    expect(findRawIdiomAssignments(source)).toHaveLength(0);
  });
});

describe("scanSourceForLoggingProblems — fixture: unsafe raw pattern", () => {
  test("a console.error(label, error) call fails the check", () => {
    const source = [
      "try {",
      "  doWork();",
      "} catch (error) {",
      '  console.error("worker: failed", error);',
      "}"
    ].join("\n");

    const problems = scanSourceForLoggingProblems("scripts/fixture.ts", source);

    expect(problems.length).toBeGreaterThan(0);
  });

  test("the hand-rolled extraction idiom flowing into console.error fails the check", () => {
    const source = [
      "try {",
      "  doWork();",
      "} catch (error) {",
      "  const detail = error instanceof Error ? error.message : String(error);",
      "  console.error(`worker FAILED — ${detail}`);",
      "  process.exitCode = 1;",
      "}"
    ].join("\n");

    const problems = scanSourceForLoggingProblems("scripts/fixture.ts", source);

    expect(problems.length).toBeGreaterThan(0);
  });
});

describe("scanSourceForLoggingProblems — fixture: already using the reviewed logger", () => {
  test("logScriptFailure(label, error) passes the check", () => {
    const source = [
      "try {",
      "  doWork();",
      "} catch (error) {",
      '  logScriptFailure("worker FAILED", error);',
      "}"
    ].join("\n");

    expect(
      scanSourceForLoggingProblems("scripts/fixture.ts", source)
    ).toHaveLength(0);
  });

  test("logAdminPageError(label, error, context) passes the check", () => {
    const source = [
      "} catch (error) {",
      '  logAdminPageError("admin/foo.astro: failed to load data", error, {',
      "    correlationId: Astro.locals.correlationId",
      "  });",
      "  loadError = true;",
      "}"
    ].join("\n");

    expect(
      scanSourceForLoggingProblems("src/pages/admin/foo.astro", source)
    ).toHaveLength(0);
  });

  test("an idiom extraction used only for internal string matching (never logged) passes", () => {
    // Mirrors the real src/pages/api/v1/**  pattern: `message` is used only
    // to detect a DB constraint name and is never printed or returned raw.
    const source = [
      "} catch (error) {",
      "  const message = error instanceof Error ? error.message : String(error);",
      "",
      '  if (message.includes("some_unique_constraint")) {',
      '    return fail(409, "CONFLICT", "Already exists.");',
      "  }",
      "",
      "  throw error;",
      "}"
    ].join("\n");

    expect(
      scanSourceForLoggingProblems("src/pages/api/v1/fixture.ts", source)
    ).toHaveLength(0);
  });
});
