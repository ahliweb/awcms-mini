/**
 * tx-concurrency-lint-check.ts — `bun run tx:lint:check`.
 *
 * Issue #842 (epic #818) regression gate for a hang that has now recurred
 * FOUR times in this repo.
 *
 * ## The bug this kills
 *
 * One Postgres connection serves ONE query at a time. A transaction handle
 * (`tx`) is bound to exactly one connection, so
 * `Promise.all([queryA(tx), queryB(tx)])` does not merely lose its
 * parallelism — it produced a REAL HANG here, and the stuck connection then
 * broke every SUBSEQUENT test's `resetDatabase()` TRUNCATE, so the symptom
 * surfaces far from its cause. The canonical write-up lives in
 * `src/modules/reporting/application/projection-reconciliation.ts:89-94`.
 *
 * Known history: `projection-reconciliation.ts` (found empirically),
 * `health-registry.ts`'s `prepareModuleHealthContext` (a regression from
 * Issue #824's fix, caught by review on PR #839 — not by any test), and the
 * eleven pre-existing sites Issue #842 swept up. **The test suite passed every
 * single time**: the hang is load-dependent, so tests are not a gate for this
 * class. That is precisely why this static gate exists.
 *
 * ## What it flags
 *
 * Any `Promise.all(...)` whose argument span references a transaction handle.
 * Deliberately a blunt rule — a tx handle has no business inside concurrent
 * composition at all — which is why it needs no allow-list: the whole tree is
 * clean as of #842. Concurrency over a POOL (`sql`) is untouched and stays
 * legal: the pool hands out a separate connection per query, so
 * `Promise.all` over `sql` is correct (see `src/lib/performance/**`, which
 * deliberately generates concurrent load, and `process-metrics.ts`).
 *
 * Handle names are the repo convention `tx`, UNIONED with any name actually
 * bound by a `withTenant(..., async (NAME) => ...)` or `.begin(async (NAME)
 * => ...)` callback in the same file — so renaming the parameter does not
 * silently blind the gate. (As of #842 all 371 `withTenant` callbacks and all
 * 3 `.begin` callbacks in `src/**` bind the name `tx`.)
 *
 * ## Why it reads tokens, not raw text
 *
 * Comments and string/template literals are BLANKED before scanning, via the
 * state machine in `blankCommentsAndStrings` below. A text-level gate can be
 * satisfied by prose: a comment that merely says "not `Promise.all` over `tx`"
 * would otherwise register as a `tx` reference and — worse — every fix this
 * issue shipped added exactly such a comment right above the fixed code. The
 * sibling gate `tests/unit/ci-check-parity.test.ts` shipped with that same
 * defect and had to be fixed on PR #839 (its first version was satisfied by a
 * comment mentioning `bun test`). `tests/unit/tx-concurrency-lint-check.test.ts`
 * nails both properties down with adversarial fixtures.
 *
 * ## Residual gaps (documented, not assumed away)
 *
 * - Name-based, like `logging-lint-check.ts`. A handle aliased to an
 *   unrecognized name (`const c = tx; Promise.all([q(c)])`) is not tracked.
 * - A handle reaching `Promise.all` inside a helper CALLED from the span
 *   (rather than referenced in it) is not visible to a per-span text scan.
 *   Both would need real dataflow analysis; this gate deliberately buys the
 *   90% case at zero dependency cost, matching this repo's other
 *   contract/doc-parity gates.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export type TxConcurrencyProblem = {
  file: string;
  line: number;
  message: string;
};

const SCAN_ROOTS: ReadonlyArray<{ dir: string; extensions: string[] }> = [
  { dir: "src", extensions: [".ts", ".astro"] },
  { dir: "scripts", extensions: [".ts"] }
];

/** The repo-wide convention; `discoverHandleNames` adds any others a file actually binds. */
const DEFAULT_HANDLE_NAMES: readonly string[] = ["tx"];

