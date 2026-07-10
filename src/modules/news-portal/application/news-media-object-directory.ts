import { recordAuditEvent } from "../../logging/application/audit-log";
import type { NewsMediaR2Config } from "../domain/news-media-r2-config";
import {
  buildNewsMediaObjectKey,
  buildNewsMediaPublicUrl
} from "../domain/news-media-object-key";

/**
 * Read/write directory for `awcms_mini_news_media_objects` (Issue #633,
 * epic `news_portal`) — same "directory holds reads and writes for one
 * resource" convention as `blog-content/application/blog-post-directory.ts`.
 * Every function here takes an already tenant-scoped `Bun.SQL`/`Bun.TransactionSQL`
 * (from `withTenant`, `lib/database/tenant-context.ts`) — none of them open
 * their own transaction, matching the rest of this repo's directories.
 *
 * Out of scope here (Issue #634): actually talking to R2 (presign, HEAD/GET,
 * streaming PUT) — every status transition below is a plain metadata
 * UPDATE; the caller is responsible for having done the real R2 work first
 * (ADR-0006: provider calls never happen inside a DB transaction).
 *
 * Audit events are written for exactly the actions the epic's acceptance
 * criteria require: create, verify, attach, detach, delete, restore, purge
 * (skill `awcms-mini-audit-log`). The intermediate `pending_upload -> uploaded`
 * and any `-> orphaned`/`-> failed` transition are logged via the structured
 * logger only (`src/lib/logging/logger.ts`) — see `markNewsMediaObjectUploaded`/
 * `markNewsMediaObjectOrphaned`/`markNewsMediaObjectFailed` below for why
 * these are treated as routine lifecycle bookkeeping, not high-risk actions.
 */

export type NewsMediaObjectStatus =
  | "pending_upload"
  | "uploaded"
  | "verified"
  | "attached"
  | "orphaned"
  | "deleted"
  | "failed";

export type NewsMediaOwnerResourceType =
  | "blog_post"
  | "blog_page"
  | "homepage_section"
  | "gallery_item"
  | "ad"
  | "video_thumbnail"
  | "seo_image";

export type NewsMediaObjectView = {
  id: string;
  tenantId: string;
  moduleKey: string;
  ownerResourceType: NewsMediaOwnerResourceType | null;
  ownerResourceId: string | null;
  storageDriver: string;
  bucketName: string;
  objectKey: string;
  originalFilename: string | null;
  publicUrl: string;
  mimeType: string;
  sizeBytes: number | null;
  checksumSha256: string | null;
  width: number | null;
  height: number | null;
  altText: string | null;
  caption: string | null;
  status: NewsMediaObjectStatus;
  createdByTenantUserId: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  deletedBy: string | null;
  deleteReason: string | null;
  restoredAt: Date | null;
  restoredBy: string | null;
};

type NewsMediaObjectRow = {
  id: string;
  tenant_id: string;
  module_key: string;
  owner_resource_type: NewsMediaOwnerResourceType | null;
  owner_resource_id: string | null;
  storage_driver: string;
  bucket_name: string;
  object_key: string;
  original_filename: string | null;
  public_url: string;
  mime_type: string;
  size_bytes: string | number | null;
  checksum_sha256: string | null;
  width: number | null;
  height: number | null;
  alt_text: string | null;
  caption: string | null;
  status: NewsMediaObjectStatus;
  created_by_tenant_user_id: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  deleted_by: string | null;
  delete_reason: string | null;
  restored_at: Date | null;
  restored_by: string | null;
};

function toView(row: NewsMediaObjectRow): NewsMediaObjectView {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    moduleKey: row.module_key,
    ownerResourceType: row.owner_resource_type,
    ownerResourceId: row.owner_resource_id,
    storageDriver: row.storage_driver,
    bucketName: row.bucket_name,
    objectKey: row.object_key,
    originalFilename: row.original_filename,
    publicUrl: row.public_url,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    checksumSha256: row.checksum_sha256,
    width: row.width,
    height: row.height,
    altText: row.alt_text,
    caption: row.caption,
    status: row.status,
    createdByTenantUserId: row.created_by_tenant_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by,
    deleteReason: row.delete_reason,
    restoredAt: row.restored_at,
    restoredBy: row.restored_by
  };
}

