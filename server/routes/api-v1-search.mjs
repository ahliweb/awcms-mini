/**
 * API v1 search router — /api/v1/search (CQRS query side, ADR-023 Tier 1).
 *
 * Endpoint READ-ONLY yang membungkus query service (`src/search/`). Setiap
 * endpoint dijaga ABAC permission dan mengembalikan read DTO (envelope `{ data }`).
 */

import { Hono } from "hono";

import { searchUsers as defaultSearchUsers } from "../../src/search/users-search.mjs";
import { middlewareAbacGuard } from "../middleware/abac.mjs";

function readSearchQuery(c) {
  const sortField = c.req.query("sortField");
  return {
    q: c.req.query("q"),
    page: c.req.query("page"),
    pageSize: c.req.query("pageSize"),
    sort: sortField ? { field: sortField, dir: c.req.query("sortDir") } : undefined,
  };
}

export function routeApiV1Search(options = {}) {
  const app = new Hono();
  const searchUsers = options.searchUsers ?? defaultSearchUsers;

  // GET /api/v1/search/users — pencarian users (read-only, DTO tanpa password_hash).
  app.get(
    "/users",
    middlewareAbacGuard(
      {
        permissionCode: "admin.users.read",
        action: "read",
        resource: { kind: "user" },
      },
      options,
    ),
    async (c) => {
      const result = await searchUsers(readSearchQuery(c), { db: options.database });
      return c.json({ data: result });
    },
  );

  return app;
}
