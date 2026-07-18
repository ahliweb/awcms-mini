/**
 * Deterministic, VERIFIED `ANALYZE` for the query-plan budget suite (Issue
 * #849, epic #818).
 *
 * The query-plan budgets (`query-plan-budgets.ts`) gate PostgreSQL's chosen
 * plan SHAPE and estimated COST at a fixed synthetic fixture scale. Both of
 * those depend entirely on the planner's statistics (`pg_class.reltuples`,
 * `pg_statistic` column histograms). Right after a bulk fixture seed those
 * statistics are stale or absent until an `ANALYZE` refreshes them — and
 * whether autovacuum's background `ANALYZE` happens to have run yet is a pure
 * timing race, so a budget can pass or FAIL by accident rather than by real
 * measurement (Issue #782 already root-caused one direction of this; Issue
 * #849 is the other).
 *
 * The trap Issue #849 exists to close: `ANALYZE` run by a role that does NOT
 * OWN the table is SILENTLY SKIPPED by PostgreSQL — a WARNING, never an
 * error, exit status success. The least-privilege `awcms_mini_app` role the
 * suite's queries run as (correctly — so FORCE'd RLS is exercised) is exactly
 * such a role, so an `ANALYZE awcms_mini_blog_posts` issued on that
 * connection does NOTHING while looking like it worked. The budgets then pass
 * only because whatever stale/absent statistics happened to be in place
 * produced an acceptable plan — not because the code is correct.
 *
 * This module runs `ANALYZE` on the driving tables through a caller-supplied
 * PRIVILEGED (table-owner/superuser) connection and PROVES it actually
 * refreshed the statistics by checking `pg_stat_user_tables.analyze_count`
 * advanced for every table — the honest signal, immune to exit-code lies and
 * to timestamp resolution. If any table's `analyze_count` did not advance it
 * throws, so a silently-skipped `ANALYZE` can never again pass unnoticed.
 */

/**
 * Every table that drives a registered `QUERY_PLAN_BUDGETS` query
 * (`query-plan-runner.ts`'s `QUERY_PLAN_QUERIES`). Keeping this list next to
 * the verifier — and asserting in
 * `tests/unit/performance-query-plan-registry-consistency.test.ts` that it
 * covers every registered query's driving table — means adding a budget over
 * a not-yet-ANALYZEd table (a fresh stale-statistics flake) fails a pure-unit
 * gate rather than surfacing as a mysterious CI flake.
 */
export const QUERY_PLAN_ANALYZE_TABLES = [
  "awcms_mini_audit_events",
  "awcms_mini_abac_decision_logs",
  "awcms_mini_blog_posts",
  "awcms_mini_blog_pages",
  "awcms_mini_object_sync_queue"
] as const;

export type QueryPlanAnalyzeResult = {
  table: string;
  analyzeCountBefore: number;
  analyzeCountAfter: number;
};

async function readAnalyzeCounts(
  sql: Bun.SQL,
  tables: readonly string[]
): Promise<Map<string, number>> {
  const rows = (await sql`
    SELECT relname, analyze_count::int AS analyze_count
    FROM pg_stat_user_tables
    WHERE relname = ANY(${sql.array(tables as string[], "text")})
  `) as { relname: string; analyze_count: number }[];

  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.relname, row.analyze_count);
  }
  return counts;
}

/**
 * Runs `ANALYZE` on each of `tables` via `privilegedSql` (which MUST own the
 * tables) and verifies each one's `pg_stat_user_tables.analyze_count` strictly
 * advanced. Returns the before/after counts for every table.
 *
 * Throws if any table's statistics did not refresh — the caller should treat
 * that as a hard failure (it means the connection lacks table ownership and
 * every `ANALYZE` was a silent no-op, Issue #849). `privilegedSql` is
 * deliberately NOT the least-privilege app-role connection the query-plan
 * checks themselves run on; ANALYZE is an owner-only maintenance operation,
 * kept separate from the RLS-enforced EXPLAIN path.
 */
export async function analyzeQueryPlanFixtures(
  privilegedSql: Bun.SQL,
  tables: readonly string[] = QUERY_PLAN_ANALYZE_TABLES
): Promise<QueryPlanAnalyzeResult[]> {
  const before = await readAnalyzeCounts(privilegedSql, tables);

  for (const table of tables) {
    // `table` is a compile-time constant from QUERY_PLAN_ANALYZE_TABLES (or a
    // caller-supplied literal in tests) — never user input; `ANALYZE` takes
    // no bind parameters, so `unsafe` interpolation is required and safe here.
    await privilegedSql.unsafe(`ANALYZE ${table}`);
  }

  const after = await readAnalyzeCounts(privilegedSql, tables);

  const results: QueryPlanAnalyzeResult[] = tables.map((table) => ({
    table,
    analyzeCountBefore: before.get(table) ?? 0,
    analyzeCountAfter: after.get(table) ?? 0
  }));

  const skipped = results.filter(
    (result) => result.analyzeCountAfter <= result.analyzeCountBefore
  );

  if (skipped.length > 0) {
    throw new Error(
      "analyzeQueryPlanFixtures: ANALYZE did NOT refresh planner statistics " +
        `for ${skipped.map((s) => s.table).join(", ")} ` +
        "(pg_stat_user_tables.analyze_count did not advance). PostgreSQL " +
        "SILENTLY SKIPS (a WARNING, never an error) an ANALYZE issued by a " +
        "role that does not OWN the table — the least-privilege awcms_mini_app " +
        "role is exactly such a role (Issue #849). Run ANALYZE from a " +
        "privileged, table-owning connection: pass getAdminSql() in tests, or " +
        "set PERF_ANALYZE_DATABASE_URL to an owner/superuser role for " +
        "scripts/performance-query-plan-check.ts."
    );
  }

  return results;
}
