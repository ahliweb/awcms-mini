/**
 * rls-platform-claim-check.ts — `bun run rls:platform-claim:check`.
 *
 * Issue #879 (epic #868 SaaS control plane, Wave 2, ADR-0022 §6 High-1
 * "no soft super-tenant" — and FIX MEDIUM-4 hardening this gate against bypass).
 *
 * WHY THIS GATE EXISTS. `scripts/security-readiness.ts` fails go-live for a
 * Postgres ROLE that carries the `BYPASSRLS` attribute. That is necessary but
 * NOT sufficient: a functionally identical bypass can be smuggled into an
 * ordinary, non-BYPASSRLS deployment by
 *   (1) EXTENDING a tenant-scoped RLS policy predicate with a platform-claim
 *       disjunction (`... OR current_setting('app.is_platform') = 't'`);
 *   (2) adding a SECOND, more-permissive PERMISSIVE policy on the same table
 *       (PERMISSIVE policies are OR-combined — a `USING (true)` sibling defeats
 *       the tenant one);
 *   (3) hiding the widening inside a SECURITY DEFINER function the predicate
 *       calls (`USING (has_platform_claim())`);
 *   (4) `ALTER TABLE ... DISABLE / NO FORCE ROW LEVEL SECURITY` (RLS simply off);
 *   (5) `ALTER ROLE ... BYPASSRLS` (granting the attribute in a migration).
 *
 * WHAT IT ENFORCES (ALLOWLIST, not denylist — memory
 * [[sql-tokenizer-regex-vs-state-machine]]). Rather than blocklisting known-bad
 * tokens (bypassable by any novel claim name), it asserts the POSITIVE invariant:
 *   A. EVERY `CREATE POLICY` on a tenant-scoped table must be PERMISSIVE with a
 *      predicate (both `USING` and `WITH CHECK`, when present) that is EXACTLY
 *      the canonical `tenant_id = current_setting('app.current_tenant_id')::uuid`
 *      — no disjunction, no function call, no extra column, nothing else. Any
 *      deviation (including a second permissive policy whose predicate is not the
 *      canonical form) fails. Balanced-paren + string-aware extraction, not a
 *      loose regex, so a `;` inside a quoted default or a nested paren cannot
 *      truncate the statement.
 *   B. A policy predicate that CALLS a function is rejected outright, and the
 *      referenced `CREATE FUNCTION` bodies are additionally scanned for
 *      forbidden platform-claim/bypass tokens.
 *   C. No migration may `ALTER TABLE ... DISABLE / NO FORCE ROW LEVEL SECURITY`
 *      or `ALTER ROLE/USER ... BYPASSRLS` / `CREATE ROLE ... BYPASSRLS`.
 *
 * Pure code + file reads, no database, no network — wired into `bun run check`
 * and `bun run security:readiness`.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.join(HERE, "..", "sql");

/**
 * Forbidden platform-claim / functional-BYPASSRLS tokens that must never appear
 * inside an RLS policy predicate OR inside a function body a predicate calls.
 */
export const FORBIDDEN_PREDICATE_TOKENS: readonly string[] = [
  "is_platform",
  "has_platform_claim",
  "platform_claim",
  "is_operator",
  "is_superuser",
  "bypassrls",
  "bypass_rls",
  "app.platform",
  "app.is_platform",
  "app.super",
  "app.is_super",
  "app.operator",
  "app.cross_tenant",
  "app.all_tenants"
];

const TENANT_GUC = "app.current_tenant_id";

export type PlatformClaimViolation = {
  source: string;
  policyName: string;
  reason: string;
  snippet: string;
};

