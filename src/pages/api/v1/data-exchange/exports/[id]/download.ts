import type { APIRoute } from "astro";

import { fail } from "../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../lib/database/client";
import { withTenant } from "../../../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../../../lib/auth/session-token";
import {
  getExportJobById,
  getExportJobFileContent
} from "../../../../../../modules/data-exchange/application/export-job-directory";

/** Distinct, more sensitive permission from `exports.read` (Issue #752 security requirement — export FILE CONTENT is more sensitive than job status/manifest metadata). */
const DOWNLOAD_GUARD = {
  moduleKey: "data_exchange",
  activityCode: "export_downloads",
  action: "read" as const
};

const CONTENT_TYPES: Record<"csv" | "json", string> = {
  csv: "text/csv; charset=utf-8",
  json: "application/json; charset=utf-8"
};

/**
 * `GET /api/v1/data-exchange/exports/{id}/download` (Issue #752) —
 * downloads a completed export job's raw file content. Returns the raw
 * `text/csv`/`application/json` body (not the standard `ApiSuccess`
 * envelope) on success; error responses still use the standard `ApiError`
 * envelope.
 */
export const GET: APIRoute = async ({ request, cookies, params }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const jobId = params.id;
  if (!jobId)
    return fail(400, "VALIDATION_ERROR", "id path parameter is required.");

  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const now = new Date();

  return withTenant(sql, tenantId, async (tx) => {
    const auth = await authorizeInTransaction(
      tx,
      tenantId,
      tokenHash,
      now,
      DOWNLOAD_GUARD
    );
    if (!auth.allowed) return auth.denied;

    const job = await getExportJobById(tx, tenantId, jobId);
    if (!job) return fail(404, "NOT_FOUND", "Export job not found.");
    if (job.status !== "completed") {
      return fail(
        409,
        "INVALID_STATE",
        `Export job is not completed (status "${job.status}").`
      );
    }

    const content = await getExportJobFileContent(tx, tenantId, jobId);
    if (content === null) {
      return fail(
        500,
        "INTERNAL_ERROR",
        "Export job is completed but has no file content."
      );
    }

    const extension = job.format;
    const safeFilename = `${job.exportKey.replace(/[^a-z0-9_.-]/gi, "_")}-${job.id}.${extension}`;

    return new Response(content, {
      status: 200,
      headers: {
        "content-type": CONTENT_TYPES[job.format],
        "content-disposition": `attachment; filename="${safeFilename}"`,
        "x-content-checksum-sha256": job.checksumSha256 ?? ""
      }
    });
  });
};
