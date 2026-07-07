import type { APIRoute } from "astro";

import {
  fail,
  jsonResponse,
  ok
} from "../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../lib/database/client";
import { withTenant } from "../../../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../../../lib/auth/session-token";
import { log } from "../../../../../../lib/logging/logger";
import { recordAuditEvent } from "../../../../../../modules/logging/application/audit-log";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../../../../../modules/_shared/idempotency";
import {
  fetchBlogPostById,
  transitionBlogPostStatus
} from "../../../../../../modules/blog-content/application/blog-post-directory";
import { isValidStatusTransition } from "../../../../../../modules/blog-content/domain/post-status";
import { validateScheduleBlogPostInput } from "../../../../../../modules/blog-content/domain/blog-post-validation";

const SCHEDULE_GUARD = {
  moduleKey: "blog_content",
  activityCode: "posts",
  action: "schedule" as const
};

const IDEMPOTENCY_SCOPE = "blog_post_schedule";

/** `POST /api/v1/blog/posts/{id}/schedule` (Issue #538). Body: `{ scheduledAt: <ISO 8601 datetime, future> }`. High-risk mutation: requires `Idempotency-Key`. */
export const POST: APIRoute = async ({ request, params, cookies, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  const postId = params.id;

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  if (!postId) {
    return fail(400, "VALIDATION_ERROR", "Post id is required.");
  }

  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
  }

  const idempotencyKey = request.headers.get("idempotency-key");

  if (!idempotencyKey) {
    return fail(
      400,
      "IDEMPOTENCY_REQUIRED",
      "Idempotency-Key header is required."
    );
  }

  const validation = validateScheduleBlogPostInput(
    await request.json().catch(() => null)
  );

  if (!validation.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Schedule input is invalid.",
      {},
      validation.errors
    );
  }

  const { scheduledAt } = validation.value;
  const requestHash = computeRequestHash({
    postId,
    action: "schedule",
    scheduledAt: scheduledAt.toISOString()
  });
  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const now = new Date();
  const correlationId = locals.correlationId;

  return withTenant(sql, tenantId, async (tx) => {
    const auth = await authorizeInTransaction(
      tx,
      tenantId,
      tokenHash,
      now,
      SCHEDULE_GUARD
    );

    if (!auth.allowed) {
      return auth.denied;
    }

    const existingIdempotency = await findIdempotencyRecord(
      tx,
      tenantId,
      IDEMPOTENCY_SCOPE,
      idempotencyKey
    );

    if (existingIdempotency) {
      if (existingIdempotency.requestHash !== requestHash) {
        return fail(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency-Key was already used with a different request."
        );
      }

      return jsonResponse(existingIdempotency.responseBody, {
        status: existingIdempotency.responseStatus
      });
    }

    const post = await fetchBlogPostById(tx, tenantId, postId);

    if (!post) {
      return fail(404, "RESOURCE_NOT_FOUND", "Blog post not found.");
    }

    if (!isValidStatusTransition(post.status, "scheduled")) {
      return fail(
        409,
        "INVALID_STATUS_TRANSITION",
        `Cannot schedule a post in status "${post.status}".`
      );
    }

    const updated = await transitionBlogPostStatus(
      tx,
      tenantId,
      postId,
      "scheduled",
      { scheduledAt }
    );

    if (!updated) {
      return fail(404, "RESOURCE_NOT_FOUND", "Blog post not found.");
    }

    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId: auth.context.tenantUserId,
      moduleKey: "blog_content",
      action: "blog.post.scheduled",
      resourceType: "blog_post",
      resourceId: postId,
      severity: "info",
      message: `Blog post scheduled: ${updated.slug}.`,
      attributes: { scheduledAt: scheduledAt.toISOString() },
      correlationId
    });

    log("info", "blog-content.post.scheduled", {
      correlationId,
      tenantId,
      moduleKey: "blog_content",
      postId,
      slug: updated.slug,
      scheduledAt: scheduledAt.toISOString()
    });

    const successResponse = ok(updated);
    const successBody = await successResponse.clone().json();

    await saveIdempotencyRecord(
      tx,
      tenantId,
      IDEMPOTENCY_SCOPE,
      idempotencyKey,
      requestHash,
      200,
      successBody
    );

    return successResponse;
  });
};
