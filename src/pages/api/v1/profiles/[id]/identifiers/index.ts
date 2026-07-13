import type { APIRoute } from "astro";

import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../lib/database/client";
import { withTenant } from "../../../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../../../lib/auth/session-token";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../../lib/security/request-body-limit";
import {
  createIdentifier,
  DuplicateIdentifierError,
  listIdentifiers
} from "../../../../../../modules/profile-identity/application/identifier-directory";
import { fetchPartyById } from "../../../../../../modules/profile-identity/application/party-directory";
import { validateCreateIdentifierInput } from "../../../../../../modules/profile-identity/domain/identifier-lifecycle";

const READ_GUARD = {
  moduleKey: "profile_identity",
  activityCode: "identifiers",
  action: "read" as const
};

const CREATE_GUARD = {
  moduleKey: "profile_identity",
  activityCode: "identifiers",
  action: "create" as const
};

/** `GET /api/v1/profiles/{id}/identifiers` (Issue #748) — masked-value only, never the raw normalized value. */
export const GET: APIRoute = async ({ request, params, cookies }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  const profileId = params.id;

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  if (!profileId) {
    return fail(400, "VALIDATION_ERROR", "Profile id is required.");
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

    const profile = await fetchPartyById(tx, tenantId, profileId);

    if (!profile) {
      return fail(404, "RESOURCE_NOT_FOUND", "Profile not found.");
    }

    const identifiers = await listIdentifiers(tx, tenantId, profileId);

    return ok({ items: identifiers });
  });
};

/** `POST /api/v1/profiles/{id}/identifiers` (Issue #748) — add a typed identifier with provenance/validity metadata. `409 IDENTIFIER_ALREADY_EXISTS` if an active identifier of the same type+value already exists for this tenant (partial unique index, migration 003). */
export const POST: APIRoute = async ({ request, params, cookies, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  const profileId = params.id;

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  if (!profileId) {
    return fail(400, "VALIDATION_ERROR", "Profile id is required.");
  }

  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
  }

  const bodyRead = await readJsonBody(request);

  if (bodyRead.tooLarge) {
    return bodyTooLargeResponse(bodyRead.limitBytes);
  }

  const validation = validateCreateIdentifierInput(bodyRead.value);

  if (!validation.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Identifier input is invalid.",
      {},
      validation.errors
    );
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
      CREATE_GUARD
    );

    if (!auth.allowed) {
      return auth.denied;
    }

    const profile = await fetchPartyById(tx, tenantId, profileId);

    if (!profile) {
      return fail(404, "RESOURCE_NOT_FOUND", "Profile not found.");
    }

    try {
      const identifier = await createIdentifier(
        tx,
        tenantId,
        auth.context.tenantUserId,
        profileId,
        validation.value,
        correlationId
      );

      return ok(identifier);
    } catch (error) {
      if (error instanceof DuplicateIdentifierError) {
        return fail(409, "IDENTIFIER_ALREADY_EXISTS", error.message);
      }

      throw error;
    }
  });
};
