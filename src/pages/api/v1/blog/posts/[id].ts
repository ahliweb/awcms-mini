import type { APIRoute } from "astro";

import { fail, ok } from "../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../lib/database/client";
import { withTenant } from "../../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../../lib/auth/session-token";
import {
  fetchGrantedPermissionKeys,
  resolveModuleEnabled,
  resolveTenantContext
} from "../../../../../modules/identity-access/application/auth-context";
import { recordDecisionLog } from "../../../../../modules/identity-access/application/decision-log";
import { recordAuditEvent } from "../../../../../modules/logging/application/audit-log";
import {
  fetchBlogPostById,
  softDeleteBlogPost,
  updateBlogPost
} from "../../../../../modules/blog-content/application/blog-post-directory";
import {
  validateSoftDeleteBlogPostInput,
  validateUpdateBlogPostInput
} from "../../../../../modules/blog-content/domain/blog-post-validation";
import { evaluatePostUpdateAccess } from "../../../../../modules/blog-content/domain/post-access-policy";

const READ_GUARD = {
  moduleKey: "blog_content",
  activityCode: "posts",
  action: "read" as const
};

const UPDATE_ACTIVITY = { moduleKey: "blog_content", activityCode: "posts" };

const DELETE_GUARD = {
  moduleKey: "blog_content",
  activityCode: "posts",
  action: "delete" as const
};

/** `GET /api/v1/blog/posts/{id}` (Issue #538). */
export const GET: APIRoute = async ({ request, params, cookies }) => {
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

  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const now = new Date();

  return withTenant(sql, tenantId, async (tx) => {
    const auth = await authorizeInTransaction(
      tx,
      tenantId,
      tokenHash,
      now,
      READ_GUARD
    );

    if (!auth.allowed) {
      return auth.denied;
    }

    const post = await fetchBlogPostById(tx, tenantId, postId);

    if (!post) {
      return fail(404, "RESOURCE_NOT_FOUND", "Blog post not found.");
    }

    return ok(post);
  });
};

/**
 * `PATCH /api/v1/blog/posts/{id}` (Issue #538). Access is decided by
 * `evaluatePostUpdateAccess` (doc issue #538 §ABAC Rules: an author may
 * update their own not-yet-published post even without the
 * `blog_content.posts.update` role permission; a role that holds it may
 * update any tenant post) — the post is fetched *before* the decision so
 * `authorTenantUserId`/`status` are real values, same pattern
 * `workflows/tasks/{id}/decisions.ts` uses for its self-approval check.
 * Not idempotent (recommended, not required, per doc issue #538
 * §Idempotency Requirements) — same-body PATCH retries converge to the
 * same end state.
 */
export const PATCH: APIRoute = async ({ request, params, cookies, locals }) => {
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

  const validation = validateUpdateBlogPostInput(
    await request.json().catch(() => null)
  );

  if (!validation.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Blog post update is invalid.",
      {},
      validation.errors
    );
  }

  const input = validation.value;
  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const now = new Date();
  const correlationId = locals.correlationId;

  return withTenant(sql, tenantId, async (tx) => {
    const context = await resolveTenantContext(tx, tenantId, tokenHash, now);

    if (!context) {
      return fail(401, "AUTH_REQUIRED", "Session is invalid or expired.");
    }

    const moduleEnabled = await resolveModuleEnabled(
      tx,
      tenantId,
      "blog_content"
    );

    if (!moduleEnabled) {
      return fail(
        403,
        "MODULE_DISABLED",
        "Module is disabled for this tenant."
      );
    }

    const post = await fetchBlogPostById(tx, tenantId, postId);

    if (!post) {
      return fail(404, "RESOURCE_NOT_FOUND", "Blog post not found.");
    }

    const grantedPermissionKeys = await fetchGrantedPermissionKeys(
      tx,
      tenantId,
      context.tenantUserId
    );
    const decision = evaluatePostUpdateAccess(context, grantedPermissionKeys, {
      authorTenantUserId: post.authorTenantUserId,
      status: post.status
    });

    await recordDecisionLog(
      tx,
      tenantId,
      context.tenantUserId,
      {
        ...UPDATE_ACTIVITY,
        action: "update",
        resourceType: "blog_post",
        resourceId: postId
      },
      decision
    );

    if (!decision.allowed) {
      return fail(403, "ACCESS_DENIED", decision.reason);
    }

    let updated;

    try {
      updated = await updateBlogPost(tx, tenantId, postId, input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (message.includes("awcms_mini_blog_posts_slug_dedup")) {
        return fail(
          409,
          "SLUG_CONFLICT",
          `A post already exists for slug "${input.slug}" in this locale.`
        );
      }

      throw error;
    }

    if (!updated) {
      return fail(404, "RESOURCE_NOT_FOUND", "Blog post not found.");
    }

    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId: context.tenantUserId,
      moduleKey: "blog_content",
      action: "blog.post.updated",
      resourceType: "blog_post",
      resourceId: postId,
      severity: "info",
      message: `Blog post updated: ${updated.slug}.`,
      correlationId
    });

    return ok(updated);
  });
};

/** `DELETE /api/v1/blog/posts/{id}` (Issue #538) — soft-delete. `reason` required, same convention as `DELETE /api/v1/profiles/{id}` and `DELETE /api/v1/email/templates/{id}`. */
export const DELETE: APIRoute = async ({
  request,
  params,
  cookies,
  locals
}) => {
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

  const validation = validateSoftDeleteBlogPostInput(
    await request.json().catch(() => null)
  );

  if (!validation.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "reason is required.",
      {},
      validation.errors
    );
  }

  const { reason } = validation.value;
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
      DELETE_GUARD
    );

    if (!auth.allowed) {
      return auth.denied;
    }

    const deleted = await softDeleteBlogPost(
      tx,
      tenantId,
      auth.context.tenantUserId,
      postId,
      reason
    );

    if (!deleted) {
      return fail(404, "RESOURCE_NOT_FOUND", "Blog post not found.");
    }

    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId: auth.context.tenantUserId,
      moduleKey: "blog_content",
      action: "blog.post.deleted",
      resourceType: "blog_post",
      resourceId: postId,
      severity: "warning",
      message: "Blog post deleted.",
      attributes: { reason },
      correlationId
    });

    return ok({ id: postId, deleted: true });
  });
};
