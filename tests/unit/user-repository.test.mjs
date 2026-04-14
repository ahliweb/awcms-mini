import test from "node:test";
import assert from "node:assert/strict";

import { buildUserPatch, createUserRepository } from "../../src/db/repositories/users.mjs";

class FakeExecutor {
  constructor() {
    this.users = [];
  }

  insertInto(table) {
    assert.equal(table, "users");

    return {
      values: (values) => ({
        execute: async () => {
          this.users.push({
            created_at: values.created_at ?? "2026-01-01T00:00:00.000Z",
            updated_at: values.updated_at ?? "2026-01-01T00:00:00.000Z",
            ...values,
          });
        },
      }),
    };
  }

  selectFrom(table) {
    assert.equal(table, "users");

    const state = {
      where: [],
      limit: undefined,
      offset: undefined,
    };

    const apply = () => {
      let rows = [...this.users];

      for (const clause of state.where) {
        rows = rows.filter((row) => row[clause.column] === clause.value);
      }

      rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(a.email).localeCompare(String(b.email)));

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

  updateTable(table) {
    assert.equal(table, "users");

    const state = {
      values: undefined,
      where: undefined,
    };

    return {
      set: (values) => {
        state.values = values;
        return {
          where: (column, operator, value) => {
            assert.equal(operator, "=");
            state.where = { column, value };

            return {
              execute: async () => {
                for (const row of this.users) {
                  if (row[column] === value) {
                    for (const [key, nextValue] of Object.entries(state.values)) {
                      row[key] = typeof nextValue === "object" ? "2026-01-02T00:00:00.000Z" : nextValue;
                    }
                  }
                }
              },
            };
          },
        };
      },
    };
  }
}

test("buildUserPatch filters unsupported fields and adds updated_at", () => {
  const patch = buildUserPatch({
    display_name: "Updated",
    status: "disabled",
    random: "ignored",
  });

  assert.equal(patch.display_name, "Updated");
  assert.equal(Object.hasOwn(patch, "status"), false);
  assert.equal(Object.hasOwn(patch, "random"), false);
  assert.equal(Object.hasOwn(patch, "updated_at"), true);
});

test("user repository supports create/get/list/update/status change", async () => {
  const executor = new FakeExecutor();
  const repo = createUserRepository(executor);

  const created = await repo.createUser({
    id: "user_1",
    email: "user@example.com",
    username: "user1",
    display_name: "User One",
    password_hash: "hash",
    must_reset_password: true,
  });

  assert.equal(created.id, "user_1");
  assert.equal(created.email, "user@example.com");
  assert.equal(created.must_reset_password, true);
  assert.equal(created.is_protected, false);
  assert.equal(created.status, "invited");

  const byEmail = await repo.getUserByEmail("user@example.com");
  assert.equal(byEmail.id, "user_1");

  const updated = await repo.updateUser("user_1", {
    display_name: "User One Updated",
    status: "disabled",
  });

  assert.equal(updated.display_name, "User One Updated");
  assert.equal(updated.status, "invited");

  const statusChanged = await repo.changeUserStatus("user_1", "disabled");
  assert.equal(statusChanged.status, "disabled");

  await repo.createUser({
    id: "user_2",
    email: "admin@example.com",
    status: "active",
  });

  const activeUsers = await repo.listUsers({ status: "active" });
  assert.equal(activeUsers.length, 1);
  assert.equal(activeUsers[0].email, "admin@example.com");
});

test("user repository works with injected transaction executors", async () => {
  const executor = new FakeExecutor();
  const repo = createUserRepository(executor);

  await repo.createUser({
    id: "user_trx",
    email: "trx@example.com",
  });

  const listed = await repo.listUsers();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, "user_trx");
});
