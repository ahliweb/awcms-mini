import type { APIRoute } from "astro";

import { fail, ok } from "../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../lib/database/client";
import { withTenant } from "../../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../../lib/auth/session-token";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../lib/security/request-body-limit";
import {
  createOperationalLocation,
  listOperationalLocations
} from "../../../../../modules/organization-structure/application/operational-location-directory";

const READ_GUARD = {
  moduleKey: "organization_structure",
  activityCode: "locations",
  action: "read" as const
};
const CREATE_GUARD = {
  moduleKey: "organization_structure",
  activityCode: "locations",
  action: "create" as const
};

export const GET: APIRoute = async ({ request, cookies }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

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
    if (!auth.allowed) return auth.denied;

    const locations = await listOperationalLocations(tx, tenantId);
    return ok({ locations });
  });
};

function parseNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && !Number.isNaN(value)) return value;
  return null;
}

export const POST: APIRoute = async ({ request, cookies, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const bodyRead = await readJsonBody<Record<string, unknown>>(
    request,
    "default"
  );
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
  const body = bodyRead.value ?? {};

  const input = {
    name: typeof body.name === "string" ? body.name : "",
    addressLine1:
      typeof body.addressLine1 === "string" ? body.addressLine1 : null,
    addressLine2:
      typeof body.addressLine2 === "string" ? body.addressLine2 : null,
    city: typeof body.city === "string" ? body.city : null,
    region: typeof body.region === "string" ? body.region : null,
    postalCode: typeof body.postalCode === "string" ? body.postalCode : null,
    countryCode: typeof body.countryCode === "string" ? body.countryCode : null,
    latitude: parseNumberOrNull(body.latitude),
    longitude: parseNumberOrNull(body.longitude)
  };

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
    if (!auth.allowed) return auth.denied;

    const result = await createOperationalLocation(
      tx,
      tenantId,
      auth.context.tenantUserId,
      input,
      correlationId
    );

    if (!result.ok) {
      return fail(
        400,
        "VALIDATION_ERROR",
        result.errors
          .map((error) => `${error.field}: ${error.message}`)
          .join("; ")
      );
    }

    return ok({ location: result.location });
  });
};