const AUDIT_MODULE_KEY = "news_portal";
const AUDIT_RESOURCE_TYPE = "news_media_object";

export type CreatePendingNewsMediaObjectInput = {
  mimeType: string;
  originalFilename?: string;
  altText?: string;
  caption?: string;
};

export class UnsupportedNewsMediaMimeTypeInputError extends Error {
  constructor(mimeType: string, allowedMimeTypes: string[]) {
    super(
      `Mime type "${mimeType}" is not in the configured allow-list: ${allowedMimeTypes.join(", ")}.`
    );
    this.name = "UnsupportedNewsMediaMimeTypeInputError";
  }
}

/**
 * Creates a `status='pending_upload'` metadata row: generates the object
 * key server-side (§6 convention) and the public URL from the trusted
 * `config.publicBaseUrl` — NEVER from client input. `mimeType` is validated
 * against `config.allowedMimeTypes` BEFORE the key is built (defense in
 * depth — this is not the only place mime validation happens; #634's
 * confirm step must still re-validate against actual bytes).
 */
export async function createPendingNewsMediaObject(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  config: NewsMediaR2Config,
  input: CreatePendingNewsMediaObjectInput,
  correlationId?: string
): Promise<NewsMediaObjectView> {
  const mimeType = input.mimeType.toLowerCase().trim();

  if (!config.allowedMimeTypes.includes(mimeType)) {
    throw new UnsupportedNewsMediaMimeTypeInputError(
      mimeType,
      config.allowedMimeTypes
    );
  }

  const objectKey = buildNewsMediaObjectKey({ tenantId, mimeType });
  const publicUrl = buildNewsMediaPublicUrl(config.publicBaseUrl, objectKey);

  const rows = (await tx`
    INSERT INTO awcms_mini_news_media_objects
      (tenant_id, bucket_name, object_key, original_filename, public_url,
       mime_type, alt_text, caption, created_by_tenant_user_id)
    VALUES (
      ${tenantId}, ${config.bucket}, ${objectKey}, ${input.originalFilename ?? null},
      ${publicUrl}, ${mimeType}, ${input.altText ?? null}, ${input.caption ?? null},
      ${actorTenantUserId}
    )
    RETURNING id, tenant_id, module_key, owner_resource_type, owner_resource_id,
      storage_driver, bucket_name, object_key, original_filename, public_url,
      mime_type, size_bytes, checksum_sha256, width, height, alt_text, caption,
      status, created_by_tenant_user_id, created_at, updated_at,
      deleted_at, deleted_by, delete_reason, restored_at, restored_by
  `) as NewsMediaObjectRow[];

  const created = toView(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "news_media.object.created",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: created.id,
    severity: "info",
    message: `News media object created (pending upload): ${objectKey}.`,
    attributes: { objectKey, mimeType },
    correlationId
  });

  return created;
}

export type FetchNewsMediaObjectOptions = {
  includeDeleted?: boolean;
};

