import type { APIRoute } from "astro";

import {
  fail,
  jsonResponse,
  ok
} from "../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../lib/database/client";
import { withTenant } from "../../../../../../lib/database/tenant-context";
import { hashSessionToken } from "../../../../../../lib/auth/session-token";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../../modules/identity-access/application/access-guard";
import { resolveModuleEnabled } from "../../../../../../modules/identity-access/application/auth-context";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../../../../../modules/_shared/idempotency";
import { defaultBusinessScopeHierarchyPortAdapter } from "../../../../../../modules/identity-access/application/business-scope-hierarchy-port-adapter";
import { organizationStructureHierarchyPortAdapter } from "../../../../../../modules/organization-structure/application/organization-structure-hierarchy-port-adapter";
import type { BusinessScopeHierarchyPort } from "../../../../../../modules/_shared/ports/business-scope-hierarchy-port";
import {
  createBusinessScopeAssignment,
  listBusinessScopeAssignments
} from "../../../../../../modules/identity-access/application/business-scope-assignment-service";
import { collectSoDRuleDescriptors } from "../../../../../../modules/identity-access/domain/sod-rule-registry";
import { listModules } from "../../../../../../modules";

const IDEMPOTENCY_SCOPE = "identity_access_business_scope_assignment_create";
const SOD_RULES = collectSoDRuleDescriptors(listModules());
const ORGANIZATION_STRUCTURE_MODULE_KEY = "organization_structure";

/**
 * The REAL `BusinessScopeHierarchyPort` composition (Issue #786, follow-up
 * to #746/#749 — the reviewer's non-blocking note on PR #779 that
 * `organizationStructureHierarchyPortAdapter` had zero production callers).
 * This route is the sole composition root for `createBusinessScopeAssignment`
 * today (`identity_access`'s own `application`/`domain` tree never imports
 * `organization_structure` — that would be a Core-depends-on-Optional
 * violation, ADR-0013 §1 — and is exactly what
 * `tests/unit/module-boundary-cycles.test.ts` structurally forbids).
 *
 * `organizationStructureEnabled` is resolved PER TENANT
 * (`resolveModuleEnabled`, the same tenant-module-enablement signal
 * `authorizeInTransaction` already enforces for every guarded endpoint,
 * Issue #515) — when `organization_structure` is disabled for this tenant,
 * `legal_entity`/`organization_unit` scope references are treated exactly
 * like any other scope type this module doesn't own: `resolved: false`,
 * default-deny, never a stale read of leftover rows from a module the
 * tenant has turned off. When enabled, the real adapter is tried FIRST;
 * since it already returns `resolved: false` for any scope type it doesn't
 * own (`"office"` included), falling through to identity-access's own flat
 * adapter is always safe — neither adapter needs to know the other exists.
 */
function buildHierarchyPort(
  organizationStructureEnabled: boolean
): BusinessScopeHierarchyPort {
  return {
    async resolveScope(tx, tenantId, scopeType, scopeId) {
      if (organizationStructureEnabled) {
        const organizationResolution =
          await organizationStructureHierarchyPortAdapter.resolveScope(
            tx,
            tenantId,
            scopeType,
            scopeId
          );
        if (organizationResolution.resolved) {
          return organizationResolution;
        }
      }

      return defaultBusinessScopeHierarchyPortAdapter.resolveScope(
        tx,
        tenantId,
        scopeType,
        scopeId
      );
    }
  };
}

/** `GET /api/v1/identity/business-scope/assignments` (Issue #746) — list this tenant's business-scope assignments, optionally filtered by `status`/`tenantUserId`/`scopeType`. */
export const GET: APIRoute = async ({ request, cookies, url }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }
  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
  }

  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const now = new Date();
  const statusParam = url.searchParams.get("status");
  const tenantUserIdParam = url.searchParams.get("tenantUserId");
  const scopeTypeParam = url.searchParams.get("scopeType");

  if (
    statusParam &&
    statusParam !== "active" &&
    statusParam !== "expired" &&
    statusParam !== "revoked"
  ) {
    return fail(
      400,
      "VALIDATION_ERROR",
      'status must be "active", "expired", or "revoked".'
    );
  }

  return withTenant(sql, tenantId, async (tx) => {
    const auth = await authorizeInTransaction(tx, tenantId, tokenHash, now, {
      moduleKey: "identity_access",
      activityCode: "business_scope_assignments",
      action: "read"
    });

    if (!auth.allowed) {
      return auth.denied;
    }

    const assignments = await listBusinessScopeAssignments(tx, tenantId, {
      status: statusParam as "active" | "expired" | "revoked" | undefined,
      tenantUserId: tenantUserIdParam ?? undefined,
      scopeType: scopeTypeParam ?? undefined
    });

    return ok({ assignments });
  });
};

