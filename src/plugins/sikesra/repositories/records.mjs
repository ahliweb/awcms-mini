// Repository sikesra.records

import { createPluginRepository } from "../../../db/plugin-adapter.mjs";

const base = createPluginRepository("sikesra", "records");

export const recordsRepository = {
  ...base,

  async findBySubjectId(subjectId, { limit = 50, offset = 0 } = {}) {
    const { getDatabase } = await import("../../../db/index.mjs");
    return getDatabase()
      .withSchema("sikesra")
      .selectFrom("records")
      .selectAll()
      .where("subject_id", "=", subjectId)
      .where("deleted_at", "is", null)
      .limit(limit)
      .offset(offset)
      .execute();
  },

  async createRecord({ subjectId, recordType, recordDate, notes, createdBy, metadata = {} }) {
    return base.insert({
      subject_id: subjectId,
      record_type: recordType,
      record_date: recordDate,
      notes: notes ?? null,
      created_by: createdBy,
      metadata,
    });
  },
};
