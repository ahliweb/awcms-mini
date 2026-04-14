import { getDatabase } from "../index.mjs";

const LOGIN_SECURITY_EVENT_COLUMNS = [
  "id",
  "user_id",
  "email_attempted",
  "event_type",
  "outcome",
  "reason",
  "ip_address",
  "user_agent",
  "occurred_at",
];

function baseLoginSecurityEventQuery(executor) {
  return executor.selectFrom("login_security_events").select(LOGIN_SECURITY_EVENT_COLUMNS);
}

export function createLoginSecurityEventRepository(executor = getDatabase()) {
  return {
    async appendEvent(input) {
      await executor
        .insertInto("login_security_events")
        .values({
          id: input.id,
          user_id: input.user_id ?? null,
          email_attempted: input.email_attempted ?? null,
          event_type: input.event_type,
          outcome: input.outcome,
          reason: input.reason ?? null,
          ip_address: input.ip_address ?? null,
          user_agent: input.user_agent ?? null,
          occurred_at: input.occurred_at ?? undefined,
        })
        .execute();

      return this.getEventById(input.id);
    },

    async getEventById(id) {
      return baseLoginSecurityEventQuery(executor).where("id", "=", id).executeTakeFirst();
    },

    async listEvents(options = {}) {
      let query = baseLoginSecurityEventQuery(executor)
        .orderBy("occurred_at", "desc")
        .orderBy("id", "asc");

      if (options.userId !== undefined) {
        query = query.where("user_id", "=", options.userId);
      }

      if (options.emailAttempted !== undefined) {
        query = query.where("email_attempted", "=", options.emailAttempted);
      }

      if (options.eventType !== undefined) {
        query = query.where("event_type", "=", options.eventType);
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

export { LOGIN_SECURITY_EVENT_COLUMNS };
