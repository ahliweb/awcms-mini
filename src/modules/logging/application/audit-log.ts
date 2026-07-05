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
}
