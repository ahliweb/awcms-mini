import type { APIRoute } from "astro";

import { fail, ok } from "../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../lib/database/client";
import { withTenant } from "../../../../lib/database/tenant-context";
import { hashSessionToken } from "../../../../lib/auth/session-token";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../modules/identity-access/application/access-guard";
import { recordAuditEvent } from "../../../../modules/logging/application/audit-log";
import { syncModuleDescriptors } from "../../../../modules/module-management/application/descriptor-sync";
import { listBaseModules } from "../../../../modules";
import { applicationModuleRegistry } from "../../../../modules/application-registry";
import {
  composeModuleRegistry,
  formatModuleCompositionIssue
} from "../../../../modules/module-management/domain/module-composition";

const SYNC_GUARD = {
  moduleKey: "module_management",
  activityCode: "modules",
  action: "sync" as const
};

/**
 * `POST /api/v1/modules/sync` (Issue #514) — trigger the descriptor sync
 * service (Issue #513) on demand. No `Idempotency-Key` required: the sync
 * itself is already naturally idempotent (verified live, #513) — running
 * it twice in a row is always safe and produces the same result, not a
 * duplicate side effect.
 */
export const POST: APIRoute = async ({ request, cookies, locals }) => {
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
  const correlationId = locals.correlationId;

  return withTenant(sql, tenantId, async (tx) => {
    const auth = await authorizeInTransaction(
      tx,
      tenantId,
      tokenHash,
      now,
      SYNC_GUARD
    );

    if (!auth.allowed) {
      return auth.denied;
    }

    // Issue #740 security follow-up (PR #769 security-auditor BLOCKED
    // finding): explicit pre-check, mirroring `scripts/modules-sync.ts`'s
    // own composition gate, so an invalid composed registry (e.g. an
    // application module colliding with a base module's key) fails with a
    // clean, structured response here rather than an uncaught
    // `ModuleCompositionInvalidError` propagating out of `withTenant`
    // (which would otherwise misrecord this as a database circuit-breaker
    // failure). `syncModuleDescriptors` itself ALSO refuses to write on
    // the same condition — this is deliberately redundant defense in
    // depth, not the only guard.
    const compositionResult = composeModuleRegistry({
      base: listBaseModules(),
      application: applicationModuleRegistry
    });

    if (!compositionResult.valid) {
      return fail(
        500,
        "MODULE_REGISTRY_COMPOSITION_INVALID",
        "The composed module registry failed validation — refusing to sync.",
        {},
        { issues: compositionResult.issues.map(formatModuleCompositionIssue) }
      );
    }

    const result = await syncModuleDescriptors(tx);

    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId: auth.context.tenantUserId,
      moduleKey: "module_management",
      action: "modules_synced",
      resourceType: "module_registry",
      severity: "info",
      message: `Module registry synced: ${result.created.length} created, ${result.updated.length} updated, ${result.orphaned.length} orphaned.`,
      attributes: {
        created: result.created,
        updated: result.updated,
        orphaned: result.orphaned
      },
      correlationId
    });

    return ok(result);
  });
};
