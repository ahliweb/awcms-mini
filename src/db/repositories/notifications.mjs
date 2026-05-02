import { getDatabase } from "../index.mjs";

const REQUEST_COLUMNS = [
  "id",
  "channel",
  "provider",
  "template_id",
  "recipient_user_id",
  "recipient_address",
  "subject",
  "body_rendered",
  "status",
  "idempotency_key",
  "metadata",
  "scheduled_at",
  "sent_at",
  "failed_at",
  "failure_reason",
  "created_at",
  "updated_at",
  "created_by",
];

export function createNotificationRepository(executor = getDatabase()) {
  return {
    async createRequest(input) {
      await executor
        .insertInto("notification_requests")
        .values({
          id: input.id,
          channel: input.channel,
          provider: input.provider,
          template_id: input.template_id ?? null,
          recipient_user_id: input.recipient_user_id ?? null,
          recipient_address: input.recipient_address,
          subject: input.subject ?? null,
          body_rendered: input.body_rendered ?? null,
          status: input.status ?? "pending",
          idempotency_key: input.idempotency_key ?? null,
          metadata: input.metadata ?? {},
          created_by: input.created_by ?? null,
        })
        .execute();

      return this.getRequestById(input.id);
    },

    async getRequestById(id) {
      return executor
        .selectFrom("notification_requests")
        .select(REQUEST_COLUMNS)
        .where("id", "=", id)
        .executeTakeFirst();
    },

    async getRequestByIdempotencyKey(idempotencyKey) {
      return executor
        .selectFrom("notification_requests")
        .select(REQUEST_COLUMNS)
        .where("idempotency_key", "=", idempotencyKey)
        .executeTakeFirst();
    },

    async markRequestStatus(id, patch) {
      await executor
        .updateTable("notification_requests")
        .set({
          status: patch.status,
          sent_at: patch.sent_at ?? undefined,
          failed_at: patch.failed_at ?? undefined,
          failure_reason: patch.failure_reason ?? undefined,
          metadata: patch.metadata ?? undefined,
          updated_at: new Date().toISOString(),
        })
        .where("id", "=", id)
        .execute();

      return this.getRequestById(id);
    },

    async appendDeliveryLog(input) {
      await executor
        .insertInto("notification_delivery_logs")
        .values({
          id: input.id,
          notification_request_id: input.notification_request_id,
          attempt_number: input.attempt_number ?? 1,
          provider_message_id: input.provider_message_id ?? null,
          status: input.status,
          response_code: input.response_code ?? null,
          response_body: input.response_body ?? null,
        })
        .execute();
    },

    async listDeliveryLogs(notificationRequestId) {
      return executor
        .selectFrom("notification_delivery_logs")
        .selectAll()
        .where("notification_request_id", "=", notificationRequestId)
        .orderBy("attempted_at", "asc")
        .execute();
    },

    async appendWebhookEvent(input) {
      await executor
        .insertInto("provider_webhook_events")
        .values({
          id: input.id,
          provider: input.provider,
          event_type: input.event_type,
          provider_message_id: input.provider_message_id ?? null,
          raw_payload: input.raw_payload ?? {},
          processed: input.processed ?? false,
          processed_at: input.processed_at ?? null,
        })
        .execute();
    },
  };
}
