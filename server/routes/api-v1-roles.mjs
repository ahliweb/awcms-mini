import { Hono } from "hono";

import { createRoleRepository } from "../../src/db/repositories/roles.mjs";
import { middlewareAbacGuard } from "../middleware/abac.mjs";

export function routeApiV1Roles(options = {}) {
  const app = new Hono();
  const roles = options.roleRepository ?? createRoleRepository(options.database);

  app.get(
    "/",
    middlewareAbacGuard(
      {
        permissionCode: "admin.roles.read",
        action: "read",
        resource: { kind: "role" },
      },
      options,
    ),
    async (c) => {
      const data = await roles.listRoles({ includeDeleted: false });
      return c.json({ data });
    },
  );

  return app;
}
