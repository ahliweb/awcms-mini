/**
 * Keyset-paginated `awcms_mini_visitor_sessions` listing (Issue #621,
 * epic: visitor analytics #617-#624). Ordered `last_seen_at DESC, id
 * DESC` — reuses `_shared/keyset-pagination.ts`'s generic `(timestamp,
 * id)` cursor even though the sort column here is `last_seen_at`, not
 * literally `created_at` (the cursor utility only encodes a Date+id
 * pair, it has no column-name assumption baked in).
 */
import type { VisitorSessionRow } from "../domain/analytics-response-shaping";
import type { KeysetCursor } from "../../_shared/keyset-pagination";

export const VISITOR_SESSION_LIST_LIMIT = 50;

export async function listVisitorSessions(
  tx: Bun.SQL,
  tenantId: string,
  cursor?: KeysetCursor
): Promise<VisitorSessionRow[]> {
  if (cursor) {
    return (await tx`
      SELECT * FROM awcms_mini_visitor_sessions
      WHERE tenant_id = ${tenantId}
        AND (last_seen_at, id) < (${cursor.createdAt}, ${cursor.id})
      ORDER BY last_seen_at DESC, id DESC
      LIMIT ${VISITOR_SESSION_LIST_LIMIT}
    `) as VisitorSessionRow[];
  }

  return (await tx`
    SELECT * FROM awcms_mini_visitor_sessions
    WHERE tenant_id = ${tenantId}
    ORDER BY last_seen_at DESC, id DESC
    LIMIT ${VISITOR_SESSION_LIST_LIMIT}
  `) as VisitorSessionRow[];
}
