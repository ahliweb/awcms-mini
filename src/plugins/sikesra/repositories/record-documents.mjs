// Repository sikesra.record_documents (metadata file; biner di R2)

import { createPluginRepository } from "../../../db/plugin-adapter.mjs";

const base = createPluginRepository("sikesra", "record_documents");

export const recordDocumentsRepository = {
  ...base,

  async findByRecordId(recordId) {
    const { getDatabase } = await import("../../../db/index.mjs");
    return getDatabase()
      .withSchema("sikesra")
      .selectFrom("record_documents")
      .selectAll()
      .where("record_id", "=", recordId)
      .where("deleted_at", "is", null)
      .execute();
  },

  // r2Key adalah path di Cloudflare R2 (bukan URL raw)
  // Format: tenants/{tenant}/modules/sikesra/highly_restricted/{year}/{month}/{filename}
  async createDocument({ recordId, filename, mimeType, sizeBytes, r2Key, checksumSha256, createdBy }) {
    return base.insert({
      record_id: recordId,
      filename,
      mime_type: mimeType,
      size_bytes: sizeBytes ?? null,
      r2_key: r2Key,
      checksum_sha256: checksumSha256 ?? null,
      created_by: createdBy,
    });
  },
};
