import { Hono } from "hono";

import { createNotificationService } from "../../src/services/notifications/service.mjs";
import { middlewareAbacGuard } from "../middleware/abac.mjs";

function getIdempotencyKey(c) {
  const key = c.req.header("idempotency-key");
  return typeof key === "string" && key.trim() ? key.trim() : null;
}

export function routeApiV1Notifications(options = {}) {
  const app = new Hono();
  let service = options.notificationService ?? null;

  function getService() {
    if (!service) {
      service = createNotificationService(options);
    }

    return service;
  }

  app.post(
    "/email/send",
    middlewareAbacGuard(
      {
        permissionCode: "notifications.send",
        action: "send",
        resource: { kind: "notification", channel: "email" },
      },
      options,
    ),
    async (c) => {
      const body = await c.req.json();
      const actor = c.get("actor") ?? {};
      const result = await getService().sendEmail({
        recipientAddress: body?.recipient,
        subject: body?.subject ?? null,
        bodyRendered: body?.body ?? null,
        idempotencyKey: getIdempotencyKey(c),
        actorId: actor.user_id ?? actor.id ?? null,
        metadata: body?.metadata ?? {},
      });

      return c.json({ data: result });
    },
  );

  app.post(
    "/whatsapp/send",
    middlewareAbacGuard(
      {
        permissionCode: "notifications.send",
        action: "send",
        resource: { kind: "notification", channel: "whatsapp" },
      },
      options,
    ),
    async (c) => {
      const body = await c.req.json();
      const actor = c.get("actor") ?? {};
      const result = await getService().sendWhatsApp({
        recipientAddress: body?.recipient,
        bodyRendered: body?.body ?? null,
        idempotencyKey: getIdempotencyKey(c),
        actorId: actor.user_id ?? actor.id ?? null,
        metadata: body?.metadata ?? {},
      });

      return c.json({ data: result });
    },
  );

  app.get(
    "/:id",
    middlewareAbacGuard(
      {
        permissionCode: "notifications.read",
        action: "read",
        resource: { kind: "notification" },
      },
      options,
    ),
    async (c) => {
      const status = await getService().getDeliveryStatus(c.req.param("id"));

      if (!status) {
        return c.json({ error: { code: "NOT_FOUND", message: "Notification not found." } }, 404);
      }

      return c.json({ data: status.request });
    },
  );

  app.get(
    "/:id/delivery-logs",
    middlewareAbacGuard(
      {
        permissionCode: "notifications.read_delivery_logs",
        action: "read",
        resource: { kind: "notification_delivery_log" },
      },
      options,
    ),
    async (c) => {
      const status = await getService().getDeliveryStatus(c.req.param("id"));

      if (!status) {
        return c.json({ error: { code: "NOT_FOUND", message: "Notification not found." } }, 404);
      }

      return c.json({ data: status.logs });
    },
  );

  return app;
}
