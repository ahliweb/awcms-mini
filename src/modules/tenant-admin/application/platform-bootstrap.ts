import type { SetupInitializeInput } from "../domain/setup-validation";
import {
  createHeadOffice,
  createTenantOwner,
  createTenantRecord,
  initializeTenantSettings
} from "./tenant-onboarding";

/**
 * Composition root for the one-time platform setup wizard (Issue #680,
 * epic #679). This is the ONLY place in the codebase that creates a
 * tenant, office, owner profile, identity, tenant-user, role, and access
 * assignment together in one transaction — spanning `tenant_admin`,
 * `profile_identity`, and `identity_access`'s tables in a single call.
 *
 * Deliberately NOT expressed as a static `dependencies` edge between
 * those three modules (that would wrongly imply, e.g., `tenant_admin`
 * cannot function at all unless `profile_identity`/`identity_access` are
 * enabled — previously true in this registry and the exact cause of the
 * live 3-node cycle Issue #680 removed). This is a one-time, call-time
 * orchestration concern: kept here as an explicit composition-root
 * function that the route handler (`src/pages/api/v1/setup/initialize.ts`)
 * calls directly, never as a module-graph dependency. See
 * `.claude/skills/awcms-mini-module-management/SKILL.md`'s §Dependency
 * graph section for the full reasoning.
 *
 * Extracted verbatim from the route handler — same SQL, same order, same
 * transaction, same idempotency lock (`awcms_mini_setup_state`'s
 * `ON CONFLICT (id) DO NOTHING` claim). Only the HTTP response mapping
 * moved to the route handler, which now only maps this function's typed
 * result to `ok(...)`/`fail(...)`.
 */
export type PlatformBootstrapResult =
  | { outcome: "already_initialized" }
  | {
      outcome: "initialized";
      tenantId: string;
      officeId: string;
      ownerProfileId: string;
      ownerIdentityId: string;
      ownerTenantUserId: string;
      ownerRoleId: string;
    };

export async function bootstrapPlatformTenant(
  tx: Bun.SQL,
  input: SetupInitializeInput
): Promise<PlatformBootstrapResult> {
  const claimed = await tx`
    INSERT INTO awcms_mini_setup_state (id, locked_at)
    VALUES (true, now())
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `;

  if (!claimed[0]) {
    return { outcome: "already_initialized" };
  }

  // Reuses the shared tenant-onboarding building blocks (Issue #872) — the
  // exact same tenant/settings/office/owner creation, in the same order, in the
  // same transaction. The SaaS `tenant_provisioning` orchestrator composes the
  // same helpers, so there is one implementation of "create a tenant + owner",
  // not two (issue #872: reuse, do not duplicate).
  const { tenantId } = await createTenantRecord(tx, {
    tenantCode: input.tenantCode,
    tenantName: input.tenantName
  });

  await tx.unsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);

  await initializeTenantSettings(tx, tenantId);

  const { officeId } = await createHeadOffice(tx, tenantId, {
    officeCode: input.officeCode,
    officeName: input.officeName
  });

  const owner = await createTenantOwner(tx, tenantId, {
    ownerDisplayName: input.ownerDisplayName,
    ownerLoginIdentifier: input.ownerLoginIdentifier,
    ownerPassword: input.ownerPassword
  });

  await tx`
    UPDATE awcms_mini_setup_state SET tenant_id = ${tenantId} WHERE id = true
  `;

  return {
    outcome: "initialized",
    tenantId,
    officeId,
    ownerProfileId: owner.ownerProfileId,
    ownerIdentityId: owner.ownerIdentityId,
    ownerTenantUserId: owner.ownerTenantUserId,
    ownerRoleId: owner.ownerRoleId
  };
}
