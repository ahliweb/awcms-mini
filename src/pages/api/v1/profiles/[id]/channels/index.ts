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
  ChannelIdentifierNotFoundError,
  createChannel,
  listChannels
} from "../../../../../../modules/profile-identity/application/channel-directory";
import { fetchPartyById } from "../../../../../../modules/profile-identity/application/party-directory";
import { validateCreateChannelInput } from "../../../../../../modules/profile-identity/domain/address-channel-validation";

const READ_GUARD = {
  moduleKey: "profile_identity",
  activityCode: "channels",
  action: "read" as const
};

const CREATE_GUARD = {
  moduleKey: "profile_identity",
  activityCode: "channels",
  action: "create" as const
};

/** `GET /api/v1/profiles/{id}/channels` (Issue #748). */
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

    const channels = await listChannels(tx, tenantId, profileId);

    return ok({ items: channels });
  });
};

/** `POST /api/v1/profiles/{id}/channels` (Issue #748) — communication channel referencing an existing identifier (`profileIdentifierId`), never duplicating the sensitive value. */
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

  const validation = validateCreateChannelInput(bodyRead.value);

  if (!validation.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Channel input is invalid.",
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
      const channel = await createChannel(
        tx,
        tenantId,
        auth.context.tenantUserId,
        profileId,
        validation.value,
        correlationId
      );

      return ok(channel);
    } catch (error) {
      if (error instanceof ChannelIdentifierNotFoundError) {
        return fail(400, "VALIDATION_ERROR", error.message);
      }

      throw error;
    }
  });
};
