import test from "node:test";
import assert from "node:assert/strict";

import { createAuditLogRepository, normalizeAuditPayload } from "../../src/db/repositories/audit-logs.mjs";

class FakeAuditLogExecutor {
  constructor() {
    this.audit_logs = [];
  }

  insertInto(table) {
    assert.equal(table, "audit_logs");

    return {
      values: (values) => ({
        execute: async () => {
          this.audit_logs.push({
            occurred_at: values.occurred_at ?? "2026-01-01T00:00:00.000Z",
            metadata: values.metadata ?? {},
            before_payload: values.before_payload ?? null,
            after_payload: values.after_payload ?? null,
            ...values,
          });
        },
      }),
    };
  }

  selectFrom(table) {
    assert.equal(table, "audit_logs");
    const state = { where: [], orderBy: [], limit: undefined, offset: undefined };

    const apply = () => {
      let rows = [...this.audit_logs];

      for (const clause of state.where) {
        rows = rows.filter((row) => row[clause.column] === clause.value);
      }

      rows.sort((left, right) => {
        for (const clause of state.orderBy) {
          const leftValue = String(left[clause.column] ?? "");
          const rightValue = String(right[clause.column] ?? "");
          const comparison = leftValue.localeCompare(rightValue);
          if (comparison !== 0) {
            return clause.direction === "desc" ? -comparison : comparison;
          }
        }
        return 0;
      });

      if (state.offset !== undefined) rows = rows.slice(state.offset);
      if (state.limit !== undefined) rows = rows.slice(0, state.limit);
      return rows;
    };

    const query = {
      select: () => query,
      where: (column, operator, value) => {
        assert.equal(operator, "=");
        state.where.push({ column, value });
        return query;
      },
      orderBy: (column, direction = "asc") => {
        state.orderBy.push({ column, direction });
        return query;
      },
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

test("normalizeAuditPayload returns object inputs and defaults invalid values", () => {
  assert.deepEqual(normalizeAuditPayload({ ok: true }), { ok: true });
  assert.deepEqual(normalizeAuditPayload(null), {});
  assert.deepEqual(normalizeAuditPayload(["bad"]), {});
});

test("audit log repository appends and reads audit records", async () => {
  const executor = new FakeAuditLogExecutor();
  const repo = createAuditLogRepository(executor);

  const created = await repo.appendLog({
    id: "audit_1",
    actor_user_id: "admin_1",
    action: "user.disable",
    entity_type: "user",
    entity_id: "user_1",
    target_user_id: "user_1",
    summary: "Disabled user account",
    before_payload: { status: "active" },
    after_payload: { status: "disabled" },
    metadata: { source: "admin" },
  });

  assert.equal(created.id, "audit_1");
  assert.equal(created.action, "user.disable");
  assert.deepEqual(created.before_payload, { status: "active" });
  assert.deepEqual(created.after_payload, { status: "disabled" });
  assert.deepEqual(created.metadata, { source: "admin" });
});

test("audit log repository supports actor, target, action, entity, and request filters", async () => {
  const executor = new FakeAuditLogExecutor();
  const repo = createAuditLogRepository(executor);

  await repo.appendLog({
    id: "audit_1",
    actor_user_id: "admin_1",
    action: "user.disable",
    entity_type: "user",
    entity_id: "user_1",
    target_user_id: "user_1",
    request_id: "req_1",
    occurred_at: "2026-01-01T00:00:00.000Z",
  });
  await repo.appendLog({
    id: "audit_2",
    actor_user_id: "admin_2",
    action: "roles.assign",
    entity_type: "role_assignment",
    entity_id: "assign_1",
    target_user_id: "user_2",
    request_id: "req_2",
    occurred_at: "2026-01-02T00:00:00.000Z",
  });
  await repo.appendLog({
    id: "audit_3",
    actor_user_id: "admin_1",
    action: "user.disable",
    entity_type: "user",
    entity_id: "user_3",
    target_user_id: "user_3",
    request_id: "req_3",
    occurred_at: "2026-01-03T00:00:00.000Z",
  });

  assert.deepEqual((await repo.listLogs({ actorUserId: "admin_1" })).map((row) => row.id), ["audit_3", "audit_1"]);
  assert.deepEqual((await repo.listLogs({ targetUserId: "user_2" })).map((row) => row.id), ["audit_2"]);
  assert.deepEqual((await repo.listLogs({ action: "user.disable" })).map((row) => row.id), ["audit_3", "audit_1"]);
  assert.deepEqual((await repo.listLogs({ entityType: "user", entityId: "user_1" })).map((row) => row.id), ["audit_1"]);
  assert.deepEqual((await repo.listLogs({ requestId: "req_3" })).map((row) => row.id), ["audit_3"]);
});
