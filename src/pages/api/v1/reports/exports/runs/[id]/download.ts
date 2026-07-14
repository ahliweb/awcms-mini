import type { APIRoute } from "astro";
import { fail } from "../../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../../lib/database/client";
import { withTenant } from "../../../../../../../lib/database/tenant-context";
import { hashSessionToken } from "../../../../../../../lib/auth/session-token";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../../../modules/identity-access/application/access-guard";
import { getExportRun } from "../../../../../../../modules/reporting/application/export-run-store";
import { readLocalExportArtifact } from "../../../../../../../modules/reporting/infrastructure/local-export-adapter";

/**
 * `GET /api/v1/reports/exports/runs/{id}/download` (Issue #753) — secure,
 * tenant-scoped, checksum-verified download of a completed export
 * artifact. Re-checks RBAC/ABAC and tenant scope at DOWNLOAD time (not
 * just at generation time — "Authorization is re-evaluated at read/
 * drill-down/export time; stale projection grants no stale privilege",
 * issue #753 acceptance criterion) and refuses (`410 Gone`) an expired
 * artifact — the file itself is never deleted proactively by this route
 * (retention/purge of old export artifacts is a documented follow-up, see
 * `reporting/README.md` §Known limitations), but an expired manifest is
 * never served.
 */
export const GET: APIRoute = async ({ request, cookies, params }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  const id = params.id;

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }
  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
  }
  if (!id) {
    return fail(400, "VALIDATION_ERROR", "Export run id is required.");
  }

  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const now = new Date();

  const outcome = await withTenant(sql, tenantId, async (tx) => {
    const auth = await authorizeInTransaction(tx, tenantId, tokenHash, now, {
      moduleKey: "reporting",
      activityCode: "exports",
      action: "read"
    });

    if (!auth.allowed) {
      return { ok: false as const, response: auth.denied };
    }

    const run = await getExportRun(tx, tenantId, id);

    if (!run || run.status !== "completed" || !run.storagePath) {
      return {
        ok: false as const,
        response: fail(
          404,
          "NOT_FOUND",
          "Export run not found or not completed."
        )
      };
    }

    if (run.expiresAt && run.expiresAt.getTime() <= now.getTime()) {
      return {
        ok: false as const,
        response: fail(
          410,
          "EXPORT_EXPIRED",
          "This export artifact has expired."
        )
      };
    }

    return { ok: true as const, run };
  });

  if (!outcome.ok) {
    return outcome.response;
  }

  try {
    const content = await readLocalExportArtifact(outcome.run.storagePath!);
    const contentType =
      outcome.run.format === "json" ? "application/json" : "text/csv";
    const fileName = `${outcome.run.projectionKey}.${outcome.run.format}`;

    return new Response(content, {
      status: 200,
      headers: {
        "content-type": `${contentType}; charset=utf-8`,
        "content-disposition": `attachment; filename="${fileName}"`,
        "x-checksum-sha256": outcome.run.checksumSha256 ?? ""
      }
    });
  } catch {
    return fail(
      404,
      "NOT_FOUND",
      "Export artifact is no longer available on disk."
    );
  }
};
