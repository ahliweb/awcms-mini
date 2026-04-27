import { Hono } from "hono";

import { createPermissionRepository } from "../../src/db/repositories/permissions.mjs";
import { middlewareAbacGuard } from "../middleware/abac.mjs";

export function routeApiV1Permissions(options = {}) {
  const app = new Hono();
  const permissions =
    options.permissionRepository ?? createPermissionRepository(options.database);

  app.get(
    "/",
    middlewareAbacGuard(
      {
        permissionCode: "admin.permissions.read",
        action: "read",
        resource: { kind: "permission" },
      },
      options,
    ),
    async (c) => {
      const data = await permissions.listPermissions();
      return c.json({ data });
    },
  );

  return app;
}
