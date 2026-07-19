import type { APIRoute } from "astro";

import { fail, ok } from "../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../lib/database/client";
import { withTenant } from "../../../../../lib/database/tenant-context";
import { hashSessionToken } from "../../../../../lib/auth/session-token";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../lib/security/request-body-limit";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../modules/identity-access/application/access-guard";
import { fetchGrantedPermissionKeys } from "../../../../../modules/identity-access/application/auth-context";
import { recordAuditEvent } from "../../../../../modules/logging/application/audit-log";
import { validateAbacSimulationInput } from "../../../../../modules/identity-access/domain/abac-policy";
import {
  evaluateAccess,
  type AccessRequest,
  type TenantContext
} from "../../../../../modules/identity-access/domain/access-control";
import {
  AbacEvaluationError,
  buildAttributeBag,
  evaluateCondition,
  isPolicyApplicable
} from "../../../../../modules/identity-access/domain/abac-evaluator";
import { loadActivePolicies } from "../../../../../modules/identity-access/application/policy-cache";

const ANALYZE_GUARD = {
  moduleKey: "identity_access",
  activityCode: "abac_policies",
  action: "analyze" as const
};

// A clearly-synthetic subject id used when the caller simulates by role only.
const SIMULATED_SUBJECT_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Read-only ABAC decision simulation/preview (Issue #179). Given a HYPOTHETICAL
 * subject (roles and/or an existing tenant user id), a hypothetical request,
 * and a hypothetical environment, it returns exactly what `evaluateAccess`
 * would decide against the tenant's CURRENT active policies — plus a per-policy
 * applicability/condition trace. It NEVER mutates domain data (no decision-log
 * row is written; the outcome is hypothetical) and never returns the resolved
 * attribute VALUES, only structural booleans — so no subject/resource PII
 * leaks. The simulation request itself IS audited.
 */
export const POST: APIRoute = async ({ request, cookies }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }
  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
  }

  const bodyRead = await readJsonBody<Record<string, unknown>>(request);
  if (bodyRead.tooLarge) {
    return bodyTooLargeResponse(bodyRead.limitBytes);
  }

  const validation = validateAbacSimulationInput(bodyRead.value);
  if (!validation.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Simulation input is invalid.",
      {},
      validation.errors
    );
  }
  const input = validation.value;

  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const now = new Date();

  return withTenant(sql, tenantId, async (tx) => {
    const auth = await authorizeInTransaction(
      tx,
      tenantId,
      tokenHash,
      now,
      ANALYZE_GUARD
    );
    if (!auth.allowed) {
      return auth.denied;
    }

    // Resolve the hypothetical subject's granted permission keys + role codes.
    let grantedPermissionKeys = new Set<string>();
    let roles: string[] = input.subject.roles;

    if (input.subject.roles.length > 0) {
      const rows = (await tx`
        SELECT DISTINCT p.module_key, p.activity_code, p.action
        FROM awcms_mini_roles r
        JOIN awcms_mini_role_permissions rp
          ON rp.role_id = r.id AND rp.tenant_id = r.tenant_id
        JOIN awcms_mini_permissions p ON p.id = rp.permission_id
        WHERE r.tenant_id = ${tenantId}
          AND r.role_code = ANY(${tx.array(input.subject.roles, "text")})
          AND r.deleted_at IS NULL
      `) as { module_key: string; activity_code: string; action: string }[];
      grantedPermissionKeys = new Set(
        rows.map(
          (row) => `${row.module_key}.${row.activity_code}.${row.action}`
        )
      );
    } else if (input.subject.tenantUserId) {
      grantedPermissionKeys = await fetchGrantedPermissionKeys(
        tx,
        tenantId,
        input.subject.tenantUserId
      );
      const roleRows = (await tx`
        SELECT r.role_code
        FROM awcms_mini_access_assignments aa
        JOIN awcms_mini_roles r ON r.id = aa.role_id
        WHERE aa.tenant_id = ${tenantId}
          AND aa.tenant_user_id = ${input.subject.tenantUserId}
          AND r.deleted_at IS NULL
      `) as { role_code: string }[];
      roles = roleRows.map((row) => row.role_code);
    }

    const context: TenantContext = {
      tenantId,
      tenantUserId: input.subject.tenantUserId ?? SIMULATED_SUBJECT_ID,
      identityId: SIMULATED_SUBJECT_ID,
      roles
    };

    const accessRequest: AccessRequest = {
      moduleKey: input.request.moduleKey,
      activityCode: input.request.activityCode,
      action: input.request.action as AccessRequest["action"],
      resourceType: input.request.resourceType ?? undefined,
      resourceAttributes: input.request.resourceAttributes
    };

    const env = {
      now: input.environment.now ? new Date(input.environment.now) : now,
      ipTrusted: input.environment.ipTrusted
    };

    const policies = await loadActivePolicies(tx, tenantId);

    const decision = evaluateAccess(
      context,
      accessRequest,
      grantedPermissionKeys,
      undefined,
      { policies, env }
    );

    // Per-policy trace. Only structural booleans are returned — never the
    // resolved attribute values — so the preview leaks no subject/resource PII.
    const bag = buildAttributeBag(context, accessRequest, env);
    const evaluatedPolicies = policies.map((policy) => {
      const applicable = isPolicyApplicable(
        policy.applicability,
        accessRequest
      );
      let conditionSatisfied: boolean | null = null;
      let invalid = false;
      if (applicable) {
        if (policy.condition === null) {
          invalid = true;
        } else {
          try {
            conditionSatisfied = evaluateCondition(policy.condition, bag);
          } catch (error) {
            if (error instanceof AbacEvaluationError) {
              invalid = true;
            } else {
              throw error;
            }
          }
        }
      }
      return {
        policyCode: policy.policyCode,
        effect: policy.effect,
        dslVersion: policy.dslVersion,
        priority: policy.priority,
        applicable,
        conditionSatisfied,
        invalid
      };
    });

    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId: auth.context.tenantUserId,
      moduleKey: "identity_access",
      action: "analyze",
      resourceType: "abac_simulation",
      severity: "info",
      message: "ABAC decision simulated.",
      attributes: {
        requestModuleKey: input.request.moduleKey,
        requestActivityCode: input.request.activityCode,
        requestAction: input.request.action,
        requestResourceType: input.request.resourceType,
        simulatedRoles: roles,
        decision: decision.allowed ? "allow" : "deny",
        matchedPolicy: decision.matchedPolicy
      }
    });

    return ok({
      decision: {
        allowed: decision.allowed,
        reason: decision.reason,
        matchedPolicy: decision.matchedPolicy,
        matchedPolicyVersion: decision.matchedPolicyVersion
      },
      evaluatedPolicies,
      subject: { tenantUserId: context.tenantUserId, roles }
    });
  });
};
