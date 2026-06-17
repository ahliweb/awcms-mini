// Repository satu_sehat_kobar.patients

import { createPluginRepository } from "../../../db/plugin-adapter.mjs";

const base = createPluginRepository("satu_sehat_kobar", "patients");

export const patientsRepository = {
  ...base,

  // Strip nik_enc dari output default (reveal hanya via endpoint khusus dengan audit)
  async findById(id) {
    const row = await base.findById(id);
    return row ? stripNik(row) : undefined;
  },

  async findAll(opts) {
    const rows = await base.findAll(opts);
    return rows.map(stripNik);
  },

  async createPatient({ nikEnc, ihsNumber, fullName, birthDate, gender, createdBy, metadata = {} }) {
    return base.insert({
      nik_enc: nikEnc ?? null,
      ihs_number: ihsNumber ?? null,
      full_name: fullName,
      birth_date: birthDate ?? null,
      gender: gender ?? null,
      created_by: createdBy,
      metadata,
    });
  },

  async updateIhsNumber(id, ihsNumber, updatedBy) {
    return base.update(id, { ihs_number: ihsNumber, updated_by: updatedBy });
  },
};

function stripNik(row) {
  // eslint-disable-next-line no-unused-vars
  const { nik_enc, ...rest } = row;
  return rest;
}
