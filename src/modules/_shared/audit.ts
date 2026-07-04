/**
 * Audit helper (doc 10): high-risk action wajib audit log, tenant-scoped,
 * attributes selalu di-redact sebelum disimpan.
 */
import { redactSensitive } from "../../lib/logging/redact";

export type AuditSeverity = "info" | "warning" | "critical";

export type AuditEventInput = {
  tenantId: string;
  actorTenantUserId?: string;
  moduleKey: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  severity?: AuditSeverity;
  message: string;
  attributes?: Record<string, unknown>;
  correlationId?: string;
};

export type AuditEventRecord = AuditEventInput & {
  severity: AuditSeverity;
  attributes: Record<string, unknown>;
  occurredAt: string;
};

/**
 * Normalisasi + redaction input audit. Penyimpanan ke awcms_audit_events
 * dilakukan repository modul observability-logging di dalam transaction
 * yang sama dengan mutation-nya.
 */
export function buildAuditEvent(input: AuditEventInput): AuditEventRecord {
  return {
    ...input,
    severity: input.severity ?? "info",
    attributes: redactSensitive(input.attributes ?? {}),
    occurredAt: new Date().toISOString()
  };
}
