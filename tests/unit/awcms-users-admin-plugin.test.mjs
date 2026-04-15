import test from "node:test";
import assert from "node:assert/strict";

import {
  createPlugin,
  resetUserAdminAuthorizationServiceFactory,
  resetUserAdminDatabaseGetter,
  resetUserAdminServiceFactory,
  setUserAdminAuthorizationServiceFactory,
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

class FakeRolesQuery {
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
    return this.rows
      .filter((row) =>
        this.whereClauses.every((clause) => {
          if (clause.operator === "=") return row[clause.column.split(".").at(-1)] === clause.value;
          if (clause.operator === "is") return row[clause.column.split(".").at(-1)] === clause.value;
          return true;
        }),
      )
      .slice(0, this.limitValue ?? this.rows.length);
  }
}

class FakeMatrixQuery {
  constructor(rows) {
    this.rows = rows;
    this.whereClauses = [];
    this.limitValue = undefined;
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
    return this.rows
      .filter((row) =>
        this.whereClauses.every((clause) => {
          const key = clause.column.split(".").at(-1);
          if (clause.operator === "=") return row[key] === clause.value;
          if (clause.operator === "is") return row[key] === clause.value;
          return true;
        }),
      )
      .slice(0, this.limitValue ?? this.rows.length);
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

function createAllowingAuthorizationFactory(calls = []) {
  return () => ({
    async evaluate(input) {
      calls.push(input);
      return {
        allowed: true,
        reason: { code: "ALLOW_RBAC_PERMISSION", message: "allowed" },
      };
    },
  });
}

function createAdminHeaders(extra = {}) {
  return {
    "x-actor-user-id": "admin_actor",
    ...extra,
  };
}

function createAdminActorRow() {
  return {
    id: "admin_actor",
    email: "admin@example.com",
    username: "admin",
    display_name: "Admin Actor",
    status: "active",
    last_login_at: "2026-04-14T09:00:00.000Z",
    must_reset_password: false,
    is_protected: false,
    deleted_at: null,
    created_at: "2026-04-01T09:00:00.000Z",
    updated_at: "2026-04-10T09:00:00.000Z",
    profile_phone: null,
    profile_timezone: null,
    profile_locale: null,
    profile_notes: null,
    profile_avatar_media_id: null,
    profile_created_at: null,
    profile_updated_at: null,
    active_session_count: 1,
    active_role_staff_level: 9,
  };
}

function createFakeDb(rows) {
  return {
    selectFrom(table) {
      assert.equal(table, "users");
      const query = new FakeUsersQuery(rows);
      query.leftJoin = (tableName, callback) => {
        assert.ok(["user_profiles", "user_roles", "roles", "sessions"].includes(tableName));
        if (typeof callback === "function") {
          callback(createJoinBuilder());
        }
        return query;
      };
      return query;
    },
  };
}

function createFakeRolesDb(rows) {
  return {
    selectFrom(table) {
      if (table === "users") {
        const query = new FakeUsersQuery([createAdminActorRow()]);
        query.leftJoin = (tableName, callback) => {
          assert.ok(["user_profiles", "user_roles", "roles", "sessions"].includes(tableName));
          if (typeof callback === "function") {
            callback(createJoinBuilder());
          }
          return query;
        };
        return query;
      }

      assert.equal(table, "roles");
      const query = new FakeRolesQuery(rows);
      query.leftJoin = (tableName, callback) => {
        assert.equal(tableName, "user_roles");
        if (typeof callback === "function") {
          callback(createJoinBuilder());
        }
        return query;
      };
      return query;
    },
  };
}

function createFakeMatrixDb({ roles, permissions, rolePermissions }) {
  const state = {
    users: [createAdminActorRow()],
    roles: [...roles],
    permissions: [...permissions],
    role_permissions: [...rolePermissions],
  };

  return {
    state,
    selectFrom(table) {
      if (table === "users") {
        const query = new FakeUsersQuery(state.users);
        query.leftJoin = (tableName, callback) => {
          assert.ok(["user_profiles", "user_roles", "roles", "sessions"].includes(tableName));
          if (typeof callback === "function") {
            callback(createJoinBuilder());
          }
          return query;
        };
        return query;
      }

      assert.ok(["roles", "permissions", "role_permissions"].includes(table));
      return new FakeMatrixQuery(state[table]);
    },
    insertInto(table) {
      assert.equal(table, "role_permissions");
      return {
        values: (values) => ({
          execute: async () => {
            state.role_permissions.push({
              granted_by_user_id: values.granted_by_user_id ?? null,
              granted_at: values.granted_at ?? "2026-04-10T10:00:00.000Z",
              ...values,
            });
          },
        }),
      };
    },
    deleteFrom(table) {
      assert.equal(table, "role_permissions");
      const whereClauses = [];
      const chain = {
        where(column, operator, value) {
          whereClauses.push({ column, operator, value });
          return chain;
        },
        execute: async () => {
          for (let index = state.role_permissions.length - 1; index >= 0; index -= 1) {
            const row = state.role_permissions[index];
            const matches = whereClauses.every((clause) => row[clause.column] === clause.value);
            if (matches) {
              state.role_permissions.splice(index, 1);
            }
          }
        },
      };
      return chain;
    },
  };
}

test("awcms users admin plugin exposes admin pages and read-only routes", async () => {
  const plugin = createPlugin();
  const authorizationCalls = [];
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
    active_role_staff_level: 5,
  };
  const fakeDb = createFakeDb([row]);
  setUserAdminDatabaseGetter(() => fakeDb);
  setUserAdminAuthorizationServiceFactory(createAllowingAuthorizationFactory(authorizationCalls));

  try {
    assert.equal(plugin.id, "awcms-users-admin");
    assert.deepEqual(plugin.admin.pages, [
      { path: "/", label: "Users", icon: "users" },
      { path: "/roles", label: "Roles", icon: "shield" },
      { path: "/permissions", label: "Permission Matrix", icon: "grid" },
      { path: "/user", label: "User Detail", icon: "user" },
    ]);

    const ctx = {
      request: new Request("http://example.test/_emdash/api/plugins/awcms-users-admin/users/list?limit=10", {
        headers: createAdminHeaders({ "x-actor-user-id": "user_1" }),
      }),
    };

    const listResult = await plugin.routes["users/list"].handler(ctx);
    assert.equal(listResult.items.length, 1);
    assert.equal(listResult.items[0].profile.locale, "en");

    const detailCtx = {
      request: new Request("http://example.test/_emdash/api/plugins/awcms-users-admin/users/detail?id=user_1", {
        headers: createAdminHeaders({ "x-actor-user-id": "user_1" }),
      }),
    };

    const detailResult = await plugin.routes["users/detail"].handler(detailCtx);
    assert.equal(detailResult.item.id, "user_1");
    assert.equal(detailResult.item.email, "user@example.com");
    assert.equal(authorizationCalls.length, 2);
    assert.equal(authorizationCalls[0].context.permission_code, "admin.users.read");
  } finally {
    resetUserAdminDatabaseGetter();
    resetUserAdminAuthorizationServiceFactory();
  }
});

test("awcms users admin plugin exposes permission matrix routes and applies staged changes", async () => {
  const plugin = createPlugin();
  const authorizationCalls = [];
  const fakeDb = createFakeMatrixDb({
    roles: [
      { id: "role_owner", slug: "owner", name: "Owner", staff_level: 10, is_assignable: false, is_protected: true, deleted_at: null },
      { id: "role_editor", slug: "editor", name: "Editor", staff_level: 6, is_assignable: true, is_protected: false, deleted_at: null },
    ],
    permissions: [
      { id: "perm_admin_roles_assign", code: "admin.roles.assign", domain: "admin", resource: "roles", action: "assign", description: "Assign roles", is_protected: true },
      { id: "perm_content_posts_read", code: "content.posts.read", domain: "content", resource: "posts", action: "read", description: "Read posts", is_protected: false },
    ],
    rolePermissions: [
      { role_id: "role_owner", permission_id: "perm_admin_roles_assign", granted_by_user_id: null, granted_at: "2026-04-10T10:00:00.000Z" },
      { role_id: "role_editor", permission_id: "perm_content_posts_read", granted_by_user_id: null, granted_at: "2026-04-10T10:00:00.000Z" },
    ],
  });
  setUserAdminDatabaseGetter(() => fakeDb);
  setUserAdminAuthorizationServiceFactory(createAllowingAuthorizationFactory(authorizationCalls));

  try {
    const snapshot = await plugin.routes["permissions/matrix"].handler({
      request: new Request("http://example.test/_emdash/api/plugins/awcms-users-admin/permissions/matrix", { headers: createAdminHeaders() }),
    });

    assert.deepEqual(snapshot.roles.map((role) => role.slug), ["owner", "editor"]);
    assert.equal(snapshot.rows[0].grantsByRoleId.role_owner, true);
    assert.equal(snapshot.rows[1].grantsByRoleId.role_editor, true);

    await assert.rejects(
      () =>
        plugin.routes["permissions/matrix/apply"].handler({
          request: new Request("http://example.test/_emdash/api/plugins/awcms-users-admin/permissions/matrix/apply", {
            method: "POST",
            headers: { ...createAdminHeaders(), "Content-Type": "application/json" },
            body: JSON.stringify({
              rolePermissionIdsByRoleId: {
                role_owner: [],
                role_editor: ["perm_content_posts_read"],
              },
            }),
          }),
        }),
    );

    await assert.rejects(
      () =>
        plugin.routes["permissions/matrix/apply"].handler({
          request: new Request("http://example.test/_emdash/api/plugins/awcms-users-admin/permissions/matrix/apply", {
            method: "POST",
            headers: { ...createAdminHeaders(), "Content-Type": "application/json" },
            body: JSON.stringify({
              rolePermissionIdsByRoleId: {
                role_owner: ["perm_content_posts_read"],
                role_editor: ["perm_content_posts_read"],
              },
              confirmProtectedChanges: true,
            }),
          }),
        }),
    );

    const applied = await plugin.routes["permissions/matrix/apply"].handler({
      request: new Request("http://example.test/_emdash/api/plugins/awcms-users-admin/permissions/matrix/apply", {
        method: "POST",
        headers: { ...createAdminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          rolePermissionIdsByRoleId: {
            role_owner: ["perm_admin_roles_assign", "perm_content_posts_read"],
            role_editor: ["perm_content_posts_read"],
          },
          confirmProtectedChanges: true,
          elevatedFlowConfirmed: true,
        }),
      }),
    });

    assert.equal(applied.applied, true);
    assert.equal(applied.snapshot.rows[1].grantsByRoleId.role_owner, true);
    assert.equal(fakeDb.state.role_permissions.some((entry) => entry.role_id === "role_owner" && entry.permission_id === "perm_content_posts_read"), true);
    assert.equal(authorizationCalls[0].context.permission_code, "admin.permissions.read");
    assert.equal(authorizationCalls.at(-1).context.permission_code, "admin.permissions.update");
  } finally {
    resetUserAdminDatabaseGetter();
    resetUserAdminAuthorizationServiceFactory();
  }
});

