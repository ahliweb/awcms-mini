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
import { fetchTenantSettings } from "../../../../modules/tenant-admin/application/tenant-settings-directory";
import { validateUpdateTenantSettingsInput } from "../../../../modules/tenant-admin/domain/settings-validation";

const READ_GUARD = {
  moduleKey: "tenant_admin",
  activityCode: "tenant_settings",
  action: "read" as const
};

const UPDATE_GUARD = {
  moduleKey: "tenant_admin",
  activityCode: "tenant_settings",
  action: "update" as const
};

export const GET: APIRoute = async ({ request, cookies }) => {
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

    const settings = await fetchTenantSettings(tx, tenantId);

    if (!settings) {
      return fail(404, "RESOURCE_NOT_FOUND", "Tenant not found.");
    }

    return ok(settings);
  });
};

export const PATCH: APIRoute = async ({ request, cookies }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
  }

  const validation = validateUpdateTenantSettingsInput(
    await request.json().catch(() => null)
  );

  if (!validation.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Settings update is invalid.",
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
      UPDATE_GUARD
    );

    if (!auth.allowed) {
      return auth.denied;
    }

    // awcms_mini_tenants is intentionally RLS-free (it IS the tenant root —
    // `id` is the tenant id, there is no separate tenant_id column a policy
    // could key on), so this WHERE id = <tenantId> is the only thing scoping
    // the update to the caller's own tenant. Never drop it.
    if (
      input.tenantName !== undefined ||
      input.legalName !== undefined ||
      input.defaultLocale !== undefined ||
      input.defaultTheme !== undefined
    ) {
      const tenantRows = await tx`
        SELECT id FROM awcms_mini_tenants WHERE id = ${tenantId}
      `;

      if (!tenantRows[0]) {
        return fail(404, "RESOURCE_NOT_FOUND", "Tenant not found.");
      }

      if (input.tenantName !== undefined) {
        await tx`
          UPDATE awcms_mini_tenants
          SET tenant_name = ${input.tenantName}, updated_at = now(), updated_by = ${auth.context.tenantUserId}
          WHERE id = ${tenantId}
        `;
      }

      if (input.legalName !== undefined) {
        await tx`
          UPDATE awcms_mini_tenants
          SET legal_name = ${input.legalName}, updated_at = now(), updated_by = ${auth.context.tenantUserId}
          WHERE id = ${tenantId}
        `;
      }

      if (input.defaultLocale !== undefined) {
        await tx`
          UPDATE awcms_mini_tenants
          SET default_locale = ${input.defaultLocale}, updated_at = now(), updated_by = ${auth.context.tenantUserId}
          WHERE id = ${tenantId}
        `;
      }

      if (input.defaultTheme !== undefined) {
        await tx`
          UPDATE awcms_mini_tenants
          SET default_theme = ${input.defaultTheme}, updated_at = now(), updated_by = ${auth.context.tenantUserId}
          WHERE id = ${tenantId}
        `;
      }
    }

    if (input.timezone !== undefined) {
      await tx`
        UPDATE awcms_mini_tenant_settings
        SET timezone = ${input.timezone}, updated_at = now()
        WHERE tenant_id = ${tenantId}
      `;
    }

    if (input.featureFlags !== undefined) {
      await tx`
        UPDATE awcms_mini_tenant_settings
        SET feature_flags = ${input.featureFlags}, updated_at = now()
        WHERE tenant_id = ${tenantId}
      `;
    }

    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId: auth.context.tenantUserId,
      moduleKey: "tenant_admin",
      action: "update",
      resourceType: "tenant_settings",
      resourceId: tenantId,
      severity: "warning",
      message: "Tenant settings updated.",
      attributes: { ...input }
    });

    const settings = await fetchTenantSettings(tx, tenantId);

    return ok(settings);
  });
};
