import type { APIRoute } from "astro";

import {
  fail,
  jsonResponse,
  ok
} from "../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../lib/database/client";
import { parseProvisioningRequestBody } from "../../../../../modules/tenant-provisioning/application/request-parsing";
import { requestProvisioning } from "../../../../../modules/tenant-provisioning/application/provisioning-orchestrator";
import { authorizeOperator, buildEngineDeps } from "../_support";

/**
 * `POST /api/v1/tenant-provisioning/requests` (Issue #872) — request an
 * idempotent tenant provisioning run. Creates the target tenant record (ACID
 * anti-duplicate on `tenant_code`), owner, office, settings, and the run +
 * steps (bootstrap + owner pre-completed) in ONE transaction, then returns the
 * run. Platform-operator only + default-deny; requires `Idempotency-Key` (bound
 * to the target identity + immutable inputs). A same-key replay returns 200; a
 * different request for a taken tenant code returns 409. The tenant is created
 * INACTIVE — `start` runs the remaining steps and readiness activates it.
 */
export const POST: APIRoute = async ({ request, cookies, locals }) => {
  const correlationId = locals.correlationId;

  const auth = await authorizeOperator(
    request,
    cookies,
    "requests",
    "create",
    correlationId
  );
  if (auth instanceof Response) return auth;

  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey) {
    return fail(
      400,
      "IDEMPOTENCY_REQUIRED",
      "Idempotency-Key header is required."
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "VALIDATION_ERROR", "Request body must be valid JSON.");
  }
  const input = parseProvisioningRequestBody(body);

  const sql = getDatabaseClient();
  const deps = buildEngineDeps(correlationId);

  const result = await sql.begin((tx: Bun.SQL) =>
    requestProvisioning(
      tx,
      {
        actorTenantUserId: auth.actorTenantUserId,
        idempotencyKey,
        correlationId
      },
      input,
      deps.onboarding
    )
  );

  if (!result.ok) {
    if (result.reason === "validation") {
      return fail(
        400,
        "VALIDATION_ERROR",
        result.errors.map((e) => `${e.field}: ${e.message}`).join("; ")
      );
    }
    return fail(409, "PROVISIONING_CONFLICT", result.message);
  }

  const payload = ok({ request: result.request });
  return result.replayed
    ? jsonResponse(await payload.clone().json(), { status: 200 })
    : jsonResponse(await payload.clone().json(), { status: 201 });
};