export async function fetchNewsMediaObjectById(
  tx: Bun.SQL,
  tenantId: string,
  id: string,
  options: FetchNewsMediaObjectOptions = {}
): Promise<NewsMediaObjectView | null> {
  const rows = (
    options.includeDeleted
      ? await tx`
        SELECT id, tenant_id, module_key, owner_resource_type, owner_resource_id,
          storage_driver, bucket_name, object_key, original_filename, public_url,
          mime_type, size_bytes, checksum_sha256, width, height, alt_text, caption,
          status, created_by_tenant_user_id, created_at, updated_at,
          deleted_at, deleted_by, delete_reason, restored_at, restored_by
        FROM awcms_mini_news_media_objects
        WHERE tenant_id = ${tenantId} AND id = ${id}
      `
      : await tx`
        SELECT id, tenant_id, module_key, owner_resource_type, owner_resource_id,
          storage_driver, bucket_name, object_key, original_filename, public_url,
          mime_type, size_bytes, checksum_sha256, width, height, alt_text, caption,
          status, created_by_tenant_user_id, created_at, updated_at,
          deleted_at, deleted_by, delete_reason, restored_at, restored_by
        FROM awcms_mini_news_media_objects
        WHERE tenant_id = ${tenantId} AND id = ${id} AND deleted_at IS NULL
      `
  ) as NewsMediaObjectRow[];

  return rows[0] ? toView(rows[0]) : null;
}

export type MarkNewsMediaObjectUploadedInput = {
  sizeBytes?: number;
  checksumSha256?: string;
};

/**
 * `pending_upload -> uploaded`. The `WHERE status = 'pending_upload'` guard
 * is this table's mutual-exclusion primitive: Postgres serializes concurrent
 * `UPDATE`s against the same row, so exactly one concurrent caller ever
 * transitions a given row out of `pending_upload` — every other caller's
 * `UPDATE` matches zero rows and gets `null` back. Issue #634's finalize
 * orchestration (security-auditor High finding, PR #653 review) calls this
 * with NO `input` at all as the atomic "claim" step BEFORE attempting any
 * R2 network call — this is what prevents N concurrent `finalize` requests
 * (different `Idempotency-Key`s, so the idempotency store alone cannot
 * dedupe them) from each triggering their own expensive R2 `HEAD`+`GET`
 * for the same object. `sizeBytes`/`checksumSha256` are optional precisely
 * because at claim time (before the real `GET` has happened) neither is
 * known yet — `COALESCE` leaves the column untouched (`NULL`, for a fresh
 * claim) when omitted, so a caller that already knows both values (a
 * standalone/legacy call site, or a test) can still set them here in one
 * step, same as before this change. Deliberately NOT an audited action on
 * its own: "uploaded" only means bytes exist at the object key, not that
 * they were verified as safe/matching content (`markNewsMediaObjectVerified`
 * is the audited "verify" action the epic's acceptance criteria actually
 * requires).
 */
export async function markNewsMediaObjectUploaded(
  tx: Bun.SQL,
  tenantId: string,
  id: string,
  input: MarkNewsMediaObjectUploadedInput = {}
): Promise<NewsMediaObjectView | null> {
  const rows = (await tx`
    UPDATE awcms_mini_news_media_objects
    SET status = 'uploaded',
        size_bytes = COALESCE(${input.sizeBytes ?? null}, size_bytes),
        checksum_sha256 = COALESCE(${input.checksumSha256 ?? null}, checksum_sha256),
        updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${id}
      AND status = 'pending_upload' AND deleted_at IS NULL
    RETURNING id, tenant_id, module_key, owner_resource_type, owner_resource_id,
      storage_driver, bucket_name, object_key, original_filename, public_url,
      mime_type, size_bytes, checksum_sha256, width, height, alt_text, caption,
      status, created_by_tenant_user_id, created_at, updated_at,
      deleted_at, deleted_by, delete_reason, restored_at, restored_by
  `) as NewsMediaObjectRow[];

  return rows[0] ? toView(rows[0]) : null;
}

export type MarkNewsMediaObjectVerifiedInput = {
  width?: number;
  height?: number;
  /**
   * The REAL size/checksum, computed from the bytes actually read by the
   * capped streaming `GET` (`news-media-r2-client.ts`'s `getObject`) —
   * never from a `HEAD` response, which can be stale/raced (security-auditor
   * Critical finding, PR #653 review). Optional + `COALESCE`d so a caller
   * that already set them via `markNewsMediaObjectUploaded` (the legacy/
   * standalone one-step flow) does not need to repeat them here.
   */
  sizeBytes?: number;
  checksumSha256?: string;
};

