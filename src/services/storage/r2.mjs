import { randomUUID } from "node:crypto";

import { getRuntimeConfig } from "../../config/runtime.mjs";

const EXTENSION_ALLOWLIST_BY_CONTENT_TYPE = {
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/webp": ["webp"],
  "application/pdf": ["pdf"],
};

export class R2StorageError extends Error {
  constructor(code, message, metadata = {}) {
    super(message);
    this.name = "R2StorageError";
    this.code = code;
    this.metadata = metadata;
  }
}

function sanitizePathSegment(value, fallback) {
  const next = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return next || fallback;
}

function getExtension(filename) {
  const normalized = String(filename ?? "").trim().toLowerCase();
  const parts = normalized.split(".");
  return parts.length > 1 ? parts.at(-1) : "";
}

export function assertAllowedR2Upload(input, options = {}) {
  const contentType = String(input.contentType ?? "").trim().toLowerCase();
  const extension = getExtension(input.filename);
  const size = Number(input.size ?? 0);
  const allowedContentTypes = options.allowedContentTypes ?? getRuntimeConfig().r2.allowedContentTypes;
  const maxUploadBytes = options.maxUploadBytes ?? getRuntimeConfig().r2.maxUploadBytes;

  if (!contentType || !allowedContentTypes.includes(contentType)) {
    throw new R2StorageError("R2_CONTENT_TYPE_NOT_ALLOWED", "Object content type is not allowed.", { contentType });
  }

  const allowedExtensions = EXTENSION_ALLOWLIST_BY_CONTENT_TYPE[contentType] ?? [];

  if (!extension || !allowedExtensions.includes(extension)) {
    throw new R2StorageError("R2_EXTENSION_NOT_ALLOWED", "Object file extension is not allowed.", {
      contentType,
      extension,
    });
  }

  if (!Number.isFinite(size) || size <= 0 || size > maxUploadBytes) {
    throw new R2StorageError("R2_SIZE_NOT_ALLOWED", "Object size is not allowed.", { size, maxUploadBytes });
  }

  return {
    contentType,
    extension,
    size,
  };
}

export function buildR2ObjectKey(input) {
  const scope = sanitizePathSegment(input.scope, "media");
  const ownerId = sanitizePathSegment(input.ownerId, "anonymous");
  const id = sanitizePathSegment(input.id, randomUUID());
  const extension = getExtension(input.filename);

  if (!extension) {
    throw new R2StorageError("R2_EXTENSION_REQUIRED", "Object filename must include an allowed extension.");
  }

  return `${scope}/${ownerId}/${id}.${extension}`;
}

function resolveBucket(env, runtimeConfig) {
  const bindingName = runtimeConfig.r2.mediaBucketBinding;
  const bucket = env?.[bindingName];

  if (!bucket || typeof bucket.put !== "function" || typeof bucket.get !== "function") {
    throw new R2StorageError("R2_BUCKET_NOT_CONFIGURED", `R2 bucket binding is not available: ${bindingName}`);
  }

  return bucket;
}

export function createR2StorageService(options = {}) {
  const runtimeConfig = options.runtimeConfig ?? getRuntimeConfig();
  const env = options.env ?? globalThis;
  const bucket = options.bucket ?? resolveBucket(env, runtimeConfig);

  return {
    async putObject(input) {
      const validated = assertAllowedR2Upload(input, {
        allowedContentTypes: options.allowedContentTypes ?? runtimeConfig.r2.allowedContentTypes,
        maxUploadBytes: options.maxUploadBytes ?? runtimeConfig.r2.maxUploadBytes,
      });

      const key = input.key ?? buildR2ObjectKey({
        scope: input.scope,
        ownerId: input.ownerId,
        id: input.id,
        filename: input.filename,
      });

      const object = await bucket.put(key, input.body, {
        httpMetadata: {
          contentType: validated.contentType,
        },
        customMetadata: {
          ownerId: String(input.ownerId ?? ""),
          scope: String(input.scope ?? "media"),
        },
      });

      return {
        key: object?.key ?? key,
        size: object?.size ?? validated.size,
        etag: object?.etag ?? null,
        contentType: validated.contentType,
      };
    },

    async headObject(key) {
      return bucket.head(key);
    },

    async getObject(key) {
      return bucket.get(key);
    },

    async deleteObject(key) {
      await bucket.delete(key);
    },
  };
}
