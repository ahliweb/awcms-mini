// Repository satu_sehat_kobar.sync_logs

import { createPluginRepository } from "../../../db/plugin-adapter.mjs";

const base = createPluginRepository("satu_sehat_kobar", "sync_logs");

export const syncLogsRepository = {
  ...base,

  async createLog({ entityType, entityId, direction, status, httpStatus, errorMessage, createdBy }) {
    return base.insert({
      entity_type: entityType,
      entity_id: entityId,
      direction,
      status,
      http_status: httpStatus ?? null,
      error_message: errorMessage ?? null,
      created_by: createdBy,
    });
  },

  async findByEntity(entityType, entityId, { limit = 20 } = {}) {
    const { getDatabase } = await import("../../../db/index.mjs");
    return getDatabase()
      .withSchema("satu_sehat_kobar")
      .selectFrom("sync_logs")
      .selectAll()
      .where("entity_type", "=", entityType)
      .where("entity_id", "=", entityId)
      .orderBy("created_at", "desc")
      .limit(limit)
      .execute();
  },
};
