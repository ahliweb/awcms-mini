/**
 * Health route — GET /health
 *
 * Returns a JSON health check that includes database reachability and
 * the current runtime posture. Suitable for Coolify health check probes.
 */

import { Hono } from "hono";

import { checkDatabaseHealth, describeDatabaseHealthPosture } from "../../src/db/health.mjs";

/**
 * @param {object} [options]
 * @returns {Hono}
 */
export function routeHealth(options = {}) {
  const app = new Hono();

  app.get("/", async (c) => {
    const database = await checkDatabaseHealth();
    const posture = describeDatabaseHealthPosture();
    const ok = database.ok;

    return c.json(
      {
        ok,
        service: "awcms-mini",
        version: "v1",
        checks: {
          database: {
            ok: database.ok,
            ...(database.ok
              ? {}
              : {
                  kind: database.kind,
                  reason: database.reason,
                }),
            posture,
          },
        },
        timestamp: new Date().toISOString(),
      },
      ok ? 200 : 503,
    );
  });

  return app;
}