/** Removes `-- line comments` and collapses `/* block comments *​/`. */
export function stripSqlComments(sql: string): string {
  const withoutBlock = sql.replace(/\/\*[\s\S]*?\*\//g, " ");
  return withoutBlock
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

/**
 * Normalize a predicate for canonical comparison: lowercase, strip ALL
 * whitespace, and remove any number of balanced enclosing parens. Because all
 * whitespace is removed, `tenant_id = current_setting( 'app.current_tenant_id'
 * )::uuid` and its single-line form collapse to the same string.
 */
export function normalizePredicate(pred: string): string {
  let p = pred.toLowerCase().replace(/\s+/g, "");
  // Strip fully-enclosing parens repeatedly: "((x))" -> "x".
  let changed = true;
  while (changed && p.startsWith("(") && p.endsWith(")")) {
    // Confirm the leading "(" matches the trailing ")" (not "(a)and(b)").
    let depth = 0;
    let enclosing = true;
    for (let i = 0; i < p.length; i++) {
      if (p[i] === "(") depth++;
      else if (p[i] === ")") {
        depth--;
        if (depth === 0 && i < p.length - 1) {
          enclosing = false;
          break;
        }
      }
    }
    if (enclosing) p = p.slice(1, -1);
    changed = enclosing;
  }
  return p;
}

const CANONICAL_FORMS = new Set([
  "tenant_id=current_setting('app.current_tenant_id')::uuid",
  "tenant_id=current_setting('app.current_tenant_id')"
]);

export function isCanonicalTenantPredicate(pred: string): boolean {
  return CANONICAL_FORMS.has(normalizePredicate(pred));
}

/**
 * Balanced-paren, single-quote-aware extraction of the group immediately
 * following `keyword` (e.g. `USING`, `WITH CHECK`) in a comment-stripped SQL
 * fragment. Returns the inner text of the FIRST `(...)` group after the keyword,
 * or null if the keyword is absent. A `(` or `)` inside a single-quoted string is
 * ignored (Postgres `''` escaping handled).
 */
export function extractParenGroupAfter(
  sql: string,
  keyword: string
): string | null {
  const lower = sql.toLowerCase();
  const kw = keyword.toLowerCase();
  let searchFrom = 0;
  // Find a keyword occurrence that is followed (allowing whitespace) by "(".
  for (;;) {
    const kwIdx = lower.indexOf(kw, searchFrom);
    if (kwIdx === -1) return null;
    let i = kwIdx + kw.length;
    while (i < sql.length && /\s/.test(sql[i]!)) i++;
    if (sql[i] !== "(") {
      searchFrom = kwIdx + kw.length;
      continue;
    }
    // Extract the balanced group starting at i.
    let depth = 0;
    let inString = false;
    for (let j = i; j < sql.length; j++) {
      const ch = sql[j]!;
      if (inString) {
        if (ch === "'") {
          if (sql[j + 1] === "'") {
            j++;
          } else {
            inString = false;
          }
        }
        continue;
      }
      if (ch === "'") {
        inString = true;
      } else if (ch === "(") {
        depth++;
      } else if (ch === ")") {
        depth--;
        if (depth === 0) {
          return sql.slice(i + 1, j);
        }
      }
    }
    return null; // unbalanced
  }
}

export type ParsedPolicy = {
  policyName: string;
  tableName: string;
  restrictive: boolean;
  using: string | null;
  withCheck: string | null;
};

/**
 * Extract every `CREATE POLICY … ;` statement from comment-stripped SQL and
 * parse the pieces the gate reasons about. String-aware `;` scanning so a
 * semicolon inside a quoted literal never truncates a statement early.
 */
export function extractPolicies(strippedSql: string): ParsedPolicy[] {
  const policies: ParsedPolicy[] = [];
  const lower = strippedSql.toLowerCase();
  let idx = 0;
  for (;;) {
    const start = lower.indexOf("create policy", idx);
    if (start === -1) break;
    // Find the terminating ";" honoring single-quoted strings.
    let end = -1;
    let inString = false;
    for (let j = start; j < strippedSql.length; j++) {
      const ch = strippedSql[j]!;
      if (inString) {
        if (ch === "'") {
          if (strippedSql[j + 1] === "'") j++;
          else inString = false;
        }
        continue;
      }
      if (ch === "'") inString = true;
      else if (ch === ";") {
        end = j;
        break;
      }
    }
    if (end === -1) end = strippedSql.length;
    const statement = strippedSql.slice(start, end);
    idx = end + 1;

    const header = statement.replace(/\s+/g, " ").trim();
    const nameMatch =
      /create\s+policy\s+("?[a-zA-Z0-9_]+"?)\s+on\s+("?[a-zA-Z0-9_.]+"?)/i.exec(
        header
      );
    const policyName = (nameMatch?.[1] ?? "(unknown)").replace(/"/g, "");
    const tableName = (nameMatch?.[2] ?? "(unknown)").replace(/"/g, "");
    const restrictive = /\bas\s+restrictive\b/i.test(header);
    const using = extractParenGroupAfter(statement, "using");
    const withCheck = extractParenGroupAfter(statement, "with check");

    policies.push({ policyName, tableName, restrictive, using, withCheck });
  }
  return policies;
}

/** Extract `CREATE [OR REPLACE] FUNCTION name(...) ... $$ body $$` bodies, keyed by lowercase function name. */
export function extractFunctionBodies(
  strippedSql: string
): Map<string, string> {
  const bodies = new Map<string, string>();
  const regex =
    /create\s+(?:or\s+replace\s+)?function\s+([a-z0-9_]+)\s*\(([\s\S]*?)\$\$([\s\S]*?)\$\$/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(strippedSql)) !== null) {
    bodies.set((match[1] ?? "").toLowerCase(), match[3] ?? "");
  }
  return bodies;
}

function tokenViolations(
  text: string,
  where: string,
  source: string,
  policyName: string
): PlatformClaimViolation[] {
  const out: PlatformClaimViolation[] = [];
  const lower = text.toLowerCase();
  for (const token of FORBIDDEN_PREDICATE_TOKENS) {
    // Full regex-escape of the literal token before embedding it in a
    // dynamic RegExp. The character class contains `\\` so backslashes are
    // escaped FIRST (the canonical, CodeQL-clean pattern) — a `.`-only escape
    // leaves backslash (and every other metachar) unsanitized.
    const tokenRegex = new RegExp(
      `(?<![a-z0-9_])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9_])`,
      "i"
    );
    if (tokenRegex.test(lower)) {
      out.push({
        source,
        policyName,
        reason: `${where} references forbidden platform-claim/bypass token "${token}" — a functional BYPASSRLS (ADR-0022 §6 High-1).`,
        snippet: text.slice(0, 200)
      });
    }
  }
  return out;
}

/** Function names referenced (called) inside a predicate, e.g. `has_platform_claim()`. */
function referencedFunctions(pred: string): string[] {
  const names: string[] = [];
  const regex = /([a-z_][a-z0-9_]*)\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(pred)) !== null) {
    const name = (match[1] ?? "").toLowerCase();
    // `current_setting` is the one allowed function call in the canonical form.
    if (name !== "current_setting") names.push(name);
  }
  return names;
}

/**
 * Pure scan of one SQL source's text. Exported for unit testing against
 * adversarial inline fixtures independent of the real `sql/` directory.
 */
export function scanSqlForPlatformClaim(
  sql: string,
  source: string
): PlatformClaimViolation[] {
  const stripped = stripSqlComments(sql);
  const violations: PlatformClaimViolation[] = [];
  const functionBodies = extractFunctionBodies(stripped);

  // --- (A/B) CREATE POLICY allowlist ---
  for (const policy of extractPolicies(stripped)) {
    const predicates: { label: string; pred: string }[] = [];
    if (policy.using !== null)
      predicates.push({ label: "USING", pred: policy.using });
    if (policy.withCheck !== null)
      predicates.push({ label: "WITH CHECK", pred: policy.withCheck });

    for (const { label, pred } of predicates) {
      // Token scan first (explicit, clear message).
      violations.push(
        ...tokenViolations(
          pred,
          `RLS policy ${label} predicate`,
          source,
          policy.policyName
        )
      );

      // (B) function-call in a predicate: reject, and scan the callee's body.
      const fns = referencedFunctions(pred);
      for (const fn of fns) {
        violations.push({
          source,
          policyName: policy.policyName,
          reason: `RLS policy ${label} predicate calls function "${fn}()" — a tenant-isolation predicate must be a direct tenant_id comparison, never a function that could widen it (ADR-0022 §6 High-1).`,
          snippet: pred.slice(0, 200)
        });
        const body = functionBodies.get(fn);
        if (body) {
          violations.push(
            ...tokenViolations(
              body,
              `Function ${fn}() body referenced by policy ${policy.policyName}`,
              source,
              policy.policyName
            )
          );
        }
      }

      // (A) POSITIVE allowlist: a PERMISSIVE policy predicate must be canonical.
      // RESTRICTIVE policies only narrow access (AND-combined), so a non-canonical
      // restrictive predicate cannot create a soft super-tenant and is allowed.
      if (!policy.restrictive && !isCanonicalTenantPredicate(pred)) {
        violations.push({
          source,
          policyName: policy.policyName,
          reason: `PERMISSIVE RLS policy ${label} predicate is not the canonical tenant_id = current_setting('${TENANT_GUC}')::uuid — every tenant-scoped policy predicate must be tenant_id-only, and a second permissive policy is OR-combined so any non-canonical one is a soft super-tenant (ADR-0022 §6 High-1 / ADR-0013 §2). Got: ${normalizePredicate(pred)}`,
          snippet: pred.slice(0, 200)
        });
      }
    }
  }

  // --- (C) RLS-disable / BYPASSRLS in migrations ---
  const compact = stripped.replace(/\s+/g, " ");
  const disableRls =
    /alter\s+table\s+[a-z0-9_."]+\s+(disable\s+row\s+level\s+security|no\s+force\s+row\s+level\s+security)/gi;
  let m: RegExpExecArray | null;
  while ((m = disableRls.exec(compact)) !== null) {
    violations.push({
      source,
      policyName: "(alter table)",
      reason: `Migration turns off row-level security ("${m[1]}") — RLS must stay ENABLED + FORCED on every tenant-scoped table (ADR-0022 §6 High-1).`,
      snippet: m[0].slice(0, 200)
    });
  }
  const bypassRls =
    /(alter|create)\s+(role|user)\s+[a-z0-9_."]+[^;]*\bbypassrls\b/gi;
  while ((m = bypassRls.exec(compact)) !== null) {
    violations.push({
      source,
      policyName: "(role attribute)",
      reason: `Migration grants the BYPASSRLS role attribute — no control-plane runtime role may be BYPASSRLS (ADR-0022 §6 High-1).`,
      snippet: m[0].slice(0, 200)
    });
  }

  return violations;
}

export function scanSqlDirectory(dir: string): PlatformClaimViolation[] {
  const files = readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const violations: PlatformClaimViolation[] = [];
  for (const file of files) {
    const sql = readFileSync(path.join(dir, file), "utf8");
    violations.push(...scanSqlForPlatformClaim(sql, file));
  }
  return violations;
}

function main(): void {
  const violations = scanSqlDirectory(SQL_DIR);

  if (violations.length === 0) {
    console.log(
      "rls:platform-claim:check OK — every CREATE POLICY predicate is the canonical tenant_id-only form; no policy-function widening, RLS-disable, or BYPASSRLS grant found."
    );
    return;
  }

  console.error("rls:platform-claim:check FAILED —");
  for (const violation of violations) {
    console.error(
      `  [${violation.source} · ${violation.policyName}] ${violation.reason}\n    ${violation.snippet}`
    );
  }
  process.exitCode = 1;
}

if (import.meta.main) {
  main();
}
