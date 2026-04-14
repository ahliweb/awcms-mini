import test from "node:test";
import assert from "node:assert/strict";

import { createLoginSecurityEventRepository } from "../../src/db/repositories/login-security-events.mjs";

class FakeLoginSecurityEventExecutor {
  constructor() {
    this.events = [];
  }

  insertInto(table) {
    assert.equal(table, "login_security_events");

    return {
      values: (values) => ({
        execute: async () => {
          this.events.push({
            occurred_at: values.occurred_at ?? "2026-01-01T00:00:00.000Z",
            ...values,
          });
        },
      }),
    };
  }

  selectFrom(table) {
    assert.equal(table, "login_security_events");

    const state = {
      where: [],
      limit: undefined,
      offset: undefined,
    };

    const apply = () => {
      let rows = [...this.events];

      for (const clause of state.where) {
        rows = rows.filter((row) => row[clause.column] === clause.value);
      }

      rows.sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)) || String(a.id).localeCompare(String(b.id)));

      if (state.offset !== undefined) {
        rows = rows.slice(state.offset);
      }

      if (state.limit !== undefined) {
        rows = rows.slice(0, state.limit);
      }

      return rows;
    };

    const query = {
      select: () => query,
      where: (column, operator, value) => {
        assert.equal(operator, "=");
        state.where.push({ column, value });
        return query;
      },
      orderBy: () => query,
      limit: (limit) => {
        state.limit = limit;
        return query;
      },
      offset: (offset) => {
        state.offset = offset;
        return query;
      },
      execute: async () => apply(),
      executeTakeFirst: async () => apply()[0],
    };

    return query;
  }
}

test("login security event repository appends and fetches user-linked events", async () => {
  const executor = new FakeLoginSecurityEventExecutor();
  const repo = createLoginSecurityEventRepository(executor);

  const created = await repo.appendEvent({
    id: "event_1",
    user_id: "user_1",
    email_attempted: "user@example.com",
    event_type: "login_attempt",
    outcome: "success",
    reason: "password accepted",
    ip_address: "127.0.0.1",
  });

  assert.equal(created.id, "event_1");
  assert.equal(created.user_id, "user_1");
  assert.equal(created.event_type, "login_attempt");
  assert.equal(created.outcome, "success");
});

test("login security event repository supports anonymous attempts and list filters", async () => {
  const executor = new FakeLoginSecurityEventExecutor();
  const repo = createLoginSecurityEventRepository(executor);

  await repo.appendEvent({
    id: "event_1",
    email_attempted: "anon@example.com",
    event_type: "login_attempt",
    outcome: "failure",
    occurred_at: "2026-01-01T00:00:00.000Z",
  });

  await repo.appendEvent({
    id: "event_2",
    user_id: "user_1",
    email_attempted: "user@example.com",
    event_type: "login_attempt",
    outcome: "success",
    occurred_at: "2026-01-02T00:00:00.000Z",
  });

  await repo.appendEvent({
    id: "event_3",
    user_id: "user_1",
    email_attempted: "user@example.com",
    event_type: "step_up",
    outcome: "failure",
    occurred_at: "2026-01-03T00:00:00.000Z",
  });

  const userEvents = await repo.listEvents({ userId: "user_1" });
  assert.equal(userEvents.length, 2);

  const loginAttemptEvents = await repo.listEvents({ eventType: "login_attempt" });
  assert.equal(loginAttemptEvents.length, 2);

  const anonymousAttempts = await repo.listEvents({ emailAttempted: "anon@example.com" });
  assert.equal(anonymousAttempts.length, 1);
  assert.equal(anonymousAttempts[0].user_id, null);
});
