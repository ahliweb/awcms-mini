export const ACCESS_AUDIT_DECISION_WINDOW_DAYS = 30;

export type AccessAuditReport = {
  decisionWindowDays: number;
  allowCount: number;
  denyCount: number;
  totalDecisionCount: number;
  profileAuditLogCount: number;
};

/**
 * Access/audit summary (Issue 9.1, `GET /reports/access-audit`). Live
 * read-aggregation over `awcms_mini_abac_decision_logs` (migration 005) and
 * `awcms_mini_profile_audit_logs` (migration 003) — no new tables.
 *
 * `allowCount`/`denyCount` are windowed (last
 * `ACCESS_AUDIT_DECISION_WINDOW_DAYS` days); `totalDecisionCount` is
 * all-time. `profileAuditLogCount` is an all-time count used only as a
 * generic proxy for "there is other audit activity happening" — this base
 * has no general-purpose `audit_events` table yet (see
 * `src/modules/sync-storage/README.md` §Belum tersedia).
 */
export async function fetchAccessAuditReport(
  tx: Bun.SQL,
  tenantId: string
): Promise<AccessAuditReport> {
  const decisionRows = await tx`
    SELECT decision, COUNT(*) AS decision_count
    FROM awcms_mini_abac_decision_logs
    WHERE tenant_id = ${tenantId}
      AND created_at >= now() - make_interval(days => ${ACCESS_AUDIT_DECISION_WINDOW_DAYS})
    GROUP BY decision
  `;

  let allowCount = 0;
  let denyCount = 0;

  for (const row of decisionRows as {
    decision: string;
    decision_count: string;
  }[]) {
    if (row.decision === "allow") {
      allowCount = Number(row.decision_count);
    } else if (row.decision === "deny") {
      denyCount = Number(row.decision_count);
    }
  }

  const totalRows = await tx`
    SELECT COUNT(*) AS total_count
    FROM awcms_mini_abac_decision_logs
    WHERE tenant_id = ${tenantId}
  `;

  const profileAuditRows = await tx`
    SELECT COUNT(*) AS profile_audit_log_count
    FROM awcms_mini_profile_audit_logs
    WHERE tenant_id = ${tenantId}
  `;

  return {
    decisionWindowDays: ACCESS_AUDIT_DECISION_WINDOW_DAYS,
    allowCount,
    denyCount,
    totalDecisionCount: Number(totalRows[0]?.total_count ?? 0),
    profileAuditLogCount: Number(
      profileAuditRows[0]?.profile_audit_log_count ?? 0
    )
  };
}
