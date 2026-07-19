import { assertUuid } from "../../../lib/database/tenant-context";
import { hashPassword } from "../../../lib/auth/password";

/**
 * Reusable tenant-onboarding composition-root helpers (Issue #872, epic #868,
 * ADR-0022). The one-time platform setup wizard
 * (`application/platform-bootstrap.ts`) and the SaaS control-plane
 * `tenant_provisioning` orchestrator (#872) BOTH create a tenant record, an
 * owner identity, a head office, and default configuration. Rather than
 * DUPLICATE that logic (issue #872: "reuse existing tenant/setup mechanisms
 * rather than duplicating tenant, owner, module, domain, or profile creation
 * logic"), the shared, behavior-preserving building blocks live here and are
 * composed by both call sites.
 *
 * These are composition-root orchestration functions that span
 * `tenant_admin`, `profile_identity`, and `identity_access` tables in one
 * transaction — deliberately NOT a static `dependencies` edge (that would
 * wrongly imply those modules cannot function without each other; see
 * `platform-bootstrap.ts`'s own header and the `module-management` skill's
 * §Dependency graph). Every caller sets `SET LOCAL app.current_tenant_id`
 * itself before invoking the owner/office/config helpers (the tenant-scoped
 * tables they write are RLS-protected).
 *
 * No secret is ever stored: the owner password is hashed with the same
 * `hashPassword` the setup wizard already uses, and nothing here persists a
 * plaintext credential (ADR-0022 §3/§6).
 */

export type CreateTenantRecordInput = {
  tenantCode: string;
  tenantName: string;
  legalName?: string | null;
  defaultLocale?: string;
  defaultTheme?: string;
  /** Setup creates an `active` platform tenant; provisioning creates an `inactive` tenant that only becomes `active` once readiness passes (ADR-0022 §6/§9). */
  status?: "active" | "inactive" | "suspended";
  createdBy?: string | null;
};

/**
 * INSERT the `awcms_mini_tenants` REGISTRY row and return the new tenant id.
 * `awcms_mini_tenants` is RLS-free (the global tenant registry), so this needs
 * no tenant context. The RLS-protected `awcms_mini_tenant_settings` row is a
 * SEPARATE call (`initializeTenantSettings`) the caller makes AFTER setting
 * `app.current_tenant_id`. The global `awcms_mini_tenants.tenant_code` unique
 * index is the ACID anti-duplicate anchor — a caller that needs
 * idempotent/concurrent-safe creation uses `createTenantRecordIfAbsent` below.
 */
/**
 * Build the tenant INSERT column set. Only columns the caller EXPLICITLY
 * provides are written; omitted `status`/`default_locale`/`default_theme` fall
 * back to their DB column defaults (e.g. migration 016 set `default_locale`'s
 * default to `en`) — the exact behavior the setup wizard relied on. Provisioning
 * passes `status: "inactive"` and an optional locale explicitly.
 */
function tenantInsertRow(
  input: CreateTenantRecordInput
): Record<string, unknown> {
  const row: Record<string, unknown> = {
    tenant_code: input.tenantCode,
    tenant_name: input.tenantName,
    legal_name: input.legalName ?? null,
    created_by: input.createdBy ?? null
  };
  if (input.status !== undefined) row.status = input.status;
  if (input.defaultLocale !== undefined)
    row.default_locale = input.defaultLocale;
  if (input.defaultTheme !== undefined) row.default_theme = input.defaultTheme;
  return row;
}

export async function createTenantRecord(
  tx: Bun.SQL,
  input: CreateTenantRecordInput
): Promise<{ tenantId: string }> {
  const row = tenantInsertRow(input);
  const tenantRows = await tx`
    INSERT INTO awcms_mini_tenants ${tx(row)} RETURNING id
  `;
  return { tenantId: assertUuid(tenantRows[0]!.id as string) };
}

/**
 * Idempotent, concurrency-safe tenant creation for provisioning: attempts the
 * INSERT with `ON CONFLICT (tenant_code) DO NOTHING`. Returns `created: true`
 * with the new id, or `created: false` with the EXISTING tenant's id when the
 * code is already taken (two concurrent provisioning requests for the same
 * target: exactly one gets `created: true`, the loser gets `created: false` —
 * a clean, deterministic outcome, never a duplicate tenant or a raw 23505).
 * `awcms_mini_tenants` is RLS-free, so this runs before any tenant context is
 * set; the caller sets `app.current_tenant_id` to the returned id and calls
 * `initializeTenantSettings` next.
 */