test("awcms users admin plugin exposes roles route with protection and staff level data", async () => {
  const plugin = createPlugin();
  const authorizationCalls = [];
  const fakeDb = createFakeRolesDb([
    {
      id: "role_owner",
      slug: "owner",
      name: "Owner",
      description: "Emergency control",
      staff_level: 10,
      is_system: true,
      is_assignable: false,
      is_protected: true,
      deleted_at: null,
      created_at: "2026-04-01T10:00:00.000Z",
      updated_at: "2026-04-10T10:00:00.000Z",
      active_assignment_count: 1,
    },
    {
      id: "role_editor",
      slug: "editor",
      name: "Editor",
      description: "Editorial management",
      staff_level: 6,
      is_system: true,
      is_assignable: true,
      is_protected: false,
      deleted_at: null,
      created_at: "2026-04-02T10:00:00.000Z",
      updated_at: "2026-04-10T10:00:00.000Z",
      active_assignment_count: 4,
    },
  ]);
  setUserAdminDatabaseGetter(() => fakeDb);
  setUserAdminAuthorizationServiceFactory(createAllowingAuthorizationFactory(authorizationCalls));

  try {
    const body = await plugin.routes["roles/list"].handler({
      request: new Request("http://example.test/_emdash/api/plugins/awcms-users-admin/roles/list?limit=10", { headers: createAdminHeaders() }),
    });

    assert.equal(body.items.length, 2);
    assert.deepEqual(body.items[0], {
      id: "role_owner",
      slug: "owner",
      name: "Owner",
      description: "Emergency control",
      staffLevel: 10,
      isSystem: true,
      isAssignable: false,
      isProtected: true,
      deletedAt: null,
      createdAt: "2026-04-01T10:00:00.000Z",
      updatedAt: "2026-04-10T10:00:00.000Z",
      activeAssignmentCount: 1,
    });
    assert.equal(body.items[1].staffLevel, 6);
    assert.equal(body.items[1].isProtected, false);
    assert.equal(authorizationCalls[0].context.permission_code, "admin.roles.read");
  } finally {
    resetUserAdminDatabaseGetter();
    resetUserAdminAuthorizationServiceFactory();
  }
});

