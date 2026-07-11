import { assertUuid } from "../../../lib/database/tenant-context";
import { hashPassword } from "../../../lib/auth/password";
import type { SetupInitializeInput } from "../domain/setup-validation";

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

  const tenantRows = await tx`
    INSERT INTO awcms_mini_tenants (tenant_code, tenant_name)
    VALUES (${input.tenantCode}, ${input.tenantName})
    RETURNING id
  `;
  const tenantId = assertUuid(tenantRows[0]!.id as string);

  await tx.unsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);

  await tx`
    INSERT INTO awcms_mini_tenant_settings (tenant_id) VALUES (${tenantId})
  `;

  const officeRows = await tx`
    INSERT INTO awcms_mini_offices (tenant_id, office_code, office_name, office_type)
    VALUES (${tenantId}, ${input.officeCode}, ${input.officeName}, 'head_office')
    RETURNING id
  `;
  const officeId = officeRows[0]!.id as string;

  const profileRows = await tx`
    INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
    VALUES (${tenantId}, 'person', ${input.ownerDisplayName})
    RETURNING id
  `;
  const profileId = profileRows[0]!.id as string;

  const passwordHash = await hashPassword(input.ownerPassword);
  const identityRows = await tx`
    INSERT INTO awcms_mini_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${tenantId}, ${profileId}, ${input.ownerLoginIdentifier}, ${passwordHash})
    RETURNING id
  `;
  const identityId = identityRows[0]!.id as string;

  const tenantUserRows = await tx`
    INSERT INTO awcms_mini_tenant_users (tenant_id, identity_id)
    VALUES (${tenantId}, ${identityId})
    RETURNING id
  `;
  const tenantUserId = tenantUserRows[0]!.id as string;

  const roleRows = await tx`
    INSERT INTO awcms_mini_roles (tenant_id, role_code, role_name, is_system)
    VALUES (${tenantId}, 'owner', 'Owner', true)
    RETURNING id
  `;
  const roleId = roleRows[0]!.id as string;

  await tx`
    INSERT INTO awcms_mini_role_permissions (tenant_id, role_id, permission_id)
    SELECT ${tenantId}, ${roleId}, id FROM awcms_mini_permissions
  `;

  await tx`
    INSERT INTO awcms_mini_access_assignments (tenant_id, tenant_user_id, role_id, assigned_by)
    VALUES (${tenantId}, ${tenantUserId}, ${roleId}, ${tenantUserId})
  `;

  await tx`
    UPDATE awcms_mini_setup_state SET tenant_id = ${tenantId} WHERE id = true
  `;

  return {
    outcome: "initialized",
    tenantId,
    officeId,
    ownerProfileId: profileId,
    ownerIdentityId: identityId,
    ownerTenantUserId: tenantUserId,
    ownerRoleId: roleId
  };
}
