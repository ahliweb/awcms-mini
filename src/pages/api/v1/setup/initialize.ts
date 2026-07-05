import type { APIRoute } from "astro";
import { fail, ok } from "../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../lib/database/client";
import { assertUuid } from "../../../../lib/database/tenant-context";
import { hashPassword } from "../../../../lib/auth/password";
import { validateSetupInitializeInput } from "../../../../modules/tenant-admin/domain/setup-validation";

export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => null);
  const validation = validateSetupInitializeInput(body);

  if (!validation.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Setup input is invalid.",
      {},
      validation.errors
    );
  }

  const input = validation.value;
  const sql = getDatabaseClient();

  return sql.begin(async (tx) => {
    const claimed = await tx`
      INSERT INTO awcms_mini_setup_state (id, locked_at)
      VALUES (true, now())
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `;

    if (!claimed[0]) {
      return fail(403, "ACCESS_DENIED", "Setup has already been completed.");
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

    return ok({
      tenantId,
      officeId,
      ownerProfileId: profileId,
      ownerIdentityId: identityId,
      ownerTenantUserId: tenantUserId,
      ownerRoleId: roleId
    });
  });
};