/**
 * `uploaded -> verified` — server-side MIME sniffing/checksum verification
 * (doc §9, #634's confirm step) passed. This is the "verify" audit action
 * the epic's acceptance criteria requires.
 */
export async function markNewsMediaObjectVerified(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  id: string,
  input: MarkNewsMediaObjectVerifiedInput = {},
  correlationId?: string
): Promise<NewsMediaObjectView | null> {
  const rows = (await tx`
    UPDATE awcms_mini_news_media_objects
    SET status = 'verified', width = ${input.width ?? null}, height = ${input.height ?? null},
        size_bytes = COALESCE(${input.sizeBytes ?? null}, size_bytes),
        checksum_sha256 = COALESCE(${input.checksumSha256 ?? null}, checksum_sha256),
        updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${id}
      AND status = 'uploaded' AND deleted_at IS NULL
    RETURNING id, tenant_id, module_key, owner_resource_type, owner_resource_id,
      storage_driver, bucket_name, object_key, original_filename, public_url,
      mime_type, size_bytes, checksum_sha256, width, height, alt_text, caption,
      status, created_by_tenant_user_id, created_at, updated_at,
      deleted_at, deleted_by, delete_reason, restored_at, restored_by
  `) as NewsMediaObjectRow[];

  const updated = rows[0] ? toView(rows[0]) : null;
  if (!updated) return null;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "news_media.object.verified",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: id,
    severity: "info",
    message: `News media object verified: ${updated.objectKey}.`,
    attributes: { objectKey: updated.objectKey },
    correlationId
  });

  return updated;
}

export type AttachNewsMediaObjectInput = {
  ownerResourceType: NewsMediaOwnerResourceType;
  ownerResourceId: string;
};

/**
 * `verified -> attached` — binds the media object to an owning resource.
 * Deliberately requires `status = 'verified'` (never straight from
 * `pending_upload`/`uploaded`) — this is what enforces "Keputusan kunci #4"
 * (editorial content must only ever point at verified/confirmed media,
 * never at an unverified upload) at the write path, not just by convention.
 */
export async function attachNewsMediaObject(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  id: string,
  input: AttachNewsMediaObjectInput,
  correlationId?: string
): Promise<NewsMediaObjectView | null> {
  const rows = (await tx`
    UPDATE awcms_mini_news_media_objects
    SET status = 'attached', owner_resource_type = ${input.ownerResourceType},
        owner_resource_id = ${input.ownerResourceId}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${id}
      AND status = 'verified' AND deleted_at IS NULL
    RETURNING id, tenant_id, module_key, owner_resource_type, owner_resource_id,
      storage_driver, bucket_name, object_key, original_filename, public_url,
      mime_type, size_bytes, checksum_sha256, width, height, alt_text, caption,
      status, created_by_tenant_user_id, created_at, updated_at,
      deleted_at, deleted_by, delete_reason, restored_at, restored_by
  `) as NewsMediaObjectRow[];

  const updated = rows[0] ? toView(rows[0]) : null;
  if (!updated) return null;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "news_media.object.attached",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: id,
    severity: "info",
    message: `News media object attached to ${input.ownerResourceType} ${input.ownerResourceId}.`,
    attributes: {
      objectKey: updated.objectKey,
      ownerResourceType: input.ownerResourceType,
      ownerResourceId: input.ownerResourceId
    },
    correlationId
  });

  return updated;
}

/**
 * `attached -> verified` — reverses `attachNewsMediaObject`. Returns to
 * `verified` (not `orphaned`): a detached-but-still-good media object
 * remains immediately reusable for another `attach` call.
 * `markNewsMediaObjectOrphaned` is the separate, deliberate "flag for
 * cleanup" transition (doc `r2-backup-lifecycle.md` §2's orphan detection),
 * not an automatic side effect of detach.
 */
