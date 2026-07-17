import type { APIRoute } from "astro";

import { fail } from "../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../lib/database/client";
import { withTenant } from "../../../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../../../lib/auth/session-token";
import { recordAuditEvent } from "../../../../../../modules/logging/application/audit-log";
import {
  getExportJobById,
  getExportJobFileContent,
  resolveExportDescriptor
} from "../../../../../../modules/data-exchange/application/export-job-directory";
import { authorizeExchangeDescriptorPermission } from "../../../../../../modules/data-exchange/application/descriptor-authorization";

const MODULE_KEY = "data_exchange";

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
export const GET: APIRoute = async ({ request, cookies, params, locals }) => {
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
  const correlationId = locals.correlationId;

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

    // Security-auditor finding on PR #782 (High): every OTHER route that
    // resolves an `ExchangeDescriptor` (stage, preview, commit, retry,
    // export-create) already calls `authorizeExchangeDescriptorPermission`
    // — this route, which serves the raw materialized export FILE CONTENT
    // (more sensitive than the job metadata `exports.read` already covers),
    // was the one call site that never did. A caller holding only the
    // generic `data_exchange.export_downloads.read` permission must not be
    // able to bypass an owning module's own `requiredPermission` gate
    // (e.g. a future payroll/HR export descriptor) just because this route
    // forgot to check it.
    //
    // Issue #820 Cacat 3: passing an unresolvable descriptor as `null` used
    // to skip that gate entirely — so disabling the owning module made its
    // already-materialized export file MORE downloadable, not less. Of
    // every call site this one matters most: it serves raw file content.
    const downloadDescriptor = resolveExportDescriptor(job.exportKey);
    if (!downloadDescriptor) {
      return fail(
        409,
        "INVALID_STATE",
        `Export job cannot be downloaded: exportKey "${job.exportKey}" is no longer registered — its owning module may be disabled.`
      );
    }

    const descriptorPermCheck = await authorizeExchangeDescriptorPermission(
      tx,
      tenantId,
      tokenHash,
      now,
      downloadDescriptor
    );
    if (!descriptorPermCheck.allowed) return descriptorPermCheck.denied;

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

    // Security-auditor finding on PR #782 (Medium): downloading the raw
    // business-data artifact previously left no trail of WHO downloaded it
    // — only that the export job completed. Audited here, distinct from
    // `export-execute-job.ts`'s own "export completed" audit entry.
    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId: auth.context.tenantUserId,
      moduleKey: MODULE_KEY,
      action: "export",
      resourceType: "export_job",
      resourceId: job.id,
      severity: "info",
      message: `Export job "${job.exportKey}" file content downloaded.`,
      attributes: {
        rowCount: job.rowCount,
        checksumSha256: job.checksumSha256
      },
      correlationId
    });

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
