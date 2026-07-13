import type { APIRoute } from "astro";

import {
  fail,
  jsonResponse,
  ok
} from "../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../lib/database/client";
import { withTenant } from "../../../../../../lib/database/tenant-context";
import { withTimeout } from "../../../../../../lib/integration/timeout";
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
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../../../../../modules/_shared/idempotency";
import {
  fetchSocialAccountById,
  fetchSocialAccountCredentialsForVerification,
  recordSocialAccountVerification
} from "../../../../../../modules/social-publishing/application/social-account-directory";
import { getSocialProviderAdapter } from "../../../../../../modules/social-publishing/infrastructure/social-provider-registry";
import type { SocialProviderCredentialCheck } from "../../../../../../modules/social-publishing/domain/social-provider-adapter";
// Issue #646 — side-effect import registers the real Telegram adapter into
// the registry this route reads from, for the Astro SSR process (scripts
// register it separately for their own processes — see
// `telegram-provider-registration.ts`'s header comment). A future #644
// (Meta)/#645 (LinkedIn) adapter adds its own equivalent import here
// alongside this one — this route is provider-neutral and serves whichever
// adapters are registered.
import "../../../../../../modules/social-publishing/infrastructure/telegram-provider-registration";
// Issue #645 — side-effect import registers the real LinkedIn adapter into
// the same registry for this process (a no-op unless
// LINKEDIN_PROVIDER_ENABLED=true — see
// `linkedin-provider-registration.ts`'s header comment).
import "../../../../../../modules/social-publishing/infrastructure/linkedin-provider-registration";

const VERIFY_GUARD = {
  moduleKey: "social_publishing",
  activityCode: "accounts",
  action: "verify" as const
};

const IDEMPOTENCY_SCOPE = "social_publishing_account_verify";
const VERIFY_CALL_TIMEOUT_MS = 15_000;

type Phase1Result =
  | { kind: "response"; response: Response }
  | {
      kind: "proceed";
      providerKey: string;
      providerAccountId: string;
      tokenReference: string | null;
      scopes: string[];
      lastVerifiedAt: Date | null;
      actorTenantUserId: string;
    };

/**
 * `POST /api/v1/social-publishing/accounts/{id}/verify` (Issue #646) —
 * generic, provider-neutral "verify this connected account" admin action.
 * The foundation's own `SocialProviderAdapter.verifyCredentials` interface
 * comment (Issue #643) already anticipated this exact endpoint ("a manual
 * 'verify connection' admin action"); the Telegram adapter is simply the
 * first real implementation exercised through it.
 *
 * Three-phase shape (ADR-0006: the real provider call must never happen
 * inside a DB transaction) — same pattern
 * `social-publish-dispatch.ts`'s CLAIM/CALL/FINALIZE dispatcher already
 * established, applied here to a single ad hoc admin action instead of a
 * batch:
 *
 *   1. authorize + idempotency check + fetch account/credentials
 *      (transactional, no external call).
 *   2. the actual `adapter.verifyCredentials(...)` call (outside any
 *      transaction).
 *   3. record the outcome (`last_verified_at`/`scopes_json`/audit log) +
 *      save the idempotency record (transactional, no external call).
 *
 * Requires `Idempotency-Key` — not classified `HIGH_RISK_ACTIONS` (`verify`
 * only updates fields already on the row, never `token_reference`), but
 * this DOES make a real outbound network call to the provider, same
 * external-call class as `accounts.connect`/`.disconnect`, so a double
 * submit must not double-call the provider.
 *
 * A failed verification (`valid: false`) is still a `200` — it is
 * informational (surfaced so an admin can fix channel permissions and retry
 * verification), never itself a state transition on the account (unlike a
 * REAL publish attempt's `needs_reauth`, which is the dispatcher's own,
 * separate mechanism).
 */
