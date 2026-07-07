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
  fetchBlogPageById,
  softDeleteBlogPage,
  updateBlogPage
} from "../../../../../modules/blog-content/application/blog-page-directory";
import {
  validateSoftDeleteBlogPageInput,
  validateUpdateBlogPageInput
} from "../../../../../modules/blog-content/domain/blog-page-validation";
import { evaluatePageUpdateAccess } from "../../../../../modules/blog-content/domain/page-access-policy";

const READ_GUARD = {
  moduleKey: "blog_content",
  activityCode: "pages",
  action: "read" as const
};

const UPDATE_ACTIVITY = { moduleKey: "blog_content", activityCode: "pages" };

const DELETE_GUARD = {
  moduleKey: "blog_content",
  activityCode: "pages",
  action: "delete" as const
};

/** `GET /api/v1/blog/pages/{id}` (Issue #539). */
export const GET: APIRoute = async ({ request, params, cookies }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  const pageId = params.id;

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  if (!pageId) {
    return fail(400, "VALIDATION_ERROR", "Page id is required.");
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

    const page = await fetchBlogPageById(tx, tenantId, pageId);

    if (!page) {
      return fail(404, "RESOURCE_NOT_FOUND", "Blog page not found.");
    }

    return ok(page);
  });
};

/**
 * `PATCH /api/v1/blog/pages/{id}` (Issue #539). Access decided by
 * `evaluatePageUpdateAccess` — same author-own-unpublished-content
 * override `PATCH /api/v1/blog/posts/{id}` uses, fixed to
 * `blog_content.pages.update` (doc issue #539: "must follow the same
 * auth, tenant, RBAC/ABAC, ... patterns introduced in the blog post
 * API").
 */
export const PATCH: APIRoute = async ({ request, params, cookies, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  const pageId = params.id;

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  if (!pageId) {
    return fail(400, "VALIDATION_ERROR", "Page id is required.");
  }

  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
  }

  const validation = validateUpdateBlogPageInput(
    await request.json().catch(() => null),
    pageId
  );

  if (!validation.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Blog page update is invalid.",
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

    const page = await fetchBlogPageById(tx, tenantId, pageId);

    if (!page) {
      return fail(404, "RESOURCE_NOT_FOUND", "Blog page not found.");
    }

    const grantedPermissionKeys = await fetchGrantedPermissionKeys(
      tx,
      tenantId,
      context.tenantUserId
    );
    const decision = evaluatePageUpdateAccess(context, grantedPermissionKeys, {
      authorTenantUserId: page.authorTenantUserId,
      status: page.status
    });

    await recordDecisionLog(
      tx,
      tenantId,
      context.tenantUserId,
      {
        ...UPDATE_ACTIVITY,
        action: "update",
        resourceType: "blog_page",
        resourceId: pageId
      },
      decision
    );

    if (!decision.allowed) {
      return fail(403, "ACCESS_DENIED", decision.reason);
    }

    if (input.parentPageId) {
      if (input.parentPageId === pageId) {
        return fail(
          400,
          "VALIDATION_ERROR",
          "A page cannot be its own parent."
        );
      }

      const parentRows = await tx`
        SELECT id FROM awcms_mini_blog_pages
        WHERE tenant_id = ${tenantId} AND id = ${input.parentPageId} AND deleted_at IS NULL
      `;

      if (parentRows.length === 0) {
        return fail(
          400,
          "VALIDATION_ERROR",
          "parentPageId does not reference an existing page."
        );
      }
    }

    let updated;

    try {
      updated = await updateBlogPage(tx, tenantId, pageId, input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (message.includes("awcms_mini_blog_pages_slug_dedup")) {
        return fail(
          409,
          "SLUG_CONFLICT",
          `A page already exists for slug "${input.slug}" in this locale.`
        );
      }

      throw error;
    }

    if (!updated) {
      return fail(404, "RESOURCE_NOT_FOUND", "Blog page not found.");
    }

    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId: context.tenantUserId,
      moduleKey: "blog_content",
      action: "blog.page.updated",
      resourceType: "blog_page",
      resourceId: pageId,
      severity: "info",
      message: `Blog page updated: ${updated.slug}.`,
      correlationId
    });

    return ok(updated);
  });
};

/** `DELETE /api/v1/blog/pages/{id}` (Issue #539) — soft-delete. `reason` required, same convention as posts. */
export const DELETE: APIRoute = async ({
  request,
  params,
  cookies,
  locals
}) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  const pageId = params.id;

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  if (!pageId) {
    return fail(400, "VALIDATION_ERROR", "Page id is required.");
  }

  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
  }

  const validation = validateSoftDeleteBlogPageInput(
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

    const deleted = await softDeleteBlogPage(
      tx,
      tenantId,
      auth.context.tenantUserId,
      pageId,
      reason
    );

    if (!deleted) {
      return fail(404, "RESOURCE_NOT_FOUND", "Blog page not found.");
    }

    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId: auth.context.tenantUserId,
      moduleKey: "blog_content",
      action: "blog.page.deleted",
      resourceType: "blog_page",
      resourceId: pageId,
      severity: "warning",
      message: "Blog page deleted.",
      attributes: { reason },
      correlationId
    });

    return ok({ id: pageId, deleted: true });
  });
};
