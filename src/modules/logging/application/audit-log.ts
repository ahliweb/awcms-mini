import { log } from "../../../lib/logging/logger";
import { redactSensitiveAttributes } from "../../_shared/redaction";

/**
 * Exact shape from doc 10 §Audit helper and skill `awcms-mini-audit-log`.
 * `attributes` MUST already be safe by the time callers build this object —
 * `recordAuditEvent` redacts defensively anyway (belt and suspenders), but
 * callers should not rely on that as their only safeguard.
 */
export type AuditEventInput = {
  tenantId: string;
  actorTenantUserId?: string;
  moduleKey: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  severity?: "info" | "warning" | "critical";
  message: string;
  attributes?: Record<string, unknown>;
  correlationId?: string;
};

/** The exact row just written, handed to `AuditExportHook` after INSERT. */
export type AuditEventRecorded = AuditEventInput & {
  attributes?: Record<string, unknown>;
  recordedAt: Date;
};

/**
 * Extension point (Issue #447), mirroring `setLogSink` in
 * `src/lib/logging/logger.ts`. Lets a derived application (e.g. AWPOS)
 * register a consumer for every audit event as it's written — export to an
 * external SIEM, forward to alerting, mirror into a downstream analytics
 * store — without changing this file. Default is `null` (no-op): zero
 * behavior change for every deployment that never calls
 * `setAuditExportHook`. Deliberately not a real SIEM integration (out of
 * scope per doc 20 §Matrix kepatuhan A.8.16) — just the pluggable point one
 * would attach to.
 *
 * Called *inside* the same DB transaction as the INSERT (right after it),
 * so a hook MUST NOT perform blocking external I/O directly (ADR-0006 —
 * providers are never called inside a DB transaction) — enqueue via the
 * existing outbox pattern (`src/lib/database/circuit-breaker.ts` +
 * `src/modules/sync-storage/application/object-dispatch.ts` show the
 * established claim/dispatch-outside-tx shape) instead of calling out
 * directly from here. The hook is invoked fire-and-forget: a thrown error or
 * rejected promise is caught and logged via `log()`, never allowed to fail
 * the audit write itself or the caller's transaction.
 */
export type AuditExportHook = (
  event: AuditEventRecorded
) => void | Promise<void>;

let registeredExportHook: AuditExportHook | null = null;

export function setAuditExportHook(hook: AuditExportHook | null): void {
  registeredExportHook = hook;
}

export function getAuditExportHook(): AuditExportHook | null {
  return registeredExportHook;
}

function notifyAuditExportHook(event: AuditEventRecorded): void {
  if (!registeredExportHook) {
    return;
  }

  try {
    const result = registeredExportHook(event);

    if (result instanceof Promise) {
      result.catch((error) => {
        log("warning", "Audit export hook rejected.", {
          moduleKey: "logging",
          action: event.action,
          resourceType: event.resourceType,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
  } catch (error) {
    log("warning", "Audit export hook threw synchronously.", {
      moduleKey: "logging",
      action: event.action,
      resourceType: event.resourceType,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

/**
 * Writes one row to `awcms_mini_audit_events` (migration 011). Tenant-scoped,
 * RLS-protected. `attributes` is redacted here (via
 * `src/modules/_shared/redaction.ts`) before the INSERT — never persist raw
 * password/token/API key/NPWP/NIK/phone/WhatsApp/email values.
 *
 * Audit *melengkapi, bukan menggantikan* domain event & structured log (doc
 * 10) — callers still emit their own domain events / `log()` calls as
 * appropriate; this is the durable, queryable trail specifically for
 * high-risk actions (soft delete/restore/purge, login, access assignment,
 * price change, transaction posted/cancel/return, stock adjustment,
 * transfer, Coretax export, sync conflict resolution, AI tool call, security
 * readiness decision).
 */
export async function recordAuditEvent(
  tx: Bun.SQL,
  input: AuditEventInput
): Promise<void> {
  const redactedAttributes = redactSensitiveAttributes(input.attributes);

  await tx`
    INSERT INTO awcms_mini_audit_events
      (tenant_id, actor_tenant_user_id, module_key, action, resource_type, resource_id,
       severity, message, attributes, correlation_id)
    VALUES (
      ${input.tenantId}, ${input.actorTenantUserId ?? null}, ${input.moduleKey}, ${input.action},
      ${input.resourceType}, ${input.resourceId ?? null}, ${input.severity ?? "info"},
      ${input.message}, ${redactedAttributes ?? null},
      ${input.correlationId ?? null}
    )
  `;

  notifyAuditExportHook({
    ...input,
    attributes: redactedAttributes,
    recordedAt: new Date()
  });
}
