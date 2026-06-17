// Repository satu_sehat_kobar.encounters

import { createPluginRepository } from "../../../db/plugin-adapter.mjs";

const base = createPluginRepository("satu_sehat_kobar", "encounters");

export const encountersRepository = {
  ...base,

  async findByPatientId(patientId, { limit = 50, offset = 0 } = {}) {
    const { getDatabase } = await import("../../../db/index.mjs");
    return getDatabase()
      .withSchema("satu_sehat_kobar")
      .selectFrom("encounters")
      .selectAll()
      .where("patient_id", "=", patientId)
      .where("deleted_at", "is", null)
      .limit(limit)
      .offset(offset)
      .execute();
  },

  async findPending({ limit = 50, offset = 0 } = {}) {
    const { getDatabase } = await import("../../../db/index.mjs");
    return getDatabase()
      .withSchema("satu_sehat_kobar")
      .selectFrom("encounters")
      .selectAll()
      .where("status", "=", "pending")
      .where("deleted_at", "is", null)
      .limit(limit)
      .offset(offset)
      .execute();
  },

  async createEncounter({ patientId, encounterDate, encounterType, createdBy, metadata = {} }) {
    return base.insert({
      patient_id: patientId,
      encounter_date: encounterDate,
      encounter_type: encounterType,
      status: "pending",
      created_by: createdBy,
      metadata,
    });
  },

  async markSynced(id, satusehatId, updatedBy) {
    return base.update(id, { status: "synced", satusehat_id: satusehatId, updated_by: updatedBy });
  },

  async markFailed(id, updatedBy) {
    return base.update(id, { status: "failed", updated_by: updatedBy });
  },
};
