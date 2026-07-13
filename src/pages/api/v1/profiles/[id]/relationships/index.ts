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
  createRelationship,
  listRelationshipsForProfile,
  RelationshipTargetNotFoundError
} from "../../../../../../modules/profile-identity/application/relationship-directory";
import { fetchPartyById } from "../../../../../../modules/profile-identity/application/party-directory";
import { validateCreateRelationshipInput } from "../../../../../../modules/profile-identity/domain/relationship";

const READ_GUARD = {
  moduleKey: "profile_identity",
  activityCode: "relationships",
  action: "read" as const
};

const CREATE_GUARD = {
  moduleKey: "profile_identity",
  activityCode: "relationships",
  action: "create" as const
};

/** `GET /api/v1/profiles/{id}/relationships` (Issue #748) — every relationship where this profile is either side. */
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

    const relationships = await listRelationshipsForProfile(
      tx,
      tenantId,
      profileId
    );

    return ok({ items: relationships });
  });
};

/** `POST /api/v1/profiles/{id}/relationships` (Issue #748) — generic party-to-party relationship (`relationshipType` free text, no hardcoded business roles) or authorized-representative record (`isAuthorizedRepresentative: true`). */
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

  const validation = validateCreateRelationshipInput(bodyRead.value, profileId);

  if (!validation.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Relationship input is invalid.",
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
      const relationship = await createRelationship(
        tx,
        tenantId,
        auth.context.tenantUserId,
        profileId,
        validation.value,
        correlationId
      );

      return ok(relationship);
    } catch (error) {
      if (error instanceof RelationshipTargetNotFoundError) {
        return fail(400, "VALIDATION_ERROR", error.message);
      }

      throw error;
    }
  });
};
