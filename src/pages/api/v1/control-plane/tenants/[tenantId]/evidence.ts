import type { APIRoute } from "astro";
import { fail } from "../../../../../../modules/_shared/api-response";
import { recordAuditEvent } from "../../../../../../modules/logging/application/audit-log";
import { hasActiveSupportGrant } from "../../../../../../modules/identity-access/application/support-access";
import {
  collectControlPlaneEvidence,
  EVIDENCE_MAX_WINDOW_DAYS,
  EVIDENCE_SECTION_ROW_LIMIT,
  resolveEvidenceWindow
} from "../../../../../../modules/logging/application/control-plane-evidence";
import {
  authorizeSupportOperator,
  isUuid,
  successBody,
  withTargetTenant
} from "../../_support";

/**
 * `GET /api/v1/control-plane/tenants/{tenantId}/evidence` (Issue #930 Wave 5,
 * epic #868) — a BOUNDED, MASKED, AUDITED operator evidence package for one
 * tenant's control plane.
 *
 * ## Two independent gates, and why the permission alone is not enough
 *
 * The obvious design gives an operator a `support_access.export` permission
 * and stops there. That would make every tenant's control-plane history
 * readable by any holder of that permission, at any time, with no record that
 * anyone decided it was warranted — the permission would be a standing key to
 * the whole fleet.
 *
 * So this requires BOTH:
 *
 *   1. the `identity_access.support_access.export` permission, evaluated in
 *      the operator's OWN platform tenant; and
 *   2. an APPROVED, UNREVOKED, UNEXPIRED support-access grant for THIS target
 *      tenant, held by THIS operator.
 *
 * (2) is the one that matters. #879 already built support grants as
 * maker/checker with a second approver and an auto-expiry window; reusing them
 * means an evidence export inherits all of it — someone else approved it, it
 * was justified with a reason, and the authority to read this tenant expires
 * on its own. Without (2) a 403 is returned even for a fully permissioned
 * operator, and the refusal itself is audited.
 *
 * ## Cross-tenant shape (ADR-0022 §6b)
 *
 * Authorization happens in the PLATFORM tenant's RLS context; the evidence is
 * read inside the TARGET tenant's own context via `withTargetTenant`. No query
 * ever sees two tenants' rows, and nothing needs `BYPASSRLS`.
 *
 * ## Masked by construction, not by redaction
 *
 * The collector's row types have no field capable of holding a provider
 * reference, envelope, token, secret, or email address — so there is nothing
 * for a later `SELECT *` to leak into. See its module docstring; a redaction
 * step is something you can forget to apply, and a field that does not exist
 * is not.
 *
 * ## Audited either way
 *
 * A successful export writes one audit row recording the window actually used
 * (after clamping), which sections truncated, and the caps in force. A REFUSED
 * export writes one too: "who tried to read a tenant they had no live grant
 * for" is the more interesting line in an investigation, and a design that
 * only logs successes cannot answer it.
 */
export const GET: APIRoute = async ({ request, cookies, params, url }) => {
  const targetTenantId = params.tenantId;

  if (!targetTenantId || !isUuid(targetTenantId)) {
    return fail(400, "VALIDATION_ERROR", "A valid tenant id is required.");
  }

  const auth = await authorizeSupportOperator(request, cookies, "export");
  if (auth instanceof Response) {
    return auth;
  }

  const now = new Date();
  const from = parseIsoDate(url.searchParams.get("from"));
  const to = parseIsoDate(url.searchParams.get("to"));

  if (url.searchParams.get("from") && !from) {
    return fail(400, "VALIDATION_ERROR", "`from` must be an ISO-8601 date.");
  }
  if (url.searchParams.get("to") && !to) {
    return fail(400, "VALIDATION_ERROR", "`to` must be an ISO-8601 date.");
  }
  if (from && to && from > to) {
    return fail(400, "VALIDATION_ERROR", "`from` must not be after `to`.");
  }

  const window = resolveEvidenceWindow(from, to, now);

  const outcome = await withTargetTenant(targetTenantId, async (tx) => {
    const granted = await hasActiveSupportGrant(
      tx,
      targetTenantId,
      auth.operatorIdentityId,
      now
    );

    if (!granted) {
      // Audited BEFORE returning, and in the target tenant's own context so
      // the record lands where an investigator of THAT tenant will find it.
      await recordAuditEvent(tx, {
        tenantId: targetTenantId,
        moduleKey: "identity_access",
        action: "export",
        resourceType: "control_plane_evidence",
        severity: "warning",
        message:
          "Control-plane evidence export REFUSED: the operator holds the export permission but has no approved, unexpired support-access grant for this tenant.",
        attributes: { outcome: "denied_no_active_grant" }
      });
      return { ok: false as const };
    }

    const evidence = await collectControlPlaneEvidence(
      tx,
      targetTenantId,
      window
    );

    await recordAuditEvent(tx, {
      tenantId: targetTenantId,
      moduleKey: "identity_access",
      action: "export",
      resourceType: "control_plane_evidence",
      severity: "warning",
      message:
        "Control-plane evidence exported by a platform operator under an active support-access grant.",
      attributes: {
        windowFromIso: evidence.window.fromIso,
        windowToIso: evidence.window.toIso,
        windowClamped: evidence.window.clamped,
        maxWindowDays: EVIDENCE_MAX_WINDOW_DAYS,
        sectionRowLimit: EVIDENCE_SECTION_ROW_LIMIT,
        provisioningStepsTruncated: evidence.provisioning.steps.truncated,
        entitlementsTruncated: evidence.entitlements.truncated
      }
    });

    return { ok: true as const, evidence };
  });

  if (!outcome.ok) {
    return fail(
      403,
      "ACCESS_DENIED",
      "An approved, unexpired support-access grant for this tenant is required to export its control-plane evidence."
    );
  }

  return new Response(JSON.stringify(successBody(outcome.evidence)), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      // Never cached anywhere: this is cross-tenant operator data behind a
      // time-bounded grant, and a shared cache entry would outlive the grant
      // that authorized it.
      "Cache-Control": "private, no-store"
    }
  });
};

function parseIsoDate(raw: string | null): Date | null {
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
