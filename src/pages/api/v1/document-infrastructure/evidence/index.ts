import type { APIRoute } from "astro";

import { fail, ok } from "../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../lib/database/client";
import { withTenant } from "../../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../../lib/auth/session-token";
import { listDocumentEvidence } from "../../../../../modules/document-infrastructure/application/document-evidence-directory";
import {
  CONFIDENTIAL_READ_PERMISSION_KEY,
  RESTRICTED_READ_PERMISSION_KEY
} from "../../../../../modules/document-infrastructure/domain/document";

const READ_GUARD = {
  moduleKey: "document_infrastructure",
  activityCode: "evidence",
  action: "read" as const
};

/**
 * `GET /api/v1/document-infrastructure/evidence?documentId=&sequenceId=`
 * (Issue #751) — the append-only evidence trail. Evidence rows tied to a
 * `confidential`/`restricted` document are filtered by confidentiality-
 * tier clearance (Issue #787 fast-follow) — see `document-evidence-
 * directory.ts`'s `listDocumentEvidence` doc comment.
 */
export const GET: APIRoute = async ({ request, cookies, url }) => {
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

    const access = {
      canReadConfidential: auth.grantedPermissionKeys.has(
        CONFIDENTIAL_READ_PERMISSION_KEY
      ),
      canReadRestricted: auth.grantedPermissionKeys.has(
        RESTRICTED_READ_PERMISSION_KEY
      )
    };

    const evidence = await listDocumentEvidence(tx, tenantId, access, {
      documentId: url.searchParams.get("documentId") ?? undefined,
      sequenceId: url.searchParams.get("sequenceId") ?? undefined
    });

    return ok({ evidence });
  });
};
