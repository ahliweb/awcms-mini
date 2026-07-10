/**
 * Keyset-paginated `awcms_mini_visit_events` listing (Issue #621, epic:
 * visitor analytics #617-#624). Ordered `occurred_at DESC, id DESC`.
 */
import type { VisitEventRow } from "../domain/analytics-response-shaping";
import type { KeysetCursor } from "../../_shared/keyset-pagination";

export const VISIT_EVENT_LIST_LIMIT = 50;

export async function listVisitEvents(
  tx: Bun.SQL,
  tenantId: string,
  cursor?: KeysetCursor
): Promise<VisitEventRow[]> {
  if (cursor) {
    return (await tx`
      SELECT * FROM awcms_mini_visit_events
      WHERE tenant_id = ${tenantId}
        AND (occurred_at, id) < (${cursor.createdAt}, ${cursor.id})
      ORDER BY occurred_at DESC, id DESC
      LIMIT ${VISIT_EVENT_LIST_LIMIT}
    `) as VisitEventRow[];
  }

  return (await tx`
    SELECT * FROM awcms_mini_visit_events
    WHERE tenant_id = ${tenantId}
    ORDER BY occurred_at DESC, id DESC
    LIMIT ${VISIT_EVENT_LIST_LIMIT}
  `) as VisitEventRow[];
}
