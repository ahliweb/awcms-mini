import type { APIRoute } from "astro";

import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../lib/database/client";
import { withTenant } from "../../../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../../../lib/auth/session-token";
import { recordAuditEvent } from "../../../../../../modules/logging/application/audit-log";
import {
  createAuthProvider,
  listAuthProviders
} from "../../../../../../modules/identity-access/application/auth-provider-directory";
import { validateCreateAuthProviderInput } from "../../../../../../modules/identity-access/domain/tenant-sso-policy";

const READ_GUARD = {
  moduleKey: "identity_access",
  activityCode: "sso_providers",
  action: "read" as const
};

const CREATE_GUARD = {
  moduleKey: "identity_access",
  activityCode: "sso_providers",
  action: "create" as const
};

/**
 * `GET /api/v1/identity/sso/providers` (Issue #591) — admin CRUD, protected
 * by ABAC (`identity_access.sso_providers.read`, migration 037).
 * Deliberately NOT gated by `isSsoRequired()` — an admin may configure a
 * provider ahead of enabling the deployment-level #587/`AUTH_SSO_ENABLED`
 * gate, same "credentials can be provisioned ahead of time" allowance
 * Issue #588/#590's own `checkTurnstileConfig`/`checkGoogleOidcConfig`
 * already grant. No network/provider call happens in this file — pure CRUD
 * over `awcms_mini_auth_providers`.
 */
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

    const providers = await listAuthProviders(tx, tenantId);

    return ok({ providers });
  });
};

/** `POST /api/v1/identity/sso/providers` (Issue #591) — creates a tenant OIDC SSO provider. High-risk admin action: audited. Not idempotency-gated (a retry duplicating a create is caught by the `(tenant_id, provider_key)` partial unique index and reported as `409 SSO_PROVIDER_KEY_CONFLICT`, same convention as `POST /api/v1/blog/pages`). */
export const POST: APIRoute = async ({ request, cookies, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
  }

  const validation = validateCreateAuthProviderInput(
    await request.json().catch(() => null)
  );

  if (!validation.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "SSO provider input is invalid.",
      {},
      validation.errors
    );
  }

  const input = validation.value;
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
      CREATE_GUARD
    );

    if (!auth.allowed) {
      return auth.denied;
    }

    const result = await createAuthProvider(
      tx,
      tenantId,
      auth.context.tenantUserId,
      input
    );

    if (result.outcome === "duplicate_key") {
      return fail(
        409,
        "SSO_PROVIDER_KEY_CONFLICT",
        `A provider already exists for providerKey "${input.providerKey}".`
      );
    }

    if (result.outcome === "limit_exceeded") {
      return fail(
        409,
        "SSO_PROVIDER_LIMIT_EXCEEDED",
        `This tenant already has the maximum of ${result.limit} configured SSO providers.`
      );
    }

    if (result.outcome === "misconfigured") {
      return fail(
        500,
        "SSO_MISCONFIGURED",
        "AUTH_SSO_CREDENTIAL_ENCRYPTION_KEY is not configured on this server."
      );
    }

    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId: auth.context.tenantUserId,
      moduleKey: "identity_access",
      action: "sso_provider_created",
      resourceType: "auth_provider",
      resourceId: result.provider.id,
      severity: "warning",
      message: `Tenant OIDC SSO provider created: ${result.provider.providerKey}.`,
      correlationId
    });

    return ok(result.provider);
  });
};