type CreateAssignmentBody = {
  tenantUserId?: unknown;
  roleId?: unknown;
  scopeType?: unknown;
  scopeId?: unknown;
  effectiveFrom?: unknown;
  effectiveTo?: unknown;
  isTemporary?: unknown;
  reason?: unknown;
};

/** `POST /api/v1/identity/business-scope/assignments` (Issue #746) — create a business-scope assignment. Permission-gated (`identity_access.business_scope_assignments.create`), scope validated through `BusinessScopeHierarchyPort`, self-grant denied, SoD conflicts evaluated. */
export const POST: APIRoute = async ({ request, cookies, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
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

  let body: CreateAssignmentBody;
  try {
    body = (await request.json()) as CreateAssignmentBody;
  } catch {
    return fail(400, "VALIDATION_ERROR", "Request body must be valid JSON.");
  }

  const tenantUserId =
    typeof body.tenantUserId === "string" ? body.tenantUserId : "";
  const roleId = typeof body.roleId === "string" ? body.roleId : null;
  const scopeType = typeof body.scopeType === "string" ? body.scopeType : "";
  const scopeId = typeof body.scopeId === "string" ? body.scopeId : "";
  const effectiveFrom =
    typeof body.effectiveFrom === "string" && body.effectiveFrom.length > 0
      ? new Date(body.effectiveFrom)
      : new Date();
  const effectiveTo =
    typeof body.effectiveTo === "string" && body.effectiveTo.length > 0
      ? new Date(body.effectiveTo)
      : null;
  const isTemporary = body.isTemporary === true;
  const reason = typeof body.reason === "string" ? body.reason : null;

  if (!tenantUserId) {
    return fail(400, "VALIDATION_ERROR", "tenantUserId is required.");
  }

  const requestHash = computeRequestHash(body);
  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const now = new Date();
  const correlationId = locals.correlationId;

  return withTenant(sql, tenantId, async (tx) => {
    const auth = await authorizeInTransaction(tx, tenantId, tokenHash, now, {
      moduleKey: "identity_access",
      activityCode: "business_scope_assignments",
      action: "create"
    });

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

    const organizationStructureEnabled = await resolveModuleEnabled(
      tx,
      tenantId,
      ORGANIZATION_STRUCTURE_MODULE_KEY
    );

    const result = await createBusinessScopeAssignment(
      tx,
      tenantId,
      auth.context.tenantUserId,
      {
        tenantUserId,
        roleId,
        scopeType,
        scopeId,
        effectiveFrom,
        effectiveTo,
        isTemporary,
        reason
      },
      {
        hierarchyPort: buildHierarchyPort(organizationStructureEnabled),
        sodRules: SOD_RULES
      },
      now,
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "validation") {
        return fail(
          400,
          "VALIDATION_ERROR",
          result.errors
            .map((error) => `${error.field}: ${error.message}`)
            .join("; ")
        );
      }
      if (result.reason === "tenant_user_not_found") {
        return fail(404, "NOT_FOUND", "Tenant user not found.");
      }
      if (result.reason === "role_not_found") {
        return fail(404, "NOT_FOUND", "Role not found.");
      }
      if (result.reason === "scope_unresolved") {
        return fail(
          400,
          "SCOPE_UNRESOLVED",
          "The requested scopeType/scopeId could not be resolved for this tenant."
        );
      }
      if (result.reason === "self_grant_denied") {
        return fail(
          403,
          "SELF_GRANT_DENIED",
          "Granting a business-scope assignment to yourself is not allowed."
        );
      }
      return fail(
        409,
        "SOD_CONFLICT",
        `Segregation-of-duties conflict detected: ${result.conflicts
          .map((conflict) => conflict.ruleKey)
          .join(", ")}`
      );
    }

    const successResponse = ok({ assignment: result.assignment });
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
