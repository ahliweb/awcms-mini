/**
 * "postgres-disconnect" scenario (Issue #699). Simulates a PostgreSQL
 * disconnect/restart AT THE CLIENT LEVEL — this scenario NEVER stops,
 * restarts, or otherwise disrupts a real PostgreSQL process. Doing so
 * against the shared dev Postgres container this repo's agents run
 * against in parallel would break every other concurrently-running
 * integration test, so it is out of bounds regardless of how "realistic"
 * it would be; a connection-string-level/client-level simulation is the
 * correct non-destructive proxy (see `docs/awcms-mini/
 * resilience-dr-verification.md` §Scenario catalog for the full
 * implemented-vs-simulated disclosure).
 *
 * Phases:
 * - Setup: open one real connection, confirm it works (`SELECT 1`).
 * - Execute: close that connection from the client side (the same
 *   client-visible effect a server-side disconnect/restart has — the next
 *   query on that connection must fail, not hang).
 * - Verify: (a) a query against the now-closed client fails as expected;
 *   (b) a FRESH client successfully reconnects — its connect-to-first-
 *   query latency is recorded as the RTO proxy for "how long would it
 *   take this app to recover a working DB connection after a real
 *   disconnect/restart".
 * - Cleanup: close the fresh client too.
 */
import type { ScenarioDefinition, ScenarioOutcome } from "../scenario-runner";

export function postgresDisconnectScenario(): ScenarioDefinition {
  return {
    name: "postgres-disconnect",
    tier: "safe",
    timeoutMs: 15_000,
    async run(ctx): Promise<ScenarioOutcome> {
      // Setup.
      const sql = new Bun.SQL(ctx.databaseUrl, { max: 1 });

      try {
        await sql`SELECT 1`;
      } catch (error) {
        return {
          ok: false,
          detail: `Setup failed — could not run a baseline query before simulating disconnect: ${error instanceof Error ? error.message : String(error)}`
        };
      }

      // Execute: client-level disconnect.
      await sql.close({ timeout: 1 });

      // Verify (a): a query against the closed client must fail, not hang
      // or silently succeed.
      let queryAfterCloseFailed = false;

      try {
        await sql`SELECT 1`;
      } catch {
        queryAfterCloseFailed = true;
      }

      if (!queryAfterCloseFailed) {
        return {
          ok: false,
          detail:
            "A query against a closed client unexpectedly succeeded — " +
            "client-level disconnect was not observed."
        };
      }

      // Verify (b): a fresh client reconnects; latency is the RTO proxy.
      const reconnectStart = performance.now();
      const freshSql = new Bun.SQL(ctx.databaseUrl, { max: 1 });

      try {
        await freshSql`SELECT 1`;
      } catch (error) {
        return {
          ok: false,
          detail: `A fresh client failed to reconnect after the simulated disconnect: ${error instanceof Error ? error.message : String(error)}`
        };
      } finally {
        // Cleanup.
        await freshSql.close({ timeout: 1 });
      }

      const rtoMs = performance.now() - reconnectStart;

      return {
        ok: true,
        detail:
          `A closed client correctly rejected a query after the simulated ` +
          `disconnect, and a fresh client reconnected in ${rtoMs.toFixed(1)}ms.`,
        metrics: { reconnectRtoMs: Number(rtoMs.toFixed(1)) }
      };
    }
  };
}
