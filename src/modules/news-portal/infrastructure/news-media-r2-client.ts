/**
 * Cloudflare R2 client for the news-media presigned upload flow (Issue #634,
 * epic `news_portal`). `Bun.S3Client` (Bun-native, S3-API-compatible — R2 is
 * S3-compatible; no npm AWS/S3 SDK per project constraint), same pattern as
 * `sync-storage/infrastructure/object-storage-uploader.ts`: circuit breaker
 * + timeout around every real network call. Deliberately a SEPARATE
 * provider-circuit-breaker key (`news-media-r2`, not `object-storage`) so an
 * outage in one bucket/credential pair never trips the breaker for the
 * other — matching "Keputusan kunci #1" (separate bucket/credentials from
 * `sync-storage`) in `.claude/skills/awcms-mini-news-portal/SKILL.md`.
 *
 * Every method here is called strictly OUTSIDE any DB transaction by its
 * caller (route handlers under `src/pages/api/v1/media/news-images/`) —
 * ADR-0006. `presignUploadUrl` is a pure, local HMAC signature computation
 * (no network round-trip at all), but is still kept out of any `withTenant`/
 * `sql.begin` block for the same reason: this file is the one and only
 * place that touches R2 credentials/config, and keeping that discipline
 * uniform (rather than "only the genuinely-networked calls count") avoids
 * a future refactor accidentally moving a real network call inside a
 * transaction by analogy with this one.
 */
import { getProviderCircuitBreaker } from "../../../lib/database/circuit-breaker";
import { withTimeout } from "../../../lib/integration/timeout";

const PROVIDER_KEY = "news-media-r2";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ERROR_MESSAGE_LENGTH = 500;

function truncateError(message: string): string {
  return message.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…`
    : message;
}

export type NewsMediaR2ClientConfig = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Override for tests only (a local fake S3-compatible HTTP server — same convention as `object-storage-uploader.ts`'s `R2UploaderConfig.endpoint`). */
  endpoint?: string;
  timeoutMs?: number;
};

export type NewsMediaR2PresignUploadInput = {
  objectKey: string;
  mimeType: string;
  ttlSeconds: number;
};

export type NewsMediaR2HeadResult =
  | { ok: true; exists: true; sizeBytes: number }
  | { ok: true; exists: false }
  | { ok: false; error: string };

export type NewsMediaR2GetResult =
  { ok: true; bytes: Uint8Array } | { ok: false; error: string };

export type NewsMediaR2Client = {
  /**
   * Presigned `PUT` URL scoped to exactly one server-generated object key,
   * expiring after `ttlSeconds` — never includes raw R2 credentials, only a
   * signed URL (`full-online-r2-architecture.md` §8).
   */
  presignUploadUrl(input: NewsMediaR2PresignUploadInput): string;
  /**
   * Cheap existence + size check (§9 step 1) — always run BEFORE
   * `getObject`, so an object that is already known to be missing or
   * over-size never wastes bandwidth on a full `GET`.
   */
  headObject(objectKey: string): Promise<NewsMediaR2HeadResult>;
  /**
   * Full object `GET` (§9 steps 2/5) — the caller must have already
   * confirmed via `headObject` that the real size is within
   * `NEWS_MEDIA_R2_MAX_UPLOAD_BYTES`; this method does not itself cap the
   * read, by design, because a partial/ranged read cannot be used for
   * either MIME sniffing (needs the leading bytes at minimum, but a
   * corrupt/truncated read could still coincidentally sniff clean) or a
   * checksum that means anything (a checksum of a truncated read digest is
   * NOT the checksum of the uploaded object).
   */
  getObject(objectKey: string): Promise<NewsMediaR2GetResult>;
};

export function createNewsMediaR2Client(
  config: NewsMediaR2ClientConfig
): NewsMediaR2Client {
  const endpoint =
    config.endpoint ?? `https://${config.accountId}.r2.cloudflarestorage.com`;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const client = new Bun.S3Client({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    bucket: config.bucket,
    endpoint,
    region: "auto"
  });
  const breaker = getProviderCircuitBreaker(PROVIDER_KEY);

  return {
    presignUploadUrl({ objectKey, mimeType, ttlSeconds }) {
      return client.file(objectKey).presign({
        method: "PUT",
        expiresIn: ttlSeconds,
        type: mimeType
      });
    },

    async headObject(objectKey) {
      const attemptedAt = new Date();

      if (!breaker.canAttempt(attemptedAt)) {
        return {
          ok: false,
          error: "News media R2 circuit breaker is open; skipping attempt."
        };
      }

      try {
        const file = client.file(objectKey);
        const exists = await withTimeout(
          file.exists(),
          timeoutMs,
          `news-media-r2 HEAD exists ${objectKey}`
        );

        if (!exists) {
          // A clean "not found" answer is a successful HEAD call, not a
          // provider malfunction — never trips the breaker.
          breaker.recordSuccess(new Date());
          return { ok: true, exists: false };
        }

        const stat = await withTimeout(
          file.stat(),
          timeoutMs,
          `news-media-r2 HEAD stat ${objectKey}`
        );

        breaker.recordSuccess(new Date());
        return { ok: true, exists: true, sizeBytes: stat.size };
      } catch (error) {
        breaker.recordFailure(new Date());
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: truncateError(message) };
      }
    },

    async getObject(objectKey) {
      const attemptedAt = new Date();

      if (!breaker.canAttempt(attemptedAt)) {
        return {
          ok: false,
          error: "News media R2 circuit breaker is open; skipping attempt."
        };
      }

      try {
        const file = client.file(objectKey);
        const buffer = await withTimeout(
          file.arrayBuffer(),
          timeoutMs,
          `news-media-r2 GET ${objectKey}`
        );

        breaker.recordSuccess(new Date());
        return { ok: true, bytes: new Uint8Array(buffer) };
      } catch (error) {
        breaker.recordFailure(new Date());
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: truncateError(message) };
      }
    }
  };
}
