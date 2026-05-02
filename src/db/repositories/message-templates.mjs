import { getDatabase } from "../index.mjs";

const TEMPLATE_COLUMNS = [
  "id",
  "template_key",
  "channel",
  "provider",
  "language",
  "subject",
  "body",
  "status",
  "metadata",
  "created_at",
  "updated_at",
  "deleted_at",
  "created_by",
  "updated_by",
  "deleted_by",
];

function baseQuery(executor) {
  return executor.selectFrom("message_templates").select(TEMPLATE_COLUMNS);
}

export function createMessageTemplateRepository(executor = getDatabase()) {
  return {
    async listTemplates(options = {}) {
      let query = baseQuery(executor).where("deleted_at", "is", null);

      if (options.channel) {
        query = query.where("channel", "=", options.channel);
      }

      if (options.provider) {
        query = query.where("provider", "=", options.provider);
      }

      return query.orderBy("template_key", "asc").orderBy("language", "asc").execute();
    },

    async createTemplate(input) {
      await executor
        .insertInto("message_templates")
        .values({
          id: input.id,
          template_key: input.template_key,
          channel: input.channel,
          provider: input.provider,
          language: input.language ?? "en",
          subject: input.subject ?? null,
          body: input.body,
          status: input.status ?? "active",
          metadata: input.metadata ?? {},
          created_by: input.created_by ?? null,
          updated_by: input.updated_by ?? null,
        })
        .execute();

      return this.getTemplateById(input.id);
    },

    async getTemplateById(id) {
      return baseQuery(executor).where("id", "=", id).where("deleted_at", "is", null).executeTakeFirst();
    },
  };
}
