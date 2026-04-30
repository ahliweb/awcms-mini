import crypto from "node:crypto";

import { getRuntimeConfig } from "../../config/runtime.mjs";
import { createNotificationRepository } from "../../db/repositories/notifications.mjs";
import { createMailketingProvider, createStarsenderProvider, verifyWebhookSignature } from "./providers.mjs";

function maskRecipient(value) {
  const input = String(value ?? "").trim();

  if (!input) {
    return "";
  }

  if (input.includes("@")) {
    const [name, domain] = input.split("@");
    return `${name.slice(0, 2)}***@${domain}`;
  }

  return `${input.slice(0, 4)}***`;
}

export function createNotificationService(options = {}) {
  const runtimeConfig = options.runtimeConfig ?? getRuntimeConfig();
  const repo = options.notificationRepository ?? createNotificationRepository(options.database);
  const mailketing =
    options.mailketingProvider ??
    createMailketingProvider(
      {
        baseUrl: process.env.MAILKETING_API_BASE_URL,
        apiKey: process.env.MAILKETING_API_KEY,
      },
      options.fetchImpl,
    );
  const starsender =
    options.starsenderProvider ??
    createStarsenderProvider(
      {
        baseUrl: process.env.STARSENDER_API_BASE_URL,
        apiKey: process.env.STARSENDER_API_KEY,
      },
      options.fetchImpl,
    );

  async function send({ channel, provider, recipientAddress, subject, bodyRendered, idempotencyKey, actorId, metadata }) {
    if (!recipientAddress) {
      throw new Error("Recipient is required.");
    }

    if (idempotencyKey) {
      const existing = await repo.getRequestByIdempotencyKey(idempotencyKey);

      if (existing) {
        return existing;
      }
    }

    const requestId = crypto.randomUUID();
    const request = await repo.createRequest({
      id: requestId,
      channel,
      provider,
      recipient_address: maskRecipient(recipientAddress),
      subject,
      body_rendered: bodyRendered,
      status: "pending",
      idempotency_key: idempotencyKey ?? null,
      metadata: metadata ?? {},
      created_by: actorId ?? null,
    });

    const activeProvider = provider === "mailketing" ? mailketing : starsender;
    const response = await activeProvider.send({
      recipient: recipientAddress,
      subject,
      body: bodyRendered,
      metadata: metadata ?? {},
    });

    await repo.appendDeliveryLog({
      id: crypto.randomUUID(),
      notification_request_id: request.id,
      attempt_number: 1,
      provider_message_id: response.messageId,
      status: response.ok ? "sent" : "failed",
      response_code: response.status,
      response_body: JSON.stringify(response.body ?? {}),
    });

    if (response.ok) {
      return repo.markRequestStatus(request.id, {
        status: "sent",
        sent_at: new Date().toISOString(),
      });
    }

    return repo.markRequestStatus(request.id, {
      status: "failed",
      failed_at: new Date().toISOString(),
      failure_reason: `provider_status_${response.status}`,
    });
  }

  return {
    async sendEmail(input) {
      return send({
        channel: "email",
        provider: "mailketing",
        ...input,
      });
    },

    async sendWhatsApp(input) {
      return send({
        channel: "whatsapp",
        provider: "starsender",
        ...input,
      });
    },

    async getDeliveryStatus(notificationId) {
      const request = await repo.getRequestById(notificationId);

      if (!request) {
        return null;
      }

      const logs = await repo.listDeliveryLogs(notificationId);
      return { request, logs };
    },

    async processProviderWebhook(provider, payload, signature) {
      const rawPayload = JSON.stringify(payload ?? {});
      const secret = provider === "mailketing" ? process.env.MAILKETING_WEBHOOK_SECRET : process.env.STARSENDER_WEBHOOK_SECRET;
      const valid = verifyWebhookSignature({ payload: rawPayload, signature, secret });

      if (!valid) {
        return { accepted: false, reason: "INVALID_SIGNATURE" };
      }

      await repo.appendWebhookEvent({
        id: crypto.randomUUID(),
        provider,
        event_type: String(payload?.event ?? "unknown"),
        provider_message_id: payload?.messageId ?? payload?.id ?? null,
        raw_payload: payload ?? {},
        processed: true,
        processed_at: new Date().toISOString(),
      });

      return { accepted: true };
    },
  };
}
