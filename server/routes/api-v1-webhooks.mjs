import { Hono } from "hono";

import { createNotificationService } from "../../src/services/notifications/service.mjs";

async function parsePayload(c) {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

export function routeApiV1Webhooks(options = {}) {
  const app = new Hono();
  let service = options.notificationService ?? null;

  function getService() {
    if (!service) {
      service = createNotificationService(options);
    }

    return service;
  }

  app.post("/mailketing", async (c) => {
    const payload = await parsePayload(c);

    if (!payload) {
      return c.json({ error: { code: "INVALID_BODY", message: "Expected JSON payload." } }, 400);
    }

    const signature = c.req.header("x-webhook-signature") ?? "";
    const result = await getService().processProviderWebhook("mailketing", payload, signature);

    if (!result.accepted) {
      return c.json({ error: { code: result.reason, message: "Webhook rejected." } }, 401);
    }

    return c.json({ data: { success: true } });
  });

  app.post("/starsender", async (c) => {
    const payload = await parsePayload(c);

    if (!payload) {
      return c.json({ error: { code: "INVALID_BODY", message: "Expected JSON payload." } }, 400);
    }

    const signature = c.req.header("x-webhook-signature") ?? "";
    const result = await getService().processProviderWebhook("starsender", payload, signature);

    if (!result.accepted) {
      return c.json({ error: { code: result.reason, message: "Webhook rejected." } }, 401);
    }

    return c.json({ data: { success: true } });
  });

  return app;
}
