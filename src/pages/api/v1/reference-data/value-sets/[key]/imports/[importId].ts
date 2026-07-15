import type { APIRoute } from "astro";

import { fail, ok } from "../../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../../lib/database/client";
import { withTenant } from "../../../../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../../../../lib/auth/session-token";
import { fetchReferenceValueSetByKey } from "../../../../../../../modules/reference-data/application/value-set-directory";
import { fetchReferenceImportById } from "../../../../../../../modules/reference-data/application/import-service";

const READ_GUARD = {
  moduleKey: "reference_data",
  activityCode: "imports",
  action: "read" as const
};

/** `GET /api/v1/reference-data/value-sets/{key}/imports/{importId}` — batch detail/diff/status/checksum (Issue #750). */
export const GET: APIRoute = async ({ request, cookies, params }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const key = params.key;
  const importId = params.importId;
  if (!key || !importId) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Value set key and import id are required."
    );
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
    if (!auth.allowed) return auth.denied;

    const valueSet = await fetchReferenceValueSetByKey(tx, key);
    if (!valueSet) return fail(404, "NOT_FOUND", "Value set not found.");

    const importBatch = await fetchReferenceImportById(tx, importId);
    if (!importBatch || importBatch.valueSetId !== valueSet.id) {
      return fail(404, "NOT_FOUND", "Import batch not found.");
    }

    return ok({ import: importBatch });
  });
};
