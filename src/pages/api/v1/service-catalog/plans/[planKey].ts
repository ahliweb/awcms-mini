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
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../lib/security/request-body-limit";
import { listModules } from "../../../../../modules";
import { resolveServiceCatalogKeyRegistry } from "../../../../../modules/service-catalog/domain/key-registry";
import {
  fetchPlanDetail,
  updatePlanDraft
} from "../../../../../modules/service-catalog/application/plan-directory";
import { parseUpdateDraftBody } from "../../../../../modules/service-catalog/application/request-parsing";

const READ_GUARD = {
  moduleKey: "service_catalog",
  activityCode: "plans",
  action: "read" as const
};

const UPDATE_GUARD = {
  moduleKey: "service_catalog",
  activityCode: "plans",
  action: "update" as const
};

/** `GET /api/v1/service-catalog/plans/{planKey}` (Issue #870) — full operator detail incl. version history. */
export const GET: APIRoute = async ({ request, cookies, params }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const planKey = params.planKey ?? "";
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
    if (!auth.allowed) return auth.denied;

    const plan = await fetchPlanDetail(tx, planKey);
    if (!plan) {
      return fail(404, "RESOURCE_NOT_FOUND", "Plan not found.");
    }
    return ok({ plan });
  });
};

/**
 * `PATCH /api/v1/service-catalog/plans/{planKey}` (Issue #870) — edit the
 * plan's metadata and/or its single DRAFT version's content. Absent fields are
 * kept; provided child collections replace. A published version is immutable,
 * so this only ever touches the draft (returns 409 if there is no draft).
 */
export const PATCH: APIRoute = async ({ request, cookies, params, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const planKey = params.planKey ?? "";
  const bodyRead = await readJsonBody<Record<string, unknown>>(
    request,
    "large"
  );
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
  const input = parseUpdateDraftBody(bodyRead.value ?? {});

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
      UPDATE_GUARD
    );
    if (!auth.allowed) return auth.denied;

    const registry = resolveServiceCatalogKeyRegistry(listModules());
    const result = await updatePlanDraft(
      tx,
      tenantId,
      auth.context.tenantUserId,
      planKey,
      input,
      registry,
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "not_found") {
        return fail(404, "RESOURCE_NOT_FOUND", "Plan not found.");
      }
      if (result.reason === "no_draft_version") {
        return fail(
          409,
          "VALIDATION_ERROR",
          "This plan has no draft version to edit. Create a new draft version first (a published version is immutable)."
        );
      }
      return fail(
        400,
        "VALIDATION_ERROR",
        result.errors.map((e) => `${e.field}: ${e.message}`).join("; ")
      );
    }

    return ok({ plan: result.plan });
  });
};