/**
 * Replaces every comment and string/template literal with spaces, preserving
 * length and newlines so byte offsets and line numbers stay exact.
 *
 * Hand-written state machine rather than regex alternation, on this repo's own
 * precedent: PR #723's migration scanner needed six review rounds before
 * accepting that regex cannot express nesting or stateful escapes. Handles
 * line/block comments, all three quote forms, `${...}` interpolation (which
 * re-enters CODE, recursively — `` tx`${sub`${x}`}` `` nests), escapes, and
 * regex literals.
 *
 * Backticks/quotes themselves are KEPT as delimiters, only their contents are
 * blanked, so a tagged template still reads as `tx``  ``` and stays detectable.
 */
export function blankCommentsAndStrings(source: string): string {
  const out = source.split("");
  const n = source.length;

  // Stack of template-literal states we must return to when a `${...}`
  // interpolation's braces balance out.
  const templateStack: number[] = [];
  let braceDepth = 0;
  let i = 0;
  /** Last significant code character — decides `/` as regex-start vs division. */
  let lastSignificant = "";

  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) {
      if (source[k] !== "\n") out[k] = " ";
    }
  };

  while (i < n) {
    const c = source[i]!;
    const next = source[i + 1];

    // Line comment
    if (c === "/" && next === "/") {
      let j = i + 2;
      while (j < n && source[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }

    // Block comment
    if (c === "/" && next === "*") {
      let j = i + 2;
      while (j < n && !(source[j] === "*" && source[j + 1] === "/")) j++;
      j = Math.min(j + 2, n);
      blank(i, j);
      i = j;
      continue;
    }

    // Regex literal — only where a `/` cannot be division. Standard
    // prev-significant-token heuristic.
    if (c === "/" && REGEX_ALLOWED_AFTER.has(lastSignificant)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const d = source[j]!;
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === "\n") break;
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) {
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        blank(i + 1, j);
        i = j + 1;
        lastSignificant = "/";
        continue;
      }
      // Not a terminated regex — fall through and treat as an operator.
    }

    // Single/double-quoted strings
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n) {
        const d = source[j]!;
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === c || d === "\n") break;
        j++;
      }
      blank(i + 1, j);
      i = Math.min(j + 1, n);
      lastSignificant = c;
      continue;
    }

    // Template literal start
    if (c === "`") {
      templateStack.push(braceDepth);
      braceDepth = 0;
      i++;
      // Consume template chars until the closing backtick or an interpolation.
      let j = i;
      while (j < n) {
        const d = source[j]!;
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === "`") {
          blank(i, j);
          i = j + 1;
          braceDepth = templateStack.pop() ?? 0;
          lastSignificant = "`";
          break;
        }
        if (d === "$" && source[j + 1] === "{") {
          blank(i, j);
          i = j + 2;
          braceDepth = 0;
          break;
        }
        j++;
      }
      if (j >= n) {
        blank(i, n);
        i = n;
      }
      continue;
    }

    // Inside an interpolation: a balanced `}` returns us to template text.
    if (c === "}" && templateStack.length > 0 && braceDepth === 0) {
      i++;
      let j = i;
      while (j < n) {
        const d = source[j]!;
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === "`") {
          blank(i, j);
          i = j + 1;
          braceDepth = templateStack.pop() ?? 0;
          lastSignificant = "`";
          break;
        }
        if (d === "$" && source[j + 1] === "{") {
          blank(i, j);
          i = j + 2;
          break;
        }
        j++;
      }
      if (j >= n) {
        blank(i, n);
        i = n;
      }
      continue;
    }

    if (c === "{") braceDepth++;
    else if (c === "}") braceDepth = Math.max(0, braceDepth - 1);

    if (!/\s/.test(c)) lastSignificant = c;
    i++;
  }

  const blanked = out.join("");

  /* Fail LOUD, never silently mis-scan: a tokenizer that drops or adds bytes
     would shift every reported line number and could hide a real finding. */
  if (blanked.length !== source.length) {
    throw new Error(
      `blankCommentsAndStrings changed source length (${source.length} -> ${blanked.length}) — tokenizer bug.`
    );
  }

  return blanked;
}

/** Characters after which a `/` begins a regex literal rather than division. */
const REGEX_ALLOWED_AFTER: ReadonlySet<string> = new Set([
  "",
  "(",
  ",",
  "=",
  ":",
  "[",
  "!",
  "&",
  "|",
  "?",
  "{",
  "}",
  ";",
  "+",
  "-",
  "*",
  "%",
  "<",
  ">",
  "~",
  "^",
  "\n"
]);

