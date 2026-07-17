import type { APIRoute } from "astro";

import { fail, ok } from "../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../lib/database/client";
import { withTenant } from "../../../../lib/database/tenant-context";
import { invalidatePublicTenantHost } from "../../../../lib/tenant/public-tenant-cache";
import { hashSessionToken } from "../../../../lib/auth/session-token";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../lib/security/request-body-limit";
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

  const bodyRead = await readJsonBody(request);

  if (bodyRead.tooLarge) {
    return bodyTooLargeResponse(bodyRead.limitBytes);
  }

  const validation = validateUpdateTenantSettingsInput(bodyRead.value);

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

  // `tenant_name` and `default_locale` are part of the value the PUBLIC
  // host->tenant cache stores (`public-host-tenant-resolver.ts` selects
  // `tenant_status, tenant_code, tenant_name, default_locale`), so editing
  // them here has a cache consequence even though this module never touches
  // `tenant_domains`. The cache's own note calls the resolution "a pure
  // function of host" — true of the KEY, not of the VALUE: the value is a
  // join across a table this module owns. Without this eviction, renaming a
  // tenant or changing its default locale leaves the public pages and RSS
  // feed serving the old values for up to the TTL, where before the cache
  // existed they were correct on the very next request. (PR #847 review.)
  //
  // Hostnames are captured INSIDE the transaction and evicted only AFTER it
  // commits — evicting from inside would let a concurrent public request
  // re-populate the cache with the still-uncommitted old value, which is the
  // race `tenant-domain-directory.ts`'s binding note documents. Returned from
  // the callback rather than assigned to an outer `let`: TypeScript narrows a
  // `let x: string[] = []` that is only written inside a closure down to
  // `never`, which silently disables type checking on the eviction argument.
  const cacheAffectingFieldChanged =
    input.tenantName !== undefined || input.defaultLocale !== undefined;

  const { response, hostsToEvict } = await withTenant(
    sql,
    tenantId,
    async (tx): Promise<{ response: Response; hostsToEvict: string[] }> => {
      const auth = await authorizeInTransaction(
        tx,
        tenantId,
        tokenHash,
        now,
        UPDATE_GUARD
      );

      if (!auth.allowed) {
        return { response: auth.denied, hostsToEvict: [] };
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
          return {
            response: fail(404, "RESOURCE_NOT_FOUND", "Tenant not found."),
            hostsToEvict: []
          };
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

      // Read INSIDE the transaction; evict AFTER it commits (below).
      const hostRows = cacheAffectingFieldChanged
        ? ((await tx`
          SELECT normalized_hostname
          FROM awcms_mini_tenant_domains
          WHERE tenant_id = ${tenantId}
        `) as { normalized_hostname: string }[])
        : [];

      return {
        response: ok(settings),
        hostsToEvict: hostRows.map((row) => row.normalized_hostname)
      };
    }
  );

  for (const host of hostsToEvict) {
    invalidatePublicTenantHost(host);
  }

  return response;
};
