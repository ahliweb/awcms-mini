import test from "node:test";
import assert from "node:assert/strict";

import { createRateLimitCounterRepository } from "../../src/db/repositories/rate-limit-counters.mjs";

class FakeRateLimitCounterExecutor {
  constructor() {
    this.rows = [];
  }

  insertInto(table) {
    assert.equal(table, "rate_limit_counters");

    return {
      values: (values) => ({
        execute: async () => {
          this.rows.push({
            created_at: values.created_at ?? "2026-01-01T00:00:00.000Z",
            updated_at: values.updated_at ?? "2026-01-01T00:00:00.000Z",
            ...values,
          });
        },
      }),
    };
  }

  selectFrom(table) {
    assert.equal(table, "rate_limit_counters");
    const whereClauses = [];

    const apply = () => this.rows.filter((row) => whereClauses.every((clause) => {
      if (clause.operator === "=") {
        return row[clause.column] === clause.value;
      }

      return true;
    }));

    const query = {
      select: () => query,
      where: (column, operator, value) => {
        whereClauses.push({ column, operator, value });
        return query;
      },
      executeTakeFirst: async () => apply()[0],
    };

    return query;
  }

  updateTable(table) {
    assert.equal(table, "rate_limit_counters");
    const whereClauses = [];
    let values;

    const chain = {
      set(input) {
        values = input;
        return chain;
      },
      where(column, operator, value) {
        whereClauses.push({ column, operator, value });
        return chain;
      },
      execute: async () => {
        for (const row of this.rows) {
          if (whereClauses.every((clause) => row[clause.column] === clause.value)) {
            Object.assign(row, values);
          }
        }
      },
    };

    chain.execute = chain.execute.bind(this);
    return chain;
  }

  deleteFrom(table) {
    assert.equal(table, "rate_limit_counters");
    const whereClauses = [];

    const chain = {
      where(column, operator, value) {
        whereClauses.push({ column, operator, value });
        return chain;
      },
      execute: async () => {
        this.rows = this.rows.filter((row) => !whereClauses.every((clause) => {
          if (clause.operator === "=") {
            return row[clause.column] === clause.value;
          }

          if (clause.operator === "<=") {
            return String(row[clause.column]) <= String(clause.value);
          }

          return false;
        }));
      },
    };

    chain.execute = chain.execute.bind(this);
    return chain;
  }
}

test("rate limit counter repository upserts, reads, and deletes counters", async () => {
  const executor = new FakeRateLimitCounterExecutor();
  const repo = createRateLimitCounterRepository(executor);

  await repo.upsertCounter({
    scope_key: "account:user@example.com",
    counter: 2,
    window_starts_at: "2026-01-01T00:00:00.000Z",
    locked_until: null,
    expires_at: "2026-01-01T00:15:00.000Z",
  });

  const created = await repo.getCounter("account:user@example.com");
  assert.equal(created.counter, 2);

  await repo.upsertCounter({
    scope_key: "account:user@example.com",
    counter: 3,
    window_starts_at: "2026-01-01T00:00:00.000Z",
    locked_until: "2026-01-01T00:20:00.000Z",
    expires_at: "2026-01-01T00:20:00.000Z",
  });

  const updated = await repo.getCounter("account:user@example.com");
  assert.equal(updated.counter, 3);
  assert.equal(updated.locked_until, "2026-01-01T00:20:00.000Z");

  await repo.deleteExpiredCounters("2026-01-01T00:30:00.000Z");
  assert.equal(await repo.getCounter("account:user@example.com"), undefined);
});
