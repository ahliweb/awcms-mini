/**
 * logging-lint-check.ts — `bun run logging:lint:check`.
 *
 * Issue #687 (epic #679, platform-hardening) regression gate, hardened by
 * the PR #712 follow-up (security review — see items below marked "#712").
 * That issue replaced every raw exception-to-console pattern in
 * `src/pages/admin/**\/*.astro`, `src/pages/api/v1/**\/*.ts`, and
 * `scripts/**\/*.ts` with the two call-site helpers in
 * `src/lib/logging/error-log.ts` (`logAdminPageError`/`logScriptFailure`)
 * built on `src/lib/logging/error-sanitizer.ts` (`safeErrorDetail`/
 * `sanitizeErrorForLog`) — this script makes sure the old pattern doesn't
 * creep back into those scanned roots in a future change. Two independent
 * checks, both text/regex based (no TypeScript AST — matches this repo's
 * existing doc-parity/contract gates, `config-docs-check.ts` and
 * `i18n-parity-check.ts`, rather than pulling in a parser dependency for a
 * lint rule this narrow):
 *
 * 1. A caught value's own message being hand-extracted with the old
 *    branch-on-`instanceof Error`-with-a-`String(...)`-fallback pattern,
 *    assigned to a local variable, and THAT variable then flowing straight
 *    into a `console.error`/`console.warn` call — the exact shape every
 *    fixed script (`scripts/audit-log-purge.ts` before this issue, etc.)
 *    used to have. Deliberately does NOT flag every occurrence of that
 *    extraction pattern on its own — several `src/pages/api/v1/**` handlers
 *    legitimately use it to pattern-match a DB constraint name internally
 *    (never logged, never returned raw to a client) and would otherwise be
 *    a false positive.
 * 2. Any `console.error(...)`/`console.warn(...)` call that either passes a
 *    bare caught-value-shaped identifier directly as an argument (as the
 *    sole argument too — #712), or accesses `.message`/`.stack` on such an
 *    identifier inline — unless that same call also invokes one of
 *    `ALLOWED_SANITIZER_CALLS`. `CAUGHT_VALUE_NAMES` below (#712) widens
 *    the recognized spellings past `error`/`err` to also cover `catch (e)`/
 *    `catch (ex)`/`catch (exc)`/`catch (exception)` — still purely
 *    NAME-based, not truly catch-clause-aware (a value bound to some other
 *    identifier name still isn't caught by check 2, only by check 1 if it
 *    also goes through the hand-rolled extraction idiom).
 *
 * `SCAN_ROOTS` (#712) also now covers `src/lib/**` and `src/modules/**`,
 * not only the three original directories — a real raw console-based leak
 * in `src/lib/logging/logger.ts` predating this issue was invisible to the
 * gate before this widening (see that file's sink-error handler). Doc 20
 * §Standar tambahan Issue #687 must not overclaim which directories this
 * gate actually covers — keep it in sync with `SCAN_ROOTS` below.
 *
 * Exemption escape hatch (mirrors `CONFIG_EXEMPTIONS`/
 * `DYNAMIC_KEY_FAMILIES`/`ROUTE_PARITY_EXEMPTIONS` elsewhere in this repo):
 * `LOGGING_LINT_EXEMPTIONS` below, keyed by `"relative/path:lineNumber"`,
 * for a genuine false positive that can't be rewritten to satisfy the
 * checker — empty as of this issue.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export type LoggingLintProblem = {
  file: string;
  line: number;
  message: string;
};

const SCAN_ROOTS: ReadonlyArray<{ dir: string; extensions: string[] }> = [
  { dir: "src/pages/admin", extensions: [".astro"] },
  { dir: "src/pages/api/v1", extensions: [".ts"] },
  { dir: "scripts", extensions: [".ts"] },
  // Added in the PR #712 follow-up (security review, epic #679): a real
  // raw console-based leak of a caught value's own message
  // (`src/lib/logging/logger.ts`'s sink-error handler, predating this
  // issue) was invisible to the gate because neither `src/lib/**` nor
  // `src/modules/**` were scanned. `src/modules/**` currently has ZERO
  // console-based error logging of any kind (verified before adding it —
  // grep for the literal console call prefix across that tree), so
  // adding it costs nothing and closes the same class of blind spot for
  // any module code written later.
  { dir: "src/lib", extensions: [".ts"] },
  { dir: "src/modules", extensions: [".ts"] }
];

/** See file header §Exemption escape hatch. */
export const LOGGING_LINT_EXEMPTIONS: ReadonlySet<string> = new Set([]);