export async function createTenantRecordIfAbsent(
  tx: Bun.SQL,
  input: CreateTenantRecordInput
): Promise<{ tenantId: string; created: boolean }> {
  const row = tenantInsertRow({ status: "inactive", ...input });
  const inserted = await tx`
    INSERT INTO awcms_mini_tenants ${tx(row)}
    ON CONFLICT (tenant_code) DO NOTHING
    RETURNING id
  `;
  if (inserted[0]) {
    return { tenantId: assertUuid(inserted[0].id as string), created: true };
  }

  const existing = await tx`
    SELECT id FROM awcms_mini_tenants WHERE tenant_code = ${input.tenantCode}
  `;
  return {
    tenantId: assertUuid(existing[0]!.id as string),
    created: false
  };
}

/** INSERT the tenant's settings row (RLS-protected — requires `app.current_tenant_id` already set to `tenantId`). Idempotent. */
export async function initializeTenantSettings(
  tx: Bun.SQL,
  tenantId: string
): Promise<void> {
  await tx`
    INSERT INTO awcms_mini_tenant_settings (tenant_id) VALUES (${tenantId})
    ON CONFLICT (tenant_id) DO NOTHING
  `;
}

export type CreateHeadOfficeInput = {
  officeCode: string;
  officeName: string;
  createdBy?: string | null;
};

/** INSERT the tenant's head office. Requires `app.current_tenant_id` already set to `tenantId`. */
export async function createHeadOffice(
  tx: Bun.SQL,
  tenantId: string,
  input: CreateHeadOfficeInput
): Promise<{ officeId: string }> {
  const officeRows = await tx`
    INSERT INTO awcms_mini_offices (tenant_id, office_code, office_name, office_type, created_by)
    VALUES (${tenantId}, ${input.officeCode}, ${input.officeName}, 'head_office', ${input.createdBy ?? null})
    RETURNING id
  `;
  return { officeId: officeRows[0]!.id as string };
}

export type CreateTenantOwnerInput = {
  ownerDisplayName: string;
  ownerLoginIdentifier: string;
  ownerPassword: string;
  createdBy?: string | null;
};

export type CreateTenantOwnerResult = {
  ownerProfileId: string;
  ownerIdentityId: string;
  ownerTenantUserId: string;
  ownerRoleId: string;
};

/**
 * Create the owner profile + identity + tenant-user + system `owner` role
 * (granted every seeded permission for THIS tenant) + access assignment.
 * Requires `app.current_tenant_id` already set to `tenantId`. The password is
 * hashed; no plaintext credential is stored. This is the single reusable
 * owner-bootstrap the setup wizard and provisioning both compose.
 */
export async function createTenantOwner(
  tx: Bun.SQL,
  tenantId: string,
  input: CreateTenantOwnerInput
): Promise<CreateTenantOwnerResult> {
  const createdBy = input.createdBy ?? null;

  const profileRows = await tx`
    INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name, created_by)
    VALUES (${tenantId}, 'person', ${input.ownerDisplayName}, ${createdBy})
    RETURNING id
  `;
  const profileId = profileRows[0]!.id as string;

  const passwordHash = await hashPassword(input.ownerPassword);
  // NOTE: awcms_mini_identities / awcms_mini_tenant_users / awcms_mini_roles
  // have NO created_by column (unlike profiles/offices/tenants) — matches the
  // original setup wizard INSERTs exactly.
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

  return {
    ownerProfileId: profileId,
    ownerIdentityId: identityId,
    ownerTenantUserId: tenantUserId,
    ownerRoleId: roleId
  };
}

export type ApplyTenantConfigurationInput = {
  defaultLocale?: string;
  defaultTheme?: string;
  timezone?: string;
};

/**
 * Apply default configuration/locale to an existing tenant (idempotent — only
 * the provided fields are written; the rest keep their live value). Requires
 * `app.current_tenant_id` already set to `tenantId`.
 */
export async function applyTenantConfiguration(
  tx: Bun.SQL,
  tenantId: string,
  input: ApplyTenantConfigurationInput
): Promise<void> {
  await tx`
    UPDATE awcms_mini_tenants
    SET default_locale = COALESCE(${input.defaultLocale ?? null}, default_locale),
        default_theme = COALESCE(${input.defaultTheme ?? null}, default_theme),
        updated_at = now()
    WHERE id = ${tenantId}
  `;
  await tx`
    UPDATE awcms_mini_tenant_settings
    SET timezone = COALESCE(${input.timezone ?? null}, timezone),
        updated_at = now()
    WHERE tenant_id = ${tenantId}
  `;
}

/**
 * Flip a tenant from any state to `active` (readiness passed) or a non-active
 * state (blocked run). Reused by provisioning readiness. Never deletes data.
 */
export async function setTenantStatus(
  tx: Bun.SQL,
  tenantId: string,
  status: "active" | "inactive" | "suspended",
  updatedBy?: string | null
): Promise<void> {
  await tx`
    UPDATE awcms_mini_tenants
    SET status = ${status}, updated_by = ${updatedBy ?? null}, updated_at = now()
    WHERE id = ${tenantId}
  `;
}