test("awcms users admin plugin exposes invite route", async () => {
  const plugin = createPlugin();
  let capturedInput;

  setUserAdminDatabaseGetter(() => createFakeDb([createAdminActorRow()]));
  setUserAdminAuthorizationServiceFactory(createAllowingAuthorizationFactory());
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
        headers: { ...createAdminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ email: "invite@example.com", displayName: "Invite User" }),
      }),
    });

    assert.equal(capturedInput.email, "invite@example.com");
    assert.equal(capturedInput.display_name, "Invite User");
    assert.equal(body.invite.activationUrl, "http://example.test/activate?token=token-id.secret");
  } finally {
    resetUserAdminDatabaseGetter();
    resetUserAdminServiceFactory();
    resetUserAdminAuthorizationServiceFactory();
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
    active_role_staff_level: 5,
  };
  let disabledUserId;
  let lockedUserId;
  let revokedUserId;

  setUserAdminDatabaseGetter(() => ({
    selectFrom(table) {
      assert.equal(table, "users");
      const query = new FakeUsersQuery([createAdminActorRow(), row]);
      query.leftJoin = (tableName, callback) => {
        assert.ok(["user_profiles", "user_roles", "roles", "sessions"].includes(tableName));
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
  setUserAdminAuthorizationServiceFactory(createAllowingAuthorizationFactory());
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
        headers: { ...createAdminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "user_1" }),
      }),
    });
    assert.equal(disabledUserId, "user_1");
    assert.equal(disableBody.item.id, "user_1");

    await plugin.routes["users/lock"].handler({
      request: new Request("http://example.test/_emdash/api/plugins/awcms-users-admin/users/lock", {
        method: "POST",
        headers: { ...createAdminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "user_1" }),
      }),
    });
    assert.equal(lockedUserId, "user_1");

    await plugin.routes["users/revoke-sessions"].handler({
      request: new Request("http://example.test/_emdash/api/plugins/awcms-users-admin/users/revoke-sessions", {
        method: "POST",
        headers: { ...createAdminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "user_1" }),
      }),
    });
    assert.equal(revokedUserId, "user_1");
  } finally {
    resetUserAdminDatabaseGetter();
    resetUserAdminServiceFactory();
    resetUserAdminAuthorizationServiceFactory();
  }
});

test("awcms users admin plugin fails unauthorized admin requests consistently", async () => {
  const plugin = createPlugin();
  const db = createFakeDb([createAdminActorRow()]);

  setUserAdminDatabaseGetter(() => db);
  setUserAdminAuthorizationServiceFactory(() => ({
    async evaluate() {
      return {
        allowed: false,
        reason: { code: "DENY_PERMISSION_MISSING", message: "denied" },
      };
    },
  }));

  try {
    await assert.rejects(
      () =>
        plugin.routes["users/list"].handler({
          request: new Request("http://example.test/_emdash/api/plugins/awcms-users-admin/users/list", {
            headers: createAdminHeaders(),
          }),
        }),
      (error) => error instanceof Error && error.message.includes("DENY_PERMISSION_MISSING"),
    );
  } finally {
    resetUserAdminDatabaseGetter();
    resetUserAdminAuthorizationServiceFactory();
  }
});