export function lineNumberAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (source[i] === "\n") line += 1;
  }
  return line;
}

/**
 * Transaction-handle names bound in `blanked`: the convention (`tx`) plus any
 * name a `withTenant`/`.begin` callback actually binds, so a rename cannot
 * silently blind the gate.
 */
export function discoverHandleNames(blanked: string): Set<string> {
  const names = new Set(DEFAULT_HANDLE_NAMES);
  const callbackBinding =
    /(?:withTenant\s*\([^;]*?|\.begin\s*\(\s*)async\s*\(\s*(\w+)/g;
  let match: RegExpExecArray | null;

  while ((match = callbackBinding.exec(blanked)) !== null) {
    names.add(match[1]!);
  }

  return names;
}

/**
 * Every `Promise.all(...)` call's argument span, by balanced-paren matching
 * over already-blanked source (so a paren inside a string/comment cannot
 * unbalance it).
 */
export function findPromiseAllSpans(
  blanked: string
): Array<{ index: number; text: string }> {
  const spans: Array<{ index: number; text: string }> = [];
  const callStart = /\bPromise\s*\.\s*all(?:Settled)?\s*\(/g;
  let match: RegExpExecArray | null;

  while ((match = callStart.exec(blanked)) !== null) {
    const openParen = match.index + match[0].length - 1;
    let depth = 1;
    let i = openParen + 1;

    while (i < blanked.length && depth > 0) {
      const c = blanked[i];
      if (c === "(") depth += 1;
      else if (c === ")") depth -= 1;
      i += 1;
    }

    spans.push({ index: match.index, text: blanked.slice(match.index, i) });
  }

  return spans;
}

export function scanSourceForTxConcurrency(
  relativePath: string,
  source: string
): TxConcurrencyProblem[] {
  const blanked = blankCommentsAndStrings(source);
  const handleNames = discoverHandleNames(blanked);
  const problems: TxConcurrencyProblem[] = [];

  for (const span of findPromiseAllSpans(blanked)) {
    const referenced = [...handleNames].filter((name) =>
      new RegExp(`\\b${name}\\b`).test(span.text)
    );

    if (referenced.length === 0) continue;

    problems.push({
      file: relativePath,
      line: lineNumberAt(source, span.index),
      message:
        `Promise.all/allSettled over the transaction handle "${referenced.join('", "')}" — ` +
        "a single Postgres connection serves one query at a time, so concurrent queries on one " +
        "transaction HANG (see reporting/application/projection-reconciliation.ts:89-94). " +
        "Await them sequentially; if you truly need concurrency, use the POOL (sql), not a tx."
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

export async function runTxConcurrencyLintCheck(
  rootDir = process.cwd()
): Promise<TxConcurrencyProblem[]> {
  const problems: TxConcurrencyProblem[] = [];

  for (const root of SCAN_ROOTS) {
    const files = await walkFiles(
      path.join(rootDir, root.dir),
      root.extensions
    );

    for (const file of files) {
      const source = await readFile(file, "utf8");
      problems.push(
        ...scanSourceForTxConcurrency(path.relative(rootDir, file), source)
      );
    }
  }

  return problems;
}

if (import.meta.main) {
  const problems = await runTxConcurrencyLintCheck();

  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`${problem.file}:${problem.line}: ${problem.message}`);
    }

    console.error(
      `\ntx:lint:check GAGAL — ${problems.length} Promise.all di atas transaction handle. ` +
        "Satu koneksi Postgres melayani satu query pada satu waktu, jadi query konkuren di atas " +
        "SATU `tx` menghang sungguhan — dan koneksi yang tersangkut lalu merusak resetDatabase() " +
        "setiap test sesudahnya, sehingga gejalanya muncul jauh dari penyebabnya. Ubah menjadi " +
        "await berurutan (tidak ada performa yang hilang: yang mahal adalah jumlah query, bukan " +
        "serialisasinya). Bila memang butuh konkurensi, jalankan di atas POOL (`sql`), bukan `tx`."
    );
    process.exitCode = 1;
  } else {
    console.log(
      "tx:lint:check OK — tidak ada Promise.all di atas transaction handle di src/ dan scripts/."
    );
  }
}
