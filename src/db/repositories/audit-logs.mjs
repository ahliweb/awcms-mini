import { getDatabase } from "../index.mjs";

const AUDIT_LOG_COLUMNS = [
  "id",
  "actor_user_id",
  "action",
  "entity_type",
  "entity_id",
  "target_user_id",
  "request_id",
  "ip_address",
  "user_agent",
  "summary",
  "before_payload",
  "after_payload",
  "metadata",
  "occurred_at",
];

function baseAuditLogQuery(executor) {
  return executor.selectFrom("audit_logs").select(AUDIT_LOG_COLUMNS);
}

function normalizeAuditPayload(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }

  return {};
}

export function createAuditLogRepository(executor = getDatabase()) {
  return {
    async appendLog(input) {
      await executor
        .insertInto("audit_logs")
        .values({
          id: input.id,
          actor_user_id: input.actor_user_id ?? null,
          action: input.action,
          entity_type: input.entity_type,
          entity_id: input.entity_id ?? null,
          target_user_id: input.target_user_id ?? null,
          request_id: input.request_id ?? null,
          ip_address: input.ip_address ?? null,
          user_agent: input.user_agent ?? null,
          summary: input.summary ?? null,
          before_payload: input.before_payload ?? null,
          after_payload: input.after_payload ?? null,
          metadata: normalizeAuditPayload(input.metadata),
          occurred_at: input.occurred_at ?? undefined,
        })
        .execute();

      return this.getLogById(input.id);
    },

    async getLogById(id) {
      return baseAuditLogQuery(executor).where("id", "=", id).executeTakeFirst();
    },

    async listLogs(options = {}) {
      let query = baseAuditLogQuery(executor).orderBy("occurred_at", "desc").orderBy("id", "asc");

      if (options.actorUserId !== undefined) {
        query = query.where("actor_user_id", "=", options.actorUserId);
      }

      if (options.targetUserId !== undefined) {
        query = query.where("target_user_id", "=", options.targetUserId);
      }

      if (options.action !== undefined) {
        query = query.where("action", "=", options.action);
      }

      if (options.entityType !== undefined) {
        query = query.where("entity_type", "=", options.entityType);
      }

      if (options.entityId !== undefined) {
        query = query.where("entity_id", "=", options.entityId);
      }

      if (options.requestId !== undefined) {
        query = query.where("request_id", "=", options.requestId);
      }

      if (options.limit !== undefined) {
        query = query.limit(options.limit);
      }

      if (options.offset !== undefined) {
        query = query.offset(options.offset);
      }

      return query.execute();
    },
  };
}

export { AUDIT_LOG_COLUMNS, normalizeAuditPayload };
