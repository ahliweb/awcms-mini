/**
 * Lifecycle/audit summary for one module's admin detail page (Issue #521,
 * epic #510) — recent audit events across the module-management actions
 * that target this specific module: tenant enable/disable (#515), settings
 * update (#516), and health check (#520). Read-only, bounded (`LIMIT 20`),
 * tenant-scoped via RLS like every other audit query in this app.
 */
export type ModuleAuditSummaryEntry = {
  action: string;
  resourceType: string;
  severity: string;
  message: string;
  createdAt: string;
};

const RELEVANT_RESOURCE_TYPES = [
  "tenant_module",
  "module_settings",
  "module_health"
] as const;

export async function fetchModuleAuditSummary(
  tx: Bun.SQL,
  tenantId: string,
  moduleKey: string,
  limit = 20
): Promise<ModuleAuditSummaryEntry[]> {
  const rows = (await tx`
    SELECT action, resource_type, severity, message, created_at
    FROM awcms_mini_audit_events
    WHERE tenant_id = ${tenantId}
      AND resource_id = ${moduleKey}
      AND resource_type = ANY(${tx.array([...RELEVANT_RESOURCE_TYPES], "text")})
    ORDER BY created_at DESC
    LIMIT ${limit}
  `) as {
    action: string;
    resource_type: string;
    severity: string;
    message: string;
    created_at: Date;
  }[];

  return rows.map((row) => ({
    action: row.action,
    resourceType: row.resource_type,
    severity: row.severity,
    message: row.message,
    createdAt: row.created_at.toISOString()
  }));
}