export const POST: APIRoute = async ({ request, params, cookies, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  const id = params.id;

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  if (!id) {
    return fail(400, "VALIDATION_ERROR", "Account id is required.");
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

  // No meaningful request body — read (and enforce the body-size limit) so
  // an oversized/garbage body on this endpoint is still rejected the same
  // way every other mutation endpoint rejects one, even though nothing in
  // it is used.
  const bodyRead = await readJsonBody<Record<string, unknown>>(
    request,
    "default"
  );

  if (bodyRead.tooLarge) {
    return bodyTooLargeResponse(bodyRead.limitBytes);
  }

  const requestHash = computeRequestHash({ accountId: id, action: "verify" });
  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const now = new Date();
  const correlationId = locals.correlationId;

  const phase1 = await withTenant(
    sql,
    tenantId,
    async (tx): Promise<Phase1Result> => {
      const auth = await authorizeInTransaction(
        tx,
        tenantId,
        tokenHash,
        now,
        VERIFY_GUARD
      );

      if (!auth.allowed) {
        return { kind: "response", response: auth.denied };
      }

      const existingIdempotency = await findIdempotencyRecord(
        tx,
        tenantId,
        IDEMPOTENCY_SCOPE,
        idempotencyKey
      );

      if (existingIdempotency) {
        if (existingIdempotency.requestHash !== requestHash) {
          return {
            kind: "response",
            response: fail(
              409,
              "IDEMPOTENCY_CONFLICT",
              "Idempotency-Key was already used with a different request."
            )
          };
        }

        return {
          kind: "response",
          response: jsonResponse(existingIdempotency.responseBody, {
            status: existingIdempotency.responseStatus
          })
        };
      }

      const account = await fetchSocialAccountById(tx, tenantId, id);

      if (!account) {
        return {
          kind: "response",
          response: fail(404, "RESOURCE_NOT_FOUND", "Social account not found.")
        };
      }

      if (account.connectionStatus === "disconnected") {
        return {
          kind: "response",
          response: fail(
            409,
            "INVALID_STATUS_TRANSITION",
            "Cannot verify a disconnected account — reconnect it first."
          )
        };
      }

      const credentials = await fetchSocialAccountCredentialsForVerification(
        tx,
        tenantId,
        id
      );

      return {
        kind: "proceed",
        providerKey: account.providerKey,
        providerAccountId: account.providerAccountId,
        tokenReference: credentials?.tokenReference ?? null,
        scopes: credentials?.scopes ?? [],
        lastVerifiedAt: account.lastVerifiedAt,
        actorTenantUserId: auth.context.tenantUserId
      };
    }
  );

  if (phase1.kind !== "proceed") {
    return phase1.response;
  }

  const {
    providerKey,
    providerAccountId,
    tokenReference,
    scopes,
    lastVerifiedAt,
    actorTenantUserId
  } = phase1;

  // Phase 2 — the real provider call, deliberately OUTSIDE any DB
  // transaction (ADR-0006).
  const adapter = getSocialProviderAdapter(providerKey);
  let checkResult: SocialProviderCredentialCheck;

  if (!adapter) {
    checkResult = { valid: false, reason: "provider_not_registered" };
  } else if (!tokenReference) {
    checkResult = { valid: false, reason: "missing_token_reference" };
  } else {
    try {
      checkResult = await withTimeout(
        adapter.verifyCredentials(
          tokenReference,
          providerAccountId,
          scopes,
          process.env
        ),
        VERIFY_CALL_TIMEOUT_MS,
        `social-publishing:verify:${providerKey}`
      );
    } catch {
      checkResult = { valid: false, reason: "verification_call_failed" };
    }
  }

  const permissions = Array.isArray(checkResult.details?.permissions)
    ? (checkResult.details!.permissions as string[])
    : undefined;

  const responseBody = ok({
    accountId: id,
    providerKey,
    valid: checkResult.valid,
    reason: checkResult.reason ?? null,
    verifiedAt: checkResult.valid
      ? now.toISOString()
      : (lastVerifiedAt?.toISOString() ?? null)
  });
  const responseJson = await responseBody.clone().json();

  // Phase 3 — record the outcome + save the idempotency record, back inside
  // a short transaction (no external call happens here).
  await withTenant(sql, tenantId, async (tx) => {
    await recordSocialAccountVerification(
      tx,
      tenantId,
      actorTenantUserId,
      id,
      {
        valid: checkResult.valid,
        reason: checkResult.reason,
        permissions
      },
      correlationId
    );

    await saveIdempotencyRecord(
      tx,
      tenantId,
      IDEMPOTENCY_SCOPE,
      idempotencyKey,
      requestHash,
      200,
      responseJson
    );
  });

  return responseBody;
};
