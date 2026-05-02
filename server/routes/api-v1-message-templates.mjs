import crypto from "node:crypto";

import { Hono } from "hono";

import { createMessageTemplateRepository } from "../../src/db/repositories/message-templates.mjs";
import { middlewareAbacGuard } from "../middleware/abac.mjs";

export function routeApiV1MessageTemplates(options = {}) {
  const app = new Hono();
  const templates = options.messageTemplateRepository ?? createMessageTemplateRepository(options.database);

  app.get(
    "/",
    middlewareAbacGuard(
      {
        permissionCode: "notifications.manage_templates",
        action: "read",
        resource: { kind: "message_template" },
      },
      options,
    ),
    async (c) => {
      const data = await templates.listTemplates();
      return c.json({ data });
    },
  );

  app.post(
    "/",
    middlewareAbacGuard(
      {
        permissionCode: "notifications.manage_templates",
        action: "create",
        resource: { kind: "message_template" },
      },
      options,
    ),
    async (c) => {
      const body = await c.req.json();
      const actor = c.get("actor") ?? {};
      const item = await templates.createTemplate({
        id: crypto.randomUUID(),
        template_key: body?.templateKey,
        channel: body?.channel,
        provider: body?.provider,
        language: body?.language ?? "en",
        subject: body?.subject ?? null,
        body: body?.body,
        status: body?.status ?? "active",
        metadata: body?.metadata ?? {},
        created_by: actor.user_id ?? actor.id ?? null,
      });

      return c.json({ data: item }, 201);
    },
  );

  return app;
}