export async function detachNewsMediaObject(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  id: string,
  correlationId?: string
): Promise<NewsMediaObjectView | null> {
  const rows = (await tx`
    UPDATE awcms_mini_news_media_objects
    SET status = 'verified', owner_resource_type = NULL, owner_resource_id = NULL,
        updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${id}
      AND status = 'attached' AND deleted_at IS NULL
    RETURNING id, tenant_id, module_key, owner_resource_type, owner_resource_id,
      storage_driver, bucket_name, object_key, original_filename, public_url,
      mime_type, size_bytes, checksum_sha256, width, height, alt_text, caption,
      status, created_by_tenant_user_id, created_at, updated_at,
      deleted_at, deleted_by, delete_reason, restored_at, restored_by
  `) as NewsMediaObjectRow[];

  const updated = rows[0] ? toView(rows[0]) : null;
  if (!updated) return null;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "news_media.object.detached",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: id,
    severity: "info",
    message: `News media object detached: ${updated.objectKey}.`,
    attributes: { objectKey: updated.objectKey },
    correlationId
  });

  return updated;
}

/**
 * `pending_upload|uploaded|verified -> orphaned` — flags a never-attached
 * object as a cleanup candidate (doc `r2-backup-lifecycle.md` §2, e.g. a
 * pending TTL job). Deliberately excluded from the required audit-event
 * list (create/verify/attach/detach/delete/restore/purge) — this is routine
 * lifecycle bookkeeping performed by an automated job, not itself a
 * high-risk action; callers may still `log()` it structurally.
 */
export async function markNewsMediaObjectOrphaned(
  tx: Bun.SQL,
  tenantId: string,
  id: string
): Promise<NewsMediaObjectView | null> {
  const rows = (await tx`
    UPDATE awcms_mini_news_media_objects
    SET status = 'orphaned', updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${id}
      AND status IN ('pending_upload', 'uploaded', 'verified') AND deleted_at IS NULL
    RETURNING id, tenant_id, module_key, owner_resource_type, owner_resource_id,
      storage_driver, bucket_name, object_key, original_filename, public_url,
      mime_type, size_bytes, checksum_sha256, width, height, alt_text, caption,
      status, created_by_tenant_user_id, created_at, updated_at,
      deleted_at, deleted_by, delete_reason, restored_at, restored_by
  `) as NewsMediaObjectRow[];

  return rows[0] ? toView(rows[0]) : null;
}

/**
 * `pending_upload|uploaded -> failed` — upload or verification failed
 * (checksum mismatch, R2 error, disallowed content sniffed, etc). Same
 * "not in the required audit list" reasoning as `markNewsMediaObjectOrphaned`.
 */
export async function markNewsMediaObjectFailed(
  tx: Bun.SQL,
  tenantId: string,
  id: string
): Promise<NewsMediaObjectView | null> {
  const rows = (await tx`
    UPDATE awcms_mini_news_media_objects
    SET status = 'failed', updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${id}
      AND status IN ('pending_upload', 'uploaded') AND deleted_at IS NULL
    RETURNING id, tenant_id, module_key, owner_resource_type, owner_resource_id,
      storage_driver, bucket_name, object_key, original_filename, public_url,
      mime_type, size_bytes, checksum_sha256, width, height, alt_text, caption,
      status, created_by_tenant_user_id, created_at, updated_at,
      deleted_at, deleted_by, delete_reason, restored_at, restored_by
  `) as NewsMediaObjectRow[];

  return rows[0] ? toView(rows[0]) : null;
}

/**
 * `uploaded -> pending_upload` — reverts the atomic claim
 * `markNewsMediaObjectUploaded` makes, ONLY for a transient/infra reason
 * (R2 provider error, circuit breaker open, timeout) rather than a
 * definitive content-rejection (that path is `markNewsMediaObjectFailed`,
 * permanent — the client must start a new upload session). Issue #634's
 * finalize orchestration (security-auditor High finding, PR #653 review)
 * claims a row BEFORE calling R2 so concurrent `finalize` calls cannot each
 * trigger their own R2 round trip; without this revert, a single transient
 * R2 failure would leave the row stuck in `uploaded` forever with no path
 * back to a retryable state.
 */