/**
 * Function names that already route a caught error through reviewed
 * redaction (`src/lib/logging/error-sanitizer.ts`,
 * `src/modules/_shared/redaction.ts`, `scripts/db-migrate.ts`'s own
 * `redactDatabaseUrl`/`safeErrorMessage`) — a `console.error`/`console.warn`
 * call that invokes one of these anywhere in its argument list is never
 * flagged by check 2 above, regardless of what else is in that call.
 */
const ALLOWED_SANITIZER_CALLS: readonly string[] = [
  "sanitizeErrorForLog",
  "safeErrorDetail",
  "safeErrorMessage",
  "redactSecretsInText",
  "redactDatabaseUrl",
  "logAdminPageError",
  "logScriptFailure"
];

function lineNumberAt(source: string, index: number): number {
  let line = 1;

  for (let i = 0; i < index; i++) {
    if (source[i] === "\n") {
      line += 1;
    }
  }

  return line;
}

/**
 * Matches `const NAME = CAUGHT instanceof Error ? CAUGHT.message :
 * String(CAUGHT);` (or `let`) for any identifier names — the exact
 * hand-rolled idiom this issue replaced. Captures the ASSIGNED variable
 * name (group 1), not the caught value's own name (group 2), since check 1
 * needs to know what to look for downstream in a console call.
 */
const RAW_IDIOM_ASSIGNMENT =
  /(?:const|let)\s+(\w+)\s*=\s*(\w+)\s+instanceof\s+Error\s*\?\s*\2\.message\s*:\s*String\(\2\)\s*;/g;

export function findRawIdiomAssignments(
  source: string
): Array<{ variableName: string; line: number }> {
  const results: Array<{ variableName: string; line: number }> = [];
  RAW_IDIOM_ASSIGNMENT.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = RAW_IDIOM_ASSIGNMENT.exec(source)) !== null) {
    results.push({
      variableName: match[1]!,
      line: lineNumberAt(source, match.index)
    });
  }

  return results;
}

type ConsoleCall = { line: number; text: string };

/**
 * Extracts every `console.error(...)`/`console.warn(...)` call's full
 * argument-list text via balanced-paren matching (not a single-line regex)
 * so a call wrapped across multiple lines — several existed in
 * `src/pages/admin/**` before this issue — is still captured whole.
 */
