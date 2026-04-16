import { getDatabase, withTransaction } from "../../db/index.mjs";
import { createAuditLogRepository, normalizeAuditPayload } from "../../db/repositories/audit-logs.mjs";

function createAuditServiceDependencies(executor) {
  return {
    auditLogs: createAuditLogRepository(executor),
  };
}

function normalizeNullableString(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const nextValue = String(value).trim();
  return nextValue.length > 0 ? nextValue : null;
}

export function createAuditService(options = {}) {
  const database = options.database ?? getDatabase();

  return {
    async append(input) {
      return withTransaction(database, async (trx) => {
        const deps = createAuditServiceDependencies(trx);

        return deps.auditLogs.appendLog({
          id: input.id ?? crypto.randomUUID(),
          actor_user_id: normalizeNullableString(input.actor_user_id),
          action: String(input.action ?? "").trim(),
          entity_type: String(input.entity_type ?? "").trim(),
          entity_id: normalizeNullableString(input.entity_id),
          target_user_id: normalizeNullableString(input.target_user_id),
          request_id: normalizeNullableString(input.request_id),
          ip_address: normalizeNullableString(input.ip_address),
          user_agent: normalizeNullableString(input.user_agent),
          summary: normalizeNullableString(input.summary),
          before_payload: input.before_payload ?? null,
          after_payload: input.after_payload ?? null,
          metadata: normalizeAuditPayload(input.metadata),
          occurred_at: input.occurred_at ?? undefined,
        });
      });
    },

    async list(input = {}) {
      return withTransaction(database, async (trx) => {
        const deps = createAuditServiceDependencies(trx);

        return deps.auditLogs.listLogs({
          actorUserId: input.actor_user_id,
          targetUserId: input.target_user_id,
          action: input.action,
          entityType: input.entity_type,
          entityId: input.entity_id,
          requestId: input.request_id,
          limit: input.limit,
          offset: input.offset,
        });
      });
    },
  };
}
