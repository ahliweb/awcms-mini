import { randomUUID } from "node:crypto";

import { Hono } from "hono";

import { createFileObjectRepository } from "../../src/db/repositories/file-objects.mjs";
import { getRuntimeConfig } from "../../src/config/runtime.mjs";
import { buildR2ObjectKey, createR2StorageService, assertAllowedR2Upload, R2StorageError } from "../../src/services/storage/r2.mjs";
import { createFileAccessTokenService } from "../../src/services/storage/file-access-tokens.mjs";
import { middlewareAbacGuard } from "../middleware/abac.mjs";

function badRequest(c, code, message) {
  return c.json({ error: { code, message } }, 400);
}

function safeFilename(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

export function routeApiV1Files(options = {}) {
  const app = new Hono();
  const runtimeConfig = options.runtimeConfig ?? getRuntimeConfig();
  const files = options.fileRepository ?? createFileObjectRepository(options.database);
  let storageService = options.r2StorageService ?? null;
  let fileTokenService = options.fileAccessTokenService ?? null;

  function getStorage() {
    if (!storageService) {
      storageService = createR2StorageService({
        runtimeConfig,
        env: options.env,
      });
    }

    return storageService;
  }

  function getFileTokens() {
    if (!fileTokenService) {
      fileTokenService = createFileAccessTokenService({ runtimeConfig });
    }

    return fileTokenService;
  }

  app.post(
    "/upload-request",
    middlewareAbacGuard(
      {
        permissionCode: "content.posts.update",
        action: "update",
        resource: { kind: "file_object" },
      },
      options,
    ),
    async (c) => {
      let body;

      try {
        body = await c.req.json();
      } catch {
        return badRequest(c, "INVALID_BODY", "Expected JSON body.");
      }

      const filename = typeof body?.filename === "string" ? body.filename.trim() : "";
      const contentType = typeof body?.contentType === "string" ? body.contentType.trim().toLowerCase() : "";
      const size = Number(body?.size ?? 0);
      const checksumSha256 = typeof body?.checksumSha256 === "string" ? body.checksumSha256.trim().toLowerCase() : null;

      if (!filename || !contentType || !Number.isFinite(size) || size <= 0) {
        return badRequest(c, "INVALID_UPLOAD_INPUT", "filename, contentType, and positive size are required.");
      }

      let validated;

      try {
        validated = assertAllowedR2Upload({ filename, contentType, size }, { runtimeConfig });
      } catch (error) {
        if (error instanceof R2StorageError) {
          return c.json({ error: { code: error.code, message: error.message, details: error.metadata } }, 400);
        }

        throw error;
      }

      const actor = c.get("actor") ?? {};
      const actorId = actor.user_id ?? actor.id ?? "system";
      const fileId = randomUUID();
      const safeName = safeFilename(filename) || `${fileId}.${validated.extension}`;
      const storageKey = buildR2ObjectKey({
        scope: body?.scope ?? "uploads",
        ownerId: actorId,
        id: fileId,
        filename: safeName,
      });
      const uploadToken = await getFileTokens().signUploadToken({ fileId, storageKey, actorId });

      await files.createFileObject({
        id: fileId,
        entity_type: typeof body?.entityType === "string" ? body.entityType : null,
        entity_id: typeof body?.entityId === "string" ? body.entityId : null,
        bucket_name: runtimeConfig.r2.mediaBucketName ?? runtimeConfig.r2.mediaBucketBinding,
        storage_key: storageKey,
        original_name: filename,
        safe_name: safeName,
        mime_type: validated.contentType,
        extension: validated.extension,
        size_bytes: validated.size,
        checksum_sha256: checksumSha256,
        visibility: body?.visibility === "public" ? "public" : "private",
        access_policy: body?.visibility === "public" ? "public" : "authenticated",
        uploaded_by: actorId,
        status: "pending",
      });

      const origin = new URL(c.req.url).origin;
      const uploadUrl = `${origin}/api/v1/files/upload/${encodeURIComponent(fileId)}?token=${encodeURIComponent(uploadToken)}`;

      return c.json({
        data: {
          fileId,
          storageKey,
          uploadUrl,
          method: "PUT",
          headers: { "content-type": validated.contentType },
          expiresInSeconds: 300,
        },
      });
    },
  );

  app.put("/upload/:id", async (c) => {
    const fileId = c.req.param("id");
    const token = c.req.query("token") ?? "";

    if (!fileId || !token) {
      return badRequest(c, "INVALID_UPLOAD_TOKEN", "Upload token is required.");
    }

    let claims;

    try {
      claims = await getFileTokens().verify(token, "upload");
    } catch {
      return c.json({ error: { code: "INVALID_UPLOAD_TOKEN", message: "Upload token is invalid or expired." } }, 401);
    }

    if (claims.file_id !== fileId) {
      return c.json({ error: { code: "INVALID_UPLOAD_TOKEN", message: "Upload token does not match file id." } }, 401);
    }

    const file = await files.getFileObjectById(fileId);

    if (!file || file.deleted_at) {
      return c.json({ error: { code: "FILE_NOT_FOUND", message: "File upload request does not exist." } }, 404);
    }

    const body = await c.req.arrayBuffer();

    await getStorage().putObject({
      key: file.storage_key,
      filename: file.safe_name,
      contentType: file.mime_type,
      size: body.byteLength,
      body,
      ownerId: file.uploaded_by ?? "system",
      scope: file.entity_type ?? "uploads",
    });

    return c.json({ data: { success: true, fileId, bytesUploaded: body.byteLength } });
  });

  app.post(
    "/complete-upload",
    middlewareAbacGuard(
      {
        permissionCode: "content.posts.update",
        action: "update",
        resource: { kind: "file_object" },
      },
      options,
    ),
    async (c) => {
      let body;

      try {
        body = await c.req.json();
      } catch {
        return badRequest(c, "INVALID_BODY", "Expected JSON body.");
      }

      const fileId = typeof body?.fileId === "string" ? body.fileId.trim() : "";

      if (!fileId) {
        return badRequest(c, "INVALID_FILE_ID", "fileId is required.");
      }

      const file = await files.getFileObjectById(fileId);

      if (!file || file.deleted_at) {
        return c.json({ error: { code: "FILE_NOT_FOUND", message: "File not found." } }, 404);
      }

      const head = await getStorage().headObject(file.storage_key);

      if (!head) {
        return c.json({ error: { code: "OBJECT_NOT_FOUND", message: "Uploaded object not found in storage." } }, 404);
      }

      const verifiedAt = new Date().toISOString();
      const updated = await files.updateFileObject(file.id, {
        status: "ready",
        verified_at: verifiedAt,
      });

      return c.json({
        data: {
          fileId: updated.id,
          status: updated.status,
          verifiedAt: updated.verified_at,
        },
      });
    },
  );

  app.get(
    "/:id/signed-url",
    middlewareAbacGuard(
      {
        permissionCode: "content.posts.read",
        action: "read",
        resource: { kind: "file_object" },
      },
      options,
    ),
    async (c) => {
      const fileId = c.req.param("id");
      const file = await files.getFileObjectById(fileId);

      if (!file || file.deleted_at || file.status !== "ready") {
        return c.json({ error: { code: "FILE_NOT_FOUND", message: "File not found." } }, 404);
      }

      const actor = c.get("actor") ?? {};
      const actorId = actor.user_id ?? actor.id ?? "system";
      const token = await getFileTokens().signDownloadToken({ fileId: file.id, storageKey: file.storage_key, actorId });
      const origin = new URL(c.req.url).origin;
      const url = `${origin}/api/v1/files/${encodeURIComponent(file.id)}/download?token=${encodeURIComponent(token)}`;

      return c.json({ data: { url, expiresInSeconds: 300 } });
    },
  );

  app.get("/:id/download", async (c) => {
    const fileId = c.req.param("id");
    const token = c.req.query("token") ?? "";

    if (!fileId || !token) {
      return c.json({ error: { code: "INVALID_DOWNLOAD_TOKEN", message: "Download token is required." } }, 401);
    }

    let claims;

    try {
      claims = await getFileTokens().verify(token, "download");
    } catch {
      return c.json({ error: { code: "INVALID_DOWNLOAD_TOKEN", message: "Download token is invalid or expired." } }, 401);
    }

    if (claims.file_id !== fileId) {
      return c.json({ error: { code: "INVALID_DOWNLOAD_TOKEN", message: "Download token does not match file id." } }, 401);
    }

    const file = await files.getFileObjectById(fileId);

    if (!file || file.deleted_at || file.status !== "ready") {
      return c.json({ error: { code: "FILE_NOT_FOUND", message: "File not found." } }, 404);
    }

    const object = await getStorage().getObject(file.storage_key);

    if (!object?.body) {
      return c.json({ error: { code: "OBJECT_NOT_FOUND", message: "Object not found." } }, 404);
    }

    return new Response(object.body, {
      status: 200,
      headers: {
        "content-type": file.mime_type,
        "content-disposition": `inline; filename="${file.safe_name}"`,
      },
    });
  });

  return app;
}
