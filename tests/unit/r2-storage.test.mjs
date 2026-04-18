import test from "node:test";
import assert from "node:assert/strict";

import { assertAllowedR2Upload, buildR2ObjectKey, createR2StorageService, R2StorageError } from "../../src/services/storage/r2.mjs";

function createFakeBucket() {
  const objects = new Map();

  return {
    objects,
    async put(key, body, options = {}) {
      const content = typeof body === "string" ? body : String(body ?? "");
      const next = {
        key,
        size: content.length,
        etag: `etag-${key}`,
        body: content,
        httpMetadata: options.httpMetadata ?? {},
        customMetadata: options.customMetadata ?? {},
      };

      objects.set(key, next);
      return next;
    },
    async head(key) {
      return objects.get(key) ?? null;
    },
    async get(key) {
      return objects.get(key) ?? null;
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

test("assertAllowedR2Upload enforces content type, extension, and size allowlists", () => {
  const allowed = assertAllowedR2Upload({
    filename: "avatar.png",
    contentType: "image/png",
    size: 1024,
  }, {
    allowedContentTypes: ["image/png"],
    maxUploadBytes: 2048,
  });

  assert.equal(allowed.contentType, "image/png");

  assert.throws(
    () => assertAllowedR2Upload({ filename: "avatar.exe", contentType: "image/png", size: 1024 }, { allowedContentTypes: ["image/png"], maxUploadBytes: 2048 }),
    (error) => error instanceof R2StorageError && error.code === "R2_EXTENSION_NOT_ALLOWED",
  );

  assert.throws(
    () => assertAllowedR2Upload({ filename: "avatar.png", contentType: "image/png", size: 4096 }, { allowedContentTypes: ["image/png"], maxUploadBytes: 2048 }),
    (error) => error instanceof R2StorageError && error.code === "R2_SIZE_NOT_ALLOWED",
  );
});

test("buildR2ObjectKey generates application-owned scoped keys", () => {
  const key = buildR2ObjectKey({
    scope: "avatars",
    ownerId: "user_1",
    id: "media_1",
    filename: "photo.png",
  });

  assert.equal(key, "avatars/user_1/media_1.png");
});

test("createR2StorageService uses the configured bucket binding and stores private object metadata", async () => {
  const bucket = createFakeBucket();
  const service = createR2StorageService({
    bucket,
    runtimeConfig: {
      r2: {
        mediaBucketBinding: "MEDIA_BUCKET",
        maxUploadBytes: 4096,
        allowedContentTypes: ["image/png"],
      },
    },
  });

  const stored = await service.putObject({
    scope: "avatars",
    ownerId: "user_1",
    id: "avatar_1",
    filename: "avatar.png",
    contentType: "image/png",
    size: 6,
    body: "binary",
  });

  assert.equal(stored.key, "avatars/user_1/avatar_1.png");
  assert.equal(bucket.objects.get(stored.key).httpMetadata.contentType, "image/png");
  assert.equal(bucket.objects.get(stored.key).customMetadata.ownerId, "user_1");

  const head = await service.headObject(stored.key);
  assert.equal(head.key, stored.key);

  await service.deleteObject(stored.key);
  assert.equal(await service.getObject(stored.key), null);
});

test("createR2StorageService rejects missing bucket bindings", () => {
  assert.throws(
    () => createR2StorageService({ env: {}, runtimeConfig: { r2: { mediaBucketBinding: "MEDIA_BUCKET", maxUploadBytes: 4096, allowedContentTypes: ["image/png"] } } }),
    (error) => error instanceof R2StorageError && error.code === "R2_BUCKET_NOT_CONFIGURED",
  );
});
