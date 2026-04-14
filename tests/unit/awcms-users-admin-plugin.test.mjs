import test from "node:test";
import assert from "node:assert/strict";

import {
  createPlugin,
  resetUserAdminDatabaseGetter,
  resetUserAdminServiceFactory,
  setUserAdminDatabaseGetter,
  setUserAdminServiceFactory,
} from "../../src/plugins/awcms-users-admin/index.mjs";

class FakeUsersQuery {
  constructor(rows) {
    this.rows = rows;
    this.limitValue = undefined;
    this.whereClauses = [];
  }

  leftJoin() {
    return this;
  }

  select() {
    return this;
  }

  where(column, operator, value) {
    this.whereClauses.push({ column, operator, value });
    return this;
  }

  orderBy() {
    return this;
  }

  groupBy() {
    return this;
  }

  limit(value) {
    this.limitValue = value;
    return this;
  }

  async execute() {
    return this.rows.filter((row) =>
      this.whereClauses.every((clause) => {
        if (clause.operator === "=") return row[clause.column.split(".").at(-1)] === clause.value;
        if (clause.operator === "is") return row[clause.column.split(".").at(-1)] === clause.value;
        return true;
      }),
    ).slice(0, this.limitValue ?? this.rows.length);
  }

  async executeTakeFirst() {
    return (await this.execute())[0];
  }
}

function createJoinBuilder() {
  return {
    onRef() {
      return this;
    },
    on() {
      return this;
    },
  };
}

function createFakeDb(rows) {
  return {
    selectFrom(table) {
      assert.equal(table, "users");
      const query = new FakeUsersQuery(rows);
      query.leftJoin = (tableName, callback) => {
        assert.ok(["user_profiles", "sessions"].includes(tableName));
        if (typeof callback === "function") {
          callback(createJoinBuilder());
        }
        return query;
      };
      return query;
    },
  };
}

test("awcms users admin plugin exposes admin pages and read-only routes", async () => {
  const plugin = createPlugin();
  const row = {
    id: "user_1",
    email: "user@example.com",
    username: "user1",
    display_name: "User One",
    status: "active",
    last_login_at: "2026-04-14T10:00:00.000Z",
    must_reset_password: false,
    is_protected: true,
    deleted_at: null,
    created_at: "2026-04-01T10:00:00.000Z",
    updated_at: "2026-04-10T10:00:00.000Z",
    profile_phone: "+1-555-0100",
    profile_timezone: "UTC",
    profile_locale: "en",
    profile_notes: "Admin user",
    profile_avatar_media_id: null,
    profile_created_at: "2026-04-01T10:00:00.000Z",
    profile_updated_at: "2026-04-10T10:00:00.000Z",
    active_session_count: 1,
  };
  const fakeDb = createFakeDb([row]);
  setUserAdminDatabaseGetter(() => fakeDb);

  try {
    assert.equal(plugin.id, "awcms-users-admin");
    assert.deepEqual(plugin.admin.pages, [
      { path: "/", label: "Users", icon: "users" },
      { path: "/user", label: "User Detail", icon: "user" },
    ]);

    const ctx = {
      request: new Request("http://example.test/_emdash/api/plugins/awcms-users-admin/users/list?limit=10"),
    };

    const listResult = await plugin.routes["users/list"].handler(ctx);
    assert.equal(listResult.items.length, 1);
    assert.equal(listResult.items[0].profile.locale, "en");

    const detailCtx = {
      request: new Request("http://example.test/_emdash/api/plugins/awcms-users-admin/users/detail?id=user_1"),
    };

    const detailResult = await plugin.routes["users/detail"].handler(detailCtx);
    assert.equal(detailResult.item.id, "user_1");
    assert.equal(detailResult.item.email, "user@example.com");
  } finally {
    resetUserAdminDatabaseGetter();
  }
});

test("awcms users admin plugin exposes invite route", async () => {
  const plugin = createPlugin();
  let capturedInput;

  setUserAdminServiceFactory(() => ({
    async createInvite(input) {
      capturedInput = input;
      return {
        user: { id: "user_invited", email: input.email },
        token: "token-id.secret",
        expires_at: "2026-04-22T10:00:00.000Z",
      };
    },
  }));

  try {
    const body = await plugin.routes["users/invite"].handler({
      request: new Request("http://example.test/_emdash/api/plugins/awcms-users-admin/users/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "invite@example.com", displayName: "Invite User" }),
      }),
    });

    assert.equal(capturedInput.email, "invite@example.com");
    assert.equal(capturedInput.display_name, "Invite User");
    assert.equal(body.invite.activationUrl, "http://example.test/activate?token=token-id.secret");
  } finally {
    resetUserAdminServiceFactory();
  }
});

test("awcms users admin plugin exposes lifecycle action routes", async () => {
  const plugin = createPlugin();
  const row = {
    id: "user_1",
    email: "user@example.com",
    username: "user1",
    display_name: "User One",
    status: "disabled",
    last_login_at: "2026-04-14T10:00:00.000Z",
    must_reset_password: false,
    is_protected: false,
    deleted_at: null,
    created_at: "2026-04-01T10:00:00.000Z",
    updated_at: "2026-04-10T10:00:00.000Z",
    profile_phone: null,
    profile_timezone: null,
    profile_locale: null,
    profile_notes: null,
    profile_avatar_media_id: null,
    profile_created_at: null,
    profile_updated_at: null,
    active_session_count: 0,
  };
  let disabledUserId;
  let lockedUserId;
  let revokedUserId;

  setUserAdminDatabaseGetter(() => ({
    selectFrom(table) {
      assert.equal(table, "users");
      const query = new FakeUsersQuery([row]);
      query.leftJoin = (tableName, callback) => {
        assert.ok(["user_profiles", "sessions"].includes(tableName));
        if (typeof callback === "function") {
          callback(createJoinBuilder());
        }
        return query;
      };
      query.select = () => query;
      query.groupBy = () => query;
      return query;
    },
  }));
  setUserAdminServiceFactory(() => ({
    async disableUser(userId) {
      disabledUserId = userId;
    },
    async lockUser(userId) {
      lockedUserId = userId;
    },
    async revokeUserSessions(userId) {
      revokedUserId = userId;
    },
  }));

  try {
    const disableBody = await plugin.routes["users/disable"].handler({
      request: new Request("http://example.test/_emdash/api/plugins/awcms-users-admin/users/disable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "user_1" }),
      }),
    });
    assert.equal(disabledUserId, "user_1");
    assert.equal(disableBody.item.id, "user_1");

    await plugin.routes["users/lock"].handler({
      request: new Request("http://example.test/_emdash/api/plugins/awcms-users-admin/users/lock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "user_1" }),
      }),
    });
    assert.equal(lockedUserId, "user_1");

    await plugin.routes["users/revoke-sessions"].handler({
      request: new Request("http://example.test/_emdash/api/plugins/awcms-users-admin/users/revoke-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "user_1" }),
      }),
    });
    assert.equal(revokedUserId, "user_1");
  } finally {
    resetUserAdminDatabaseGetter();
    resetUserAdminServiceFactory();
  }
});
