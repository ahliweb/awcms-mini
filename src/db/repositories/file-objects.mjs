import { getDatabase } from "../index.mjs";

const FILE_OBJECT_COLUMNS = [
  "id",
  "entity_type",
  "entity_id",
  "bucket_name",
  "storage_key",
  "original_name",
  "safe_name",
  "mime_type",
  "extension",
  "size_bytes",
  "checksum_sha256",
  "visibility",
  "access_policy",
  "uploaded_by",
  "uploaded_at",
  "verified_at",
  "status",
  "created_at",
  "updated_at",
  "deleted_at",
  "created_by",
  "updated_by",
  "deleted_by",
];

function baseQuery(executor) {
  return executor.selectFrom("file_objects").select(FILE_OBJECT_COLUMNS);
}

export function createFileObjectRepository(executor = getDatabase()) {
  return {
    async createFileObject(input) {
      await executor
        .insertInto("file_objects")
        .values({
          id: input.id,
          entity_type: input.entity_type ?? null,
          entity_id: input.entity_id ?? null,
          bucket_name: input.bucket_name,
          storage_key: input.storage_key,
          original_name: input.original_name,
          safe_name: input.safe_name,
          mime_type: input.mime_type,
          extension: input.extension ?? null,
          size_bytes: input.size_bytes,
          checksum_sha256: input.checksum_sha256 ?? null,
          visibility: input.visibility ?? "private",
          access_policy: input.access_policy ?? "authenticated",
          uploaded_by: input.uploaded_by ?? null,
          uploaded_at: input.uploaded_at ?? undefined,
          verified_at: input.verified_at ?? null,
          status: input.status ?? "pending",
          created_at: input.created_at ?? undefined,
          updated_at: input.updated_at ?? undefined,
          deleted_at: input.deleted_at ?? null,
          created_by: input.created_by ?? null,
          updated_by: input.updated_by ?? null,
          deleted_by: input.deleted_by ?? null,
        })
        .execute();

      return this.getFileObjectById(input.id);
    },

    async getFileObjectById(id) {
      return baseQuery(executor).where("id", "=", id).executeTakeFirst();
    },

    async updateFileObject(id, patch) {
      const values = {};

      for (const [key, value] of Object.entries(patch ?? {})) {
        if (value !== undefined) {
          values[key] = value;
        }
      }

      if (Object.keys(values).length === 0) {
        return this.getFileObjectById(id);
      }

      await executor
        .updateTable("file_objects")
        .set({
          ...values,
          updated_at: values.updated_at ?? new Date().toISOString(),
        })
        .where("id", "=", id)
        .execute();

      return this.getFileObjectById(id);
    },
  };
}

export { FILE_OBJECT_COLUMNS };
