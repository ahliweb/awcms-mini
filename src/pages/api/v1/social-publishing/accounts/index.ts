import type { APIRoute } from "astro";

import {
  fail,
  jsonResponse,
  ok
} from "../../../../../modules/_shared/api-response";
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
import { log } from "../../../../../lib/logging/logger";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../../../../modules/_shared/idempotency";
import {
  connectSocialAccount,
  listSocialAccounts
} from "../../../../../modules/social-publishing/application/social-account-directory";
import { validateCreateSocialAccountInput } from "../../../../../modules/social-publishing/domain/social-account-validation";
import { getSocialProviderAdapter } from "../../../../../modules/social-publishing/infrastructure/social-provider-registry";

const READ_GUARD = {
  moduleKey: "social_publishing",
  activityCode: "accounts",
  action: "read" as const
};

const CONNECT_GUARD = {
  moduleKey: "social_publishing",
  activityCode: "accounts",
  action: "connect" as const
};

const IDEMPOTENCY_SCOPE = "social_publishing_account_connect";

/** `GET /api/v1/social-publishing/accounts` (Issue #643) — list this tenant's connected/disconnected social accounts. `token_reference` is never included (see `social-account-directory.ts`'s header). */
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

    const accounts = await listSocialAccounts(tx, tenantId);

    return ok({ accounts });
  });
};

/**
 * `POST /api/v1/social-publishing/accounts` (Issue #643) — connect (or
 * reconnect/reauthorize) a social account. High-risk mutation (writes a
 * `token_reference`, changes credential-bearing state) — requires
 * `Idempotency-Key`, same convention `blog/posts/{id}/publish.ts` uses for
 * its own high-risk mutation.
 */
export const POST: APIRoute = async ({ request, cookies, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
  }

  const idempotencyKey = request.headers.get("idempotency-key");

  if (!idempotencyKey) {
    return fail(
      400,
      "IDEMPOTENCY_REQUIRED",
      "Idempotency-Key header is required."
    );
  }

  const bodyRead = await readJsonBody<Record<string, unknown>>(
    request,
    "default"
  );

  if (bodyRead.tooLarge) {
    return bodyTooLargeResponse(bodyRead.limitBytes);
  }

  const validation = validateCreateSocialAccountInput(bodyRead.value);

  if (!validation.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Social account connection request is invalid.",
      {},
      validation.errors
    );
  }

  const input = validation.value;

  // Issue #644 review follow-up (defense-in-depth, second layer alongside
  // the dispatcher's own check in `social-publish-dispatch.ts`):
  // `validateCreateSocialAccountInput` only checks `providerAccountType`
  // against the generic 5-value enum shared by every provider — it never
  // cross-checks against whichever adapter is registered for the
  // submitted `providerKey`. Reject here too, at connect time, so an
  // operator gets immediate feedback instead of discovering the mismatch
  // only when a job later fails at dispatch.
  const adapterForProvider = getSocialProviderAdapter(input.providerKey);

  if (
    adapterForProvider?.supportedAccountTypes &&
    !adapterForProvider.supportedAccountTypes.includes(
      input.providerAccountType
    )
  ) {
    return fail(
      422,
      "SOCIAL_ACCOUNT_UNSUPPORTED_TYPE",
      `Provider "${input.providerKey}" does not support account type "${input.providerAccountType}".`
    );
  }

  const requestHash = computeRequestHash({
    providerKey: input.providerKey,
    providerAccountId: input.providerAccountId
  });
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
      CONNECT_GUARD
    );

    if (!auth.allowed) {
      return auth.denied;
    }

    const existingIdempotency = await findIdempotencyRecord(
      tx,
      tenantId,
      IDEMPOTENCY_SCOPE,
      idempotencyKey
    );

    if (existingIdempotency) {
      if (existingIdempotency.requestHash !== requestHash) {
        return fail(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency-Key was already used with a different request."
        );
      }

      return jsonResponse(existingIdempotency.responseBody, {
        status: existingIdempotency.responseStatus
      });
    }

    const account = await connectSocialAccount(
      tx,
      tenantId,
      auth.context.tenantUserId,
      input,
      correlationId
    );

    log("info", "social_publishing.account.connected", {
      correlationId,
      tenantId,
      moduleKey: "social_publishing",
      socialAccountId: account.id,
      providerKey: account.providerKey
    });

    const successResponse = ok(account);
    const successBody = await successResponse.clone().json();

    await saveIdempotencyRecord(
      tx,
      tenantId,
      IDEMPOTENCY_SCOPE,
      idempotencyKey,
      requestHash,
      200,
      successBody
    );

    return successResponse;
  });
};
