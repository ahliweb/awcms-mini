// Repository sikesra.subjects — wraps createPluginRepository dengan field khusus.

import { createPluginRepository } from "../../../db/plugin-adapter.mjs";

const base = createPluginRepository("sikesra", "subjects");

export const subjectsRepository = {
  ...base,

  // NIK tidak pernah diekspor — strip nik_enc dari output default
  // (reveal hanya via endpoint khusus dengan audit log)
  async findById(id) {
    const row = await base.findById(id);
    return row ? stripNik(row) : undefined;
  },

  async findAll(opts) {
    const rows = await base.findAll(opts);
    return rows.map(stripNik);
  },

  // Insert wajib menggunakan nik_enc (terenkripsi), bukan nik plaintext
  async createSubject({ nikEnc, fullName, birthDate, gender, createdBy, metadata = {} }) {
    return base.insert({
      nik_enc: nikEnc ?? null,
      full_name: fullName,
      birth_date: birthDate ?? null,
      gender: gender ?? null,
      created_by: createdBy,
      metadata,
    });
  },
};

function stripNik(row) {
  // eslint-disable-next-line no-unused-vars
  const { nik_enc, ...rest } = row;
  return rest;
}
