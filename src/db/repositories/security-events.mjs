import { getDatabase } from "../index.mjs";

const SECURITY_EVENT_COLUMNS = [
  "id",
  "user_id",
  "event_type",
  "severity",
  "details_json",
  "ip_address",
  "user_agent",
  "occurred_at",
];

function baseSecurityEventQuery(executor) {
  return executor.selectFrom("security_events").select(SECURITY_EVENT_COLUMNS);
}

export function createSecurityEventRepository(executor = getDatabase()) {
  return {
    async appendEvent(input) {
      await executor.insertInto("security_events").values({
        id: input.id,
        user_id: input.user_id ?? null,
        event_type: input.event_type,
        severity: input.severity,
        details_json: input.details_json ?? {},
        ip_address: input.ip_address ?? null,
        user_agent: input.user_agent ?? null,
        occurred_at: input.occurred_at ?? undefined,
      }).execute();

      return this.getEventById(input.id);
    },

    async getEventById(id) {
      return baseSecurityEventQuery(executor).where("id", "=", id).executeTakeFirst();
    },
  };
}

export { SECURITY_EVENT_COLUMNS };
