import { getDatabase } from "../index.mjs";

const RATE_LIMIT_COUNTER_COLUMNS = [
  "scope_key",
  "counter",
  "window_starts_at",
  "locked_until",
  "expires_at",
  "created_at",
  "updated_at",
];

function baseRateLimitCounterQuery(executor) {
  return executor.selectFrom("rate_limit_counters").select(RATE_LIMIT_COUNTER_COLUMNS);
}

export function createRateLimitCounterRepository(executor = getDatabase()) {
  return {
    async getCounter(scopeKey) {
      return baseRateLimitCounterQuery(executor)
        .where("scope_key", "=", scopeKey)
        .executeTakeFirst();
    },

    async upsertCounter(input) {
      const existing = await this.getCounter(input.scope_key);

      if (existing) {
        await executor
          .updateTable("rate_limit_counters")
          .set({
            counter: input.counter,
            window_starts_at: input.window_starts_at,
            locked_until: input.locked_until ?? null,
            expires_at: input.expires_at,
            updated_at: input.updated_at ?? input.expires_at,
          })
          .where("scope_key", "=", input.scope_key)
          .execute();

        return this.getCounter(input.scope_key);
      }

      await executor
        .insertInto("rate_limit_counters")
        .values({
          scope_key: input.scope_key,
          counter: input.counter,
          window_starts_at: input.window_starts_at,
          locked_until: input.locked_until ?? null,
          expires_at: input.expires_at,
          created_at: input.created_at ?? input.window_starts_at,
          updated_at: input.updated_at ?? input.expires_at,
        })
        .execute();

      return this.getCounter(input.scope_key);
    },

    async deleteCounter(scopeKey) {
      await executor.deleteFrom("rate_limit_counters").where("scope_key", "=", scopeKey).execute();
    },

    async deleteExpiredCounters(expiresBefore) {
      await executor.deleteFrom("rate_limit_counters").where("expires_at", "<=", expiresBefore).execute();
    },
  };
}

export { RATE_LIMIT_COUNTER_COLUMNS };