export async function revertNewsMediaObjectUploadClaim(
  tx: Bun.SQL,
  tenantId: string,
  id: string
): Promise<NewsMediaObjectView | null> {
  const rows = (await tx`
    UPDATE awcms_mini_news_media_objects
    SET status = 'pending_upload', updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${id}
      AND status = 'uploaded' AND deleted_at IS NULL
    RETURNING id, tenant_id, module_key, owner_resource_type, owner_resource_id,
      storage_driver, bucket_name, object_key, original_filename, public_url,
      mime_type, size_bytes, checksum_sha256, width, height, alt_text, caption,
      status, created_by_tenant_user_id, created_at, updated_at,
      deleted_at, deleted_by, delete_reason, restored_at, restored_by
  `) as NewsMediaObjectRow[];

  return rows[0] ? toView(rows[0]) : null;
}

/**
 * Soft delete — orthogonal to `status` (same convention as
 * `awcms_mini_blog_posts`): deleting never rewrites `status`, it only sets
 * `deleted_at`/`deleted_by`/`delete_reason`. Works from any status.
 */
export async function softDeleteNewsMediaObject(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  id: string,
  reason: string,
  correlationId?: string
): Promise<boolean> {
  const rows = (await tx`
    UPDATE awcms_mini_news_media_objects
    SET deleted_at = now(), deleted_by = ${actorTenantUserId}, delete_reason = ${reason},
        updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${id} AND deleted_at IS NULL
    RETURNING object_key
  `) as { object_key: string }[];

  if (rows.length === 0) return false;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "news_media.object.deleted",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: id,
    severity: "warning",
    message: `News media object soft deleted: ${rows[0]!.object_key}.`,
    attributes: { objectKey: rows[0]!.object_key, reason },
    correlationId
  });

  return true;
}

export async function restoreNewsMediaObject(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  id: string,
  correlationId?: string
): Promise<NewsMediaObjectView | null> {
  const rows = (await tx`
    UPDATE awcms_mini_news_media_objects
    SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL,
        restored_at = now(), restored_by = ${actorTenantUserId}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${id} AND deleted_at IS NOT NULL
    RETURNING id, tenant_id, module_key, owner_resource_type, owner_resource_id,
      storage_driver, bucket_name, object_key, original_filename, public_url,
      mime_type, size_bytes, checksum_sha256, width, height, alt_text, caption,
      status, created_by_tenant_user_id, created_at, updated_at,
      deleted_at, deleted_by, delete_reason, restored_at, restored_by
  `) as NewsMediaObjectRow[];

  const restored = rows[0] ? toView(rows[0]) : null;
  if (!restored) return null;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "news_media.object.restored",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: id,
    severity: "info",
    message: `News media object restored: ${restored.objectKey}.`,
    attributes: { objectKey: restored.objectKey },
    correlationId
  });

  return restored;
}

/**
 * Hard delete. Caller must have already verified the row is soft-deleted
 * (this only guards it at the SQL level via `deleted_at IS NOT NULL` in the
 * WHERE clause) — same "caller verifies eligibility first" convention as
 * `blog-content/application/blog-post-directory.ts`'s `purgeBlogPost`.
 */
export async function purgeNewsMediaObject(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  id: string,
  correlationId?: string
): Promise<boolean> {
  const rows = (await tx`
    DELETE FROM awcms_mini_news_media_objects
    WHERE tenant_id = ${tenantId} AND id = ${id} AND deleted_at IS NOT NULL
    RETURNING object_key
  `) as { object_key: string }[];

  if (rows.length === 0) return false;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "news_media.object.purged",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: id,
    severity: "warning",
    message: `News media object purged: ${rows[0]!.object_key}.`,
    attributes: { objectKey: rows[0]!.object_key },
    correlationId
  });

  return true;
}
