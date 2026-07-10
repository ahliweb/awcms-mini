/**
 * Orchestrates the finalize step's real R2 verification (Issue #634, epic
 * `news_portal`) — the fix for the security-auditor Critical finding on
 * Issue #631: `HEAD` alone is NEVER sufficient to promote a media object to
 * `verified`. This function performs, in this exact order
 * (`full-online-r2-architecture.md` §9, `r2-upload-sop.md` §2 step 5):
 *
 *   1. `HEAD` (via `NewsMediaR2Client.headObject`) — cheap existence +
 *      real-size check, short-circuits before any full `GET` for a missing
 *      or over-size object.
 *   2. Full `GET` (via `NewsMediaR2Client.getObject`) — reads the object's
 *      actual bytes.
 *   3. MIME sniffing from magic bytes (`sniffNewsMediaMimeType`) against
 *      the bytes from step 2 — NOT `Content-Type`, NOT the file extension,
 *      NOT the checksum.
 *   4. Server-side SHA-256 checksum computed from the SAME bytes read in
 *      step 2.
 *   5. `decideNewsMediaFinalizeOutcome` — the pure classification of the
 *      above against the allow-list/claimed mime type/claimed checksum.
 *
 * Deliberately takes no `Bun.SQL`/transaction — every call here is a
 * network call to R2 and must run strictly OUTSIDE any DB transaction
 * (ADR-0006). The caller (`pages/api/v1/media/news-images/upload-sessions/
 * [id]/finalize.ts`) runs this between two separate `withTenant` blocks.
 */
import type { NewsMediaR2Client } from "../infrastructure/news-media-r2-client";
import { sniffNewsMediaMimeType } from "../domain/news-media-mime-sniffer";
import { decideNewsMediaFinalizeOutcome } from "../domain/news-media-finalize-decision";

export type VerifyNewsMediaR2ObjectInput = {
  objectKey: string;
  claimedMimeType: string;
  allowedMimeTypes: string[];
  maxUploadBytes: number;
  claimedChecksumSha256: string | null;
};

export type NewsMediaR2VerificationRejectionReason =
  | "object_not_found"
  | "size_exceeded"
  | "mime_not_recognized"
  | "mime_not_allowed"
  | "mime_mismatch"
  | "checksum_mismatch";

export type NewsMediaR2VerificationResult =
  | { outcome: "accepted"; sizeBytes: number; checksumSha256: string }
  | { outcome: "rejected"; reason: NewsMediaR2VerificationRejectionReason }
  | { outcome: "provider_error"; error: string };

export async function verifyNewsMediaR2Object(
  client: NewsMediaR2Client,
  input: VerifyNewsMediaR2ObjectInput
): Promise<NewsMediaR2VerificationResult> {
  const head = await client.headObject(input.objectKey);

  if (!head.ok) {
    return { outcome: "provider_error", error: head.error };
  }

  if (!head.exists) {
    return { outcome: "rejected", reason: "object_not_found" };
  }

  if (head.sizeBytes > input.maxUploadBytes) {
    return { outcome: "rejected", reason: "size_exceeded" };
  }

  const get = await client.getObject(input.objectKey);

  if (!get.ok) {
    return { outcome: "provider_error", error: get.error };
  }

  const sniffedMimeType = sniffNewsMediaMimeType(get.bytes);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(get.bytes);
  const computedChecksumSha256 = hasher.digest("hex");

  const decision = decideNewsMediaFinalizeOutcome({
    claimedMimeType: input.claimedMimeType,
    allowedMimeTypes: input.allowedMimeTypes,
    sniffedMimeType,
    claimedChecksumSha256: input.claimedChecksumSha256,
    computedChecksumSha256
  });

  if (!decision.accepted) {
    return { outcome: "rejected", reason: decision.reason };
  }

  return {
    outcome: "accepted",
    sizeBytes: head.sizeBytes,
    checksumSha256: computedChecksumSha256
  };
}