export function findConsoleErrorWarnCalls(source: string): ConsoleCall[] {
  const calls: ConsoleCall[] = [];
  const callStart = /console\.(?:error|warn)\s*\(/g;
  let match: RegExpExecArray | null;

  while ((match = callStart.exec(source)) !== null) {
    const openParenIndex = match.index + match[0].length - 1;
    let depth = 1;
    let i = openParenIndex + 1;

    while (i < source.length && depth > 0) {
      if (source[i] === "(") {
        depth += 1;
      } else if (source[i] === ")") {
        depth -= 1;
      }
      i += 1;
    }

    calls.push({
      line: lineNumberAt(source, match.index),
      text: source.slice(match.index, i)
    });
  }

  return calls;
}

/**
 * Recognized catch-clause-variable names (PR #712 follow-up, security
 * review). Deliberately still NAME-based, not truly catch-clause-aware —
 * a proper fix would track which identifier an enclosing `catch (X)`
 * actually bound and flag exactly that name, regardless of spelling; this
 * is the cheaper mitigation the review explicitly allowed: widen the
 * hardcoded name list to cover the other common non-adversarial spellings
 * (`catch (e)`, `catch (ex)`, `catch (exc)`) in addition to `error`/`err`.
 * A caught value bound to some OTHER uncommon name still bypasses this —
 * see `LOGGING_LINT_EXEMPTIONS`/this comment as the documented residual
 * gap, not a silently assumed one.
 */
const CAUGHT_VALUE_NAMES = "error|err|exception|exc|ex|e";
const RAW_ERROR_ARGUMENT = new RegExp(
  `[(,]\\s*(?:${CAUGHT_VALUE_NAMES})\\s*[,)]`
);
const RAW_ERROR_PROPERTY_ACCESS = new RegExp(
  `\\b(?:${CAUGHT_VALUE_NAMES})\\.(?:message|stack)\\b`
);

/**
 * Returns a human-readable reason a `console.error`/`console.warn` call is
 * dangerous, or `null` if it's fine. `callText` is one call's full
 * argument-list text from `findConsoleErrorWarnCalls`.
 */
export function isDangerousConsoleCall(callText: string): string | null {
  const usesAllowedSanitizer = ALLOWED_SANITIZER_CALLS.some((name) =>
    callText.includes(`${name}(`)
  );

  if (usesAllowedSanitizer) {
    return null;
  }

  if (RAW_ERROR_ARGUMENT.test(callText)) {
    return "passes a raw caught value (error/err/exception/exc/ex/e) directly as an argument";
  }

  if (RAW_ERROR_PROPERTY_ACCESS.test(callText)) {
    return "reads .message/.stack off a caught-value-named identifier (error/err/exception/exc/ex/e) inline, with no reviewed sanitizer in the same call";
  }

  return null;
}

export function scanSourceForLoggingProblems(
  relativePath: string,
  source: string
): LoggingLintProblem[] {
  const problems: LoggingLintProblem[] = [];
  const consoleCalls = findConsoleErrorWarnCalls(source);

  for (const idiom of findRawIdiomAssignments(source)) {
    const flowsIntoConsoleCall = consoleCalls.some((call) =>
      new RegExp(`\\b${idiom.variableName}\\b`).test(call.text)
    );

    if (!flowsIntoConsoleCall) {
      continue;
    }

    const key = `${relativePath}:${idiom.line}`;
    if (LOGGING_LINT_EXEMPTIONS.has(key)) {
      continue;
    }

    problems.push({
      file: relativePath,
      line: idiom.line,
      message:
        `a caught value's message is hand-extracted into "${idiom.variableName}" (the old ` +
        "instanceof-Error-with-String()-fallback branch) and that variable is then passed to " +
        "console.error/warn — use safeErrorDetail()/sanitizeErrorForLog() from " +
        "src/lib/logging/error-sanitizer.ts instead."
    });
  }

  for (const call of consoleCalls) {
    const reason = isDangerousConsoleCall(call.text);

    if (!reason) {
      continue;
    }

    const key = `${relativePath}:${call.line}`;
    if (LOGGING_LINT_EXEMPTIONS.has(key)) {
      continue;
    }

    problems.push({
      file: relativePath,
      line: call.line,
      message: `unsafe console.error/warn call — ${reason}.`
    });
  }

  return problems;
}

async function walkFiles(dir: string, extensions: string[]): Promise<string[]> {
  let entries;

  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await walkFiles(full, extensions)));
    } else if (
      extensions.some((ext) => entry.name.endsWith(ext)) &&
      !entry.name.endsWith(".test.ts")
    ) {
      files.push(full);
    }
  }

  return files;
}

export async function runLoggingLintCheck(
  rootDir = process.cwd()
): Promise<LoggingLintProblem[]> {
  const problems: LoggingLintProblem[] = [];

  for (const root of SCAN_ROOTS) {
    const files = await walkFiles(
      path.join(rootDir, root.dir),
      root.extensions
    );

    for (const file of files) {
      const source = await readFile(file, "utf8");
      const relativePath = path.relative(rootDir, file);

      problems.push(...scanSourceForLoggingProblems(relativePath, source));
    }
  }

  return problems;
}

if (import.meta.main) {
  const problems = await runLoggingLintCheck();

  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`${problem.file}:${problem.line}: ${problem.message}`);
    }

    console.error(
      `\nlogging:lint:check GAGAL — ${problems.length} temuan pola logging error tidak aman ` +
        "di src/pages/admin, src/pages/api/v1, scripts/, src/lib, atau src/modules. Ganti dengan " +
        "logAdminPageError()/logScriptFailure() (src/lib/logging/error-log.ts) atau " +
        "safeErrorDetail()/sanitizeErrorForLog() (src/lib/logging/error-sanitizer.ts). Bila ini " +
        'false-positive nyata, tambahkan "path:line" ke LOGGING_LINT_EXEMPTIONS di ' +
        "scripts/logging-lint-check.ts dengan alasan tercatat."
    );
    process.exitCode = 1;
  } else {
    console.log(
      "logging:lint:check OK — tidak ada pola raw error/console.error tidak aman di " +
        "src/pages/admin, src/pages/api/v1, scripts/, src/lib, dan src/modules."
    );
  }
}
