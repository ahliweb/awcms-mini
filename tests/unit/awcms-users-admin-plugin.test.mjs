import test from "node:test";
import assert from "node:assert/strict";

import {
  awcmsUsersAdminPlugin,
  createPlugin,
  USER_ADMIN_PLUGIN_PERMISSIONS,
  resetUserAdminAuditServiceFactory,
  resetUserAdminAuthorizationServiceFactory,
  resetUserAdminAdministrativeRegionAssignmentServiceFactory,
  resetUserAdminAdminTwoFactorServiceFactory,
  resetUserAdminDatabaseGetter,
  resetUserAdminRegionAssignmentServiceFactory,
  resetUserAdminJobsServiceFactory,
  resetUserAdminRoleAssignmentServiceFactory,
  resetUserAdminRbacServiceFactory,
  resetUserAdminRegionServiceFactory,
  resetUserAdminSessionServiceFactory,
  resetUserAdminServiceFactory,
  setUserAdminAuthorizationServiceFactory,
  setUserAdminAdministrativeRegionAssignmentServiceFactory,
  setUserAdminAdminTwoFactorServiceFactory,
  setUserAdminAuditServiceFactory,
  setUserAdminDatabaseGetter,
  setUserAdminRegionAssignmentServiceFactory,
  setUserAdminJobsServiceFactory,
  setUserAdminRoleAssignmentServiceFactory,
  setUserAdminRbacServiceFactory,
  setUserAdminRegionServiceFactory,
  setUserAdminSessionServiceFactory,
  setUserAdminServiceFactory,
} from "../../src/plugins/awcms-users-admin/index.mjs";
import { resetSecurityPolicy } from "../../src/security/policy.mjs";

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

class FakeSimpleQuery {
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

  offset() {
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

function createFakeJobsDb({ levels, titles }) {
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

      if (table === "job_levels") {
        const query = new FakeSimpleQuery(levels);
        query.leftJoin = (tableName, callback) => {
          assert.equal(tableName, "job_titles");
          if (typeof callback === "function") {
            callback(createJoinBuilder());
          }
          return query;
        };
        return query;
      }

      if (table === "user_jobs") {
        return new FakeSimpleQuery([]);
      }

      assert.equal(table, "job_titles");
      return new FakeSimpleQuery(titles);
    },
  };
}

function createFakeUserJobsDb({ users, levels, titles, assignments }) {
  return {
    selectFrom(table) {
      if (table === "users") {
        const query = new FakeUsersQuery(users);
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
      }

      if (table === "job_levels") {
        return new FakeSimpleQuery(levels);
      }

      if (table === "job_titles") {
        return new FakeSimpleQuery(titles);
      }

      assert.equal(table, "user_jobs");
      return new FakeSimpleQuery(assignments);
    },
  };
}

function createFakeUserRolesDb({ users, roles, assignments }) {
  return {
    selectFrom(table) {
      if (table === "users") {
        const query = new FakeUsersQuery(users);
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
      }

      if (table === "roles") {
        return new FakeSimpleQuery(roles);
      }

      assert.equal(table, "user_roles");
      return new FakeSimpleQuery(assignments);
    },
  };
}

function createFakeUserSessionsDb({ users, sessions, loginEvents }) {
  return {
    selectFrom(table) {
      if (table === "users") {
        const query = new FakeUsersQuery(users);
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
      }

      if (table === "sessions") {
        return new FakeSimpleQuery(sessions);
      }

      assert.equal(table, "login_security_events");
      return new FakeSimpleQuery(loginEvents);
    },
  };
}

function createFakeRegionsDb({ users, regions }) {
  return {
    selectFrom(table) {
      if (table === "users") {
        const query = new FakeUsersQuery(users);
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
      }

      assert.equal(table, "regions");
      return new FakeSimpleQuery(regions);
    },
  };
}

function createFakeAdministrativeRegionsDb({ users, regions }) {
  return {
    selectFrom(table) {
      if (table === "users") {
        const query = new FakeUsersQuery(users);
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
      }

      assert.equal(table, "administrative_regions");
      return new FakeSimpleQuery(regions);
    },
  };
}

function createFakeUserRegionsDb({ users, regions, assignments }) {
  return {
    selectFrom(table) {
      if (table === "users") {
        const query = new FakeUsersQuery(users);
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
      }

      if (table === "regions") {
        return new FakeSimpleQuery(regions);
      }

      assert.equal(table, "user_region_assignments");
      return new FakeSimpleQuery(assignments);
    },
  };
}

function createFakeUserAdministrativeRegionsDb({ users, regions, assignments }) {
  return {
    selectFrom(table) {
      if (table === "users") {
        const query = new FakeUsersQuery(users);
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
      }

      if (table === "administrative_regions") {
        return new FakeSimpleQuery(regions);
      }

      assert.equal(table, "user_administrative_region_assignments");
      return new FakeSimpleQuery(assignments);
    },
  };
}

function createFakeAuditLogsDb({ users, logs }) {
  const executor = {
    selectFrom(table) {
      if (table === "users") {
        const query = new FakeUsersQuery(users);
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
      }

      assert.equal(table, "audit_logs");
      return new FakeSimpleQuery(logs);
    },
    startTransaction() {
      return {
        execute: async () => ({
          ...executor,
          commit() {
            return { execute: async () => {} };
          },
          rollback() {
            return { execute: async () => {} };
          },
          savepoint() {
            return {
              execute: async () => ({
                ...executor,
                releaseSavepoint() {
                  return { execute: async () => {} };
                },
                rollbackToSavepoint() {
                  return { execute: async () => {} };
                },
              }),
            };
          },
        }),
      };
    },
  };

  return executor;
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
    assert.equal(USER_ADMIN_PLUGIN_PERMISSIONS.some((entry) => entry.code === "security.sessions.revoke"), true);
    assert.deepEqual(plugin.admin.pages, [
      { path: "/", label: "Users", icon: "users" },
      { path: "/roles", label: "Roles", icon: "shield" },
      { path: "/regions", label: "Logical Regions", icon: "map" },
      { path: "/administrative-regions", label: "Administrative Regions", icon: "globe" },
      { path: "/audit", label: "Audit Logs", icon: "clipboard-list" },
      { path: "/security", label: "Security Settings", icon: "lock" },
      { path: "/jobs/levels", label: "Job Levels", icon: "layers" },
      { path: "/jobs/titles", label: "Job Titles", icon: "briefcase" },
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
    assert.equal(authorizationCalls[1].resource.target_user_id, "user_1");
    assert.equal(authorizationCalls[1].resource.is_protected, true);

    const manifest = awcmsUsersAdminPlugin();
    assert.equal(manifest.permissions.length, USER_ADMIN_PLUGIN_PERMISSIONS.length);
    assert.equal(manifest.permissions.some((entry) => entry.code === "audit.logs.read"), true);
  } finally {
    resetUserAdminDatabaseGetter();
    resetUserAdminAuthorizationServiceFactory();
  }
});

test("awcms users admin plugin exposes audit log route with filters", async () => {
  const plugin = createPlugin();
  const authorizationCalls = [];
  const fakeDb = createFakeAuditLogsDb({
    users: [createAdminActorRow()],
    logs: [
      {
        id: "audit_1",
        actor_user_id: "admin_actor",
        action: "security.2fa.reset",
        entity_type: "2fa",
        entity_id: "user_1",
        target_user_id: "user_1",
        request_id: "req_1",
        ip_address: "127.0.0.1",
        user_agent: "unit-test",
        summary: "Reset user two-factor authentication credentials.",
        before_payload: null,
        after_payload: { reset_at: "2026-04-10T10:00:00.000Z" },
        metadata: {},
        occurred_at: "2026-04-10T10:00:00.000Z",
      },
      {
        id: "audit_2",
        actor_user_id: "system",
        action: "auth.lockout",
        entity_type: "auth_lockout",
        entity_id: "account:user@example.com",
        target_user_id: "user_2",
        request_id: "req_2",
        ip_address: "127.0.0.2",
        user_agent: "worker",
        summary: "Locked authentication attempts after repeated failures.",
        before_payload: null,
        after_payload: { locked_until: "2026-04-10T10:15:00.000Z" },
        metadata: {},
        occurred_at: "2026-04-10T10:05:00.000Z",
      },
    ],
  });

  setUserAdminDatabaseGetter(() => fakeDb);
  setUserAdminAuthorizationServiceFactory(createAllowingAuthorizationFactory(authorizationCalls));

  try {
    const body = await plugin.routes["audit/logs"].handler({
      request: new Request("http://example.test/_emdash/api/plugins/awcms-users-admin/audit/logs?action=security.2fa.reset", { headers: createAdminHeaders() }),
    });

    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].actorUserId, "admin_actor");
    assert.equal(body.items[0].action, "security.2fa.reset");
    assert.equal(body.items[0].entityType, "2fa");
    assert.equal(body.items[0].occurredAt, "2026-04-10T10:00:00.000Z");
    assert.equal(authorizationCalls[0].context.permission_code, "audit.logs.read");
  } finally {
    resetUserAdminDatabaseGetter();
    resetUserAdminAuthorizationServiceFactory();
  }
});

test("awcms users admin plugin exposes permission matrix routes and applies staged changes", async () => {
  const plugin = createPlugin();
  const authorizationCalls = [];
  const rbacCalls = [];
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
  setUserAdminRbacServiceFactory(() => ({
    async applyPermissionMatrix(input) {
      rbacCalls.push(input);
      fakeDb.state.role_permissions = [
        { role_id: "role_owner", permission_id: "perm_admin_roles_assign", granted_by_user_id: null, granted_at: "2026-04-10T10:00:00.000Z" },
        { role_id: "role_owner", permission_id: "perm_content_posts_read", granted_by_user_id: null, granted_at: "2026-04-10T10:00:00.000Z" },
        { role_id: "role_editor", permission_id: "perm_content_posts_read", granted_by_user_id: null, granted_at: "2026-04-10T10:00:00.000Z" },
      ];

      return {
        role_owner: {
          currentPermissionIds: ["perm_admin_roles_assign"],
          nextPermissionIds: ["perm_admin_roles_assign", "perm_content_posts_read"],
          addPermissionIds: ["perm_content_posts_read"],
          removePermissionIds: [],
          unchangedPermissionIds: ["perm_admin_roles_assign"],
        },
        role_editor: {
          currentPermissionIds: ["perm_content_posts_read"],
          nextPermissionIds: ["perm_content_posts_read"],
          addPermissionIds: [],
          removePermissionIds: [],
          unchangedPermissionIds: ["perm_content_posts_read"],
        },
      };
    },
  }));

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
    assert.equal(rbacCalls.length, 1);
    assert.deepEqual(rbacCalls[0].rolePermissionIdsByRoleId.role_owner, ["perm_admin_roles_assign", "perm_content_posts_read"]);
    assert.equal(authorizationCalls[0].context.permission_code, "admin.permissions.read");
    assert.equal(authorizationCalls.at(-1).context.permission_code, "admin.permissions.update");
  } finally {
    resetUserAdminDatabaseGetter();
    resetUserAdminAuthorizationServiceFactory();
    resetUserAdminRbacServiceFactory();
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

test("awcms users admin plugin exposes job level and title routes with ladder metadata", async () => {
  const plugin = createPlugin();
  const authorizationCalls = [];
  const fakeDb = createFakeJobsDb({
    levels: [
      {
        id: "level_director",
        code: "director",
        name: "Director",
        rank_order: 9,
        description: "Division leadership",
        is_system: true,
        deleted_at: null,
        created_at: "2026-04-01T10:00:00.000Z",
        updated_at: "2026-04-10T10:00:00.000Z",
        active_title_count: 2,
      },
    ],
    titles: [
      {
        id: "title_division_director",
        job_level_id: "level_director",
        code: "division_director",
        name: "Division Director",
        description: "Leads a division",
        is_active: true,
        deleted_at: null,
        created_at: "2026-04-01T10:00:00.000Z",
        updated_at: "2026-04-10T10:00:00.000Z",
      },
    ],
  });

  setUserAdminDatabaseGetter(() => fakeDb);
  setUserAdminAuthorizationServiceFactory(createAllowingAuthorizationFactory(authorizationCalls));

  try {
    const levels = await plugin.routes["jobs/levels/list"].handler({
      request: new Request("http://example.test/_emdash/api/plugins/awcms-users-admin/jobs/levels/list", { headers: createAdminHeaders() }),
    });
    const titles = await plugin.routes["jobs/titles/list"].handler({
      request: new Request("http://example.test/_emdash/api/plugins/awcms-users-admin/jobs/titles/list", { headers: createAdminHeaders() }),
    });

    assert.equal(levels.items[0].rankOrder, 9);
    assert.equal(levels.items[0].activeTitleCount, 2);
    assert.equal(titles.items[0].levelCode, "director");
    assert.equal(titles.items[0].levelRankOrder, 9);
    assert.equal(authorizationCalls[0].context.permission_code, "governance.jobs.read");
    assert.equal(authorizationCalls[1].context.permission_code, "governance.jobs.read");
  } finally {
    resetUserAdminDatabaseGetter();
    resetUserAdminAuthorizationServiceFactory();
  }
});

test("awcms users admin plugin exposes logical region routes and mutation handlers", async () => {
  const plugin = createPlugin();
  const authorizationCalls = [];
  let createdInput;
  let updatedInput;
  let reparentedInput;
  const fakeDb = createFakeRegionsDb({
    users: [createAdminActorRow()],
    regions: [
      {
        id: "region_root",
        code: "root",
        name: "Root",
        parent_id: null,
        level: 1,
        path: "region_root",
        sort_order: 0,
        is_active: true,
        deleted_at: null,
        created_at: "2026-04-01T10:00:00.000Z",
        updated_at: "2026-04-10T10:00:00.000Z",
      },
      {
        id: "region_branch",
        code: "branch",
        name: "Branch",
        parent_id: "region_root",
        level: 2,
        path: "region_root/region_branch",
        sort_order: 1,
        is_active: true,
        deleted_at: null,
        created_at: "2026-04-02T10:00:00.000Z",
        updated_at: "2026-04-10T10:00:00.000Z",
      },
    ],
  });

  setUserAdminDatabaseGetter(() => fakeDb);
  setUserAdminAuthorizationServiceFactory(createAllowingAuthorizationFactory(authorizationCalls));
  setUserAdminRegionServiceFactory(() => ({
    async createRegion(input) {
      createdInput = input;
    },
    async updateRegion(input) {
      updatedInput = input;
    },
    async reparentRegion(input) {
      reparentedInput = input;
    },
  }));

  try {
    const listBody = await plugin.routes["regions/list"].handler({
      request: new Request("http://example.test/_emdash/api/plugins/awcms-users-admin/regions/list", { headers: createAdminHeaders() }),
    });

    assert.equal(listBody.items.length, 2);
    assert.equal(listBody.items[1].level, 2);
    assert.equal(listBody.items[1].path, "region_root/region_branch");

    await plugin.routes["regions/create"].handler({
      request: new Request("http://example.test/_emdash/api/plugins/awcms-users-admin/regions/create", {
        method: "POST",
        headers: { ...createAdminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ code: "cluster", name: "Cluster", parentId: "region_root", sortOrder: 2 }),
      }),
    });
    assert.equal(createdInput.code, "cluster");
    assert.equal(createdInput.parent_id, "region_root");

    await plugin.routes["regions/update"].handler({
      request: new Request("http://example.test/_emdash/api/plugins/awcms-users-admin/regions/update", {
        method: "POST",
        headers: { ...createAdminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ regionId: "region_branch", code: "branch-updated", name: "Branch Updated", sortOrder: 3, isActive: true }),
      }),
    });
    assert.equal(updatedInput.region_id, "region_branch");
    assert.equal(updatedInput.code, "branch-updated");

    await plugin.routes["regions/reparent"].handler({
      request: new Request("http://example.test/_emdash/api/plugins/awcms-users-admin/regions/reparent", {
        method: "POST",
        headers: { ...createAdminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ regionId: "region_branch", parentId: "" }),
      }),
    });
    assert.equal(reparentedInput.region_id, "region_branch");
    assert.equal(reparentedInput.parent_id, null);

    assert.equal(authorizationCalls[0].context.permission_code, "governance.regions.read");
    assert.equal(authorizationCalls.some((call) => call.context.permission_code === "governance.regions.read" && call.context.action === "update"), true);
  } finally {
    resetUserAdminDatabaseGetter();
    resetUserAdminAuthorizationServiceFactory();
    resetUserAdminRegionServiceFactory();
  }
});

test("awcms users admin plugin exposes administrative region inspection route", async () => {
  const plugin = createPlugin();
  const authorizationCalls = [];
  const fakeDb = createFakeAdministrativeRegionsDb({
    users: [createAdminActorRow()],
    regions: [
      {
        id: "province_jb",
        code: "province-jb",
        name: "Jawa Barat",
        type: "province",
        parent_id: null,
        path: "province_jb",
        province_code: "32",
        regency_code: null,
        district_code: null,
        village_code: null,
        is_active: true,
        created_at: "2026-04-01T10:00:00.000Z",
        updated_at: "2026-04-10T10:00:00.000Z",
      },
      {
        id: "regency_bdg",
        code: "regency-bdg",
        name: "Bandung",
        type: "regency_city",
        parent_id: "province_jb",
        path: "province_jb/regency_bdg",
        province_code: "32",
        regency_code: "32.04",
        district_code: null,
        village_code: null,
        is_active: true,
        created_at: "2026-04-02T10:00:00.000Z",
        updated_at: "2026-04-11T10:00:00.000Z",
      },
    ],
  });

  setUserAdminDatabaseGetter(() => fakeDb);
  setUserAdminAuthorizationServiceFactory(createAllowingAuthorizationFactory(authorizationCalls));

  try {
    const body = await plugin.routes["administrative-regions/list"].handler({
      request: new Request("http://example.test/_emdash/api/plugins/awcms-users-admin/administrative-regions/list", { headers: createAdminHeaders() }),
    });

    assert.equal(body.items.length, 2);
    assert.equal(body.items[0].type, "province");
    assert.equal(body.items[1].path, "province_jb/regency_bdg");
    assert.equal(body.importStatus.source, "src/db/data/administrative-regions.seed.json");
    assert.equal(body.importStatus.command, "pnpm db:seed:administrative-regions");
    assert.equal(body.importStatus.latestUpdatedAt, "2026-04-11T10:00:00.000Z");
    assert.equal(authorizationCalls[0].context.permission_code, "governance.administrative_regions.assign");
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

test("awcms users admin plugin exposes user job history and assignment routes", async () => {
  const plugin = createPlugin();
  let assignedInput;
  const authorizationCalls = [];
  const fakeDb = createFakeUserJobsDb({
    users: [
      createAdminActorRow(),
      {
        id: "user_1",
        email: "user@example.com",
        username: "user1",
        display_name: "User One",
        status: "active",
        last_login_at: null,
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
        active_role_staff_level: 4,
      },
      {
        ...createAdminActorRow(),
        id: "supervisor_1",
        email: "supervisor@example.com",
        display_name: "Supervisor One",
      },
    ],
    levels: [
      { id: "level_manager", code: "manager", name: "Manager", rank_order: 7, description: "Ops", is_system: true, deleted_at: null, created_at: "2026-04-01T10:00:00.000Z", updated_at: "2026-04-10T10:00:00.000Z", active_title_count: 1 },
    ],
    titles: [
      { id: "title_ops_manager", job_level_id: "level_manager", code: "ops_manager", name: "Ops Manager", description: "Runs ops", is_active: true, deleted_at: null, created_at: "2026-04-01T10:00:00.000Z", updated_at: "2026-04-10T10:00:00.000Z" },
    ],
    assignments: [
      { id: "job_1", user_id: "user_1", job_level_id: "level_manager", job_title_id: "title_ops_manager", supervisor_user_id: "supervisor_1", employment_status: "active", starts_at: "2026-04-01T10:00:00.000Z", ends_at: null, is_primary: true, assigned_by_user_id: "admin_actor", notes: "Primary", created_at: "2026-04-01T10:00:00.000Z" },
    ],
  });

  setUserAdminDatabaseGetter(() => fakeDb);
  setUserAdminAuthorizationServiceFactory(createAllowingAuthorizationFactory(authorizationCalls));
  setUserAdminJobsServiceFactory(() => ({
    async assignJob(input) {
      assignedInput = input;
    },
  }));

  try {
    const jobsBody = await plugin.routes["users/jobs"].handler({
      request: new Request("http://example.test/_emdash/api/plugins/awcms-users-admin/users/jobs?id=user_1", { headers: createAdminHeaders() }),
    });

    assert.equal(jobsBody.assignments.length, 1);
    assert.equal(jobsBody.assignments[0].jobLevelName, "Manager");
    assert.equal(jobsBody.supervisorCandidates.length, 2);

    await plugin.routes["users/jobs/assign"].handler({
      request: new Request("http://example.test/_emdash/api/plugins/awcms-users-admin/users/jobs/assign", {
        method: "POST",
        headers: { ...createAdminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: "user_1",
          jobLevelId: "level_manager",
          jobTitleId: "title_ops_manager",
          supervisorUserId: "supervisor_1",
          employmentStatus: "active",
          startsAt: "2026-05-01T10:00:00.000Z",
          notes: "Promoted",
        }),
      }),
    });

    assert.equal(assignedInput.user_id, "user_1");
    assert.equal(assignedInput.job_level_id, "level_manager");
    assert.equal(assignedInput.supervisor_user_id, "supervisor_1");
    assert.equal(authorizationCalls[0].context.permission_code, "governance.jobs.read");
    assert.equal(authorizationCalls.some((call) => call.context.permission_code === "governance.jobs.assign"), true);
    assert.equal(authorizationCalls.at(-1).context.permission_code, "governance.jobs.read");
  } finally {
    resetUserAdminDatabaseGetter();
    resetUserAdminAuthorizationServiceFactory();
    resetUserAdminJobsServiceFactory();
  }
});

test("awcms users admin plugin exposes user role history and assignment routes", async () => {
  const plugin = createPlugin();
  let assignedInput;
  const authorizationCalls = [];
  const fakeDb = createFakeUserRolesDb({
    users: [
      createAdminActorRow(),
      {
        id: "user_1",
        email: "user@example.com",
        username: "user1",
        display_name: "User One",
        status: "active",
        last_login_at: null,
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
        active_role_staff_level: 4,
      },
    ],
    roles: [
      { id: "role_owner", slug: "owner", name: "Owner", description: "Emergency control", staff_level: 10, is_system: true, is_assignable: false, is_protected: true, deleted_at: null, created_at: "2026-04-01T10:00:00.000Z", updated_at: "2026-04-10T10:00:00.000Z", active_assignment_count: 1 },
      { id: "role_editor", slug: "editor", name: "Editor", description: "Editorial management", staff_level: 6, is_system: true, is_assignable: true, is_protected: false, deleted_at: null, created_at: "2026-04-01T10:00:00.000Z", updated_at: "2026-04-10T10:00:00.000Z", active_assignment_count: 4 },
    ],
    assignments: [],
  });

  setUserAdminDatabaseGetter(() => fakeDb);
  setUserAdminAuthorizationServiceFactory(createAllowingAuthorizationFactory(authorizationCalls));
  setUserAdminRoleAssignmentServiceFactory(() => ({
    async listActiveRoles() {
      return [
        {
          id: "assign_1",
          user_id: "user_1",
          role_id: "role_editor",
          assigned_by_user_id: "admin_actor",
          assigned_at: "2026-04-01T10:00:00.000Z",
          expires_at: null,
          is_primary: true,
          role: {
            id: "role_editor",
            slug: "editor",
            name: "Editor",
            description: "Editorial management",
            staff_level: 6,
            is_system: true,
            is_assignable: true,
            is_protected: false,
          },
        },
      ];
    },
    async assignRole(input) {
      assignedInput = input;
    },
  }));

  try {
    const rolesBody = await plugin.routes["users/roles"].handler({
      request: new Request("http://example.test/_emdash/api/plugins/awcms-users-admin/users/roles?id=user_1", { headers: createAdminHeaders() }),
    });

    assert.equal(rolesBody.assignments.length, 1);
    assert.equal(rolesBody.assignments[0].role.name, "Editor");
    assert.equal(rolesBody.roles.length, 2);

    await plugin.routes["users/roles/assign"].handler({
      request: new Request("http://example.test/_emdash/api/plugins/awcms-users-admin/users/roles/assign", {
        method: "POST",
        headers: { ...createAdminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: "user_1",
          roleId: "role_owner",
          isPrimary: true,
          confirmProtectedRoleChange: true,
        }),
      }),
    });

    assert.equal(assignedInput.user_id, "user_1");
    assert.equal(assignedInput.role_id, "role_owner");
    assert.equal(assignedInput.confirm_protected_role_change, true);
    assert.equal(authorizationCalls[0].context.permission_code, "admin.roles.read");
    assert.equal(authorizationCalls.some((call) => call.context.permission_code === "admin.roles.assign"), true);
    assert.equal(authorizationCalls.at(-1).context.permission_code, "admin.roles.read");
  } finally {
    resetUserAdminDatabaseGetter();
    resetUserAdminAuthorizationServiceFactory();
    resetUserAdminRoleAssignmentServiceFactory();
  }
});

test("awcms users admin plugin exposes user logical region history and assignment routes", async () => {
  const plugin = createPlugin();
  let assignedInput;
  const authorizationCalls = [];
  const fakeDb = createFakeUserRegionsDb({
    users: [
      createAdminActorRow(),
      {
        id: "user_1",
        email: "user@example.com",
        username: "user1",
        display_name: "User One",
        status: "active",
        last_login_at: null,
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
        active_role_staff_level: 4,
      },
    ],
    regions: [
      {
        id: "region_root",
        code: "root",
        name: "Root",
        parent_id: null,
        level: 1,
        path: "region_root",
        sort_order: 0,
        is_active: true,
        deleted_at: null,
        created_at: "2026-04-01T10:00:00.000Z",
        updated_at: "2026-04-10T10:00:00.000Z",
      },
      {
        id: "region_branch",
        code: "branch",
        name: "Branch",
        parent_id: "region_root",
        level: 2,
        path: "region_root/region_branch",
        sort_order: 1,
        is_active: true,
        deleted_at: null,
        created_at: "2026-04-01T10:00:00.000Z",
        updated_at: "2026-04-10T10:00:00.000Z",
      },
    ],
    assignments: [
      {
        id: "region_assignment_1",
        user_id: "user_1",
        region_id: "region_branch",
        assignment_type: "manager",
        is_primary: true,
        starts_at: "2026-04-01T10:00:00.000Z",
        ends_at: null,
        assigned_by_user_id: "admin_actor",
        created_at: "2026-04-01T10:00:00.000Z",
      },
    ],
  });

  setUserAdminDatabaseGetter(() => fakeDb);
  setUserAdminAuthorizationServiceFactory(createAllowingAuthorizationFactory(authorizationCalls));
  setUserAdminRegionAssignmentServiceFactory(() => ({
    async assignRegion(input) {
      assignedInput = input;
    },
  }));

  try {
    const regionsBody = await plugin.routes["users/regions"].handler({
      request: new Request("http://example.test/_emdash/api/plugins/awcms-users-admin/users/regions?id=user_1", { headers: createAdminHeaders() }),
    });

    assert.equal(regionsBody.assignments.length, 1);
    assert.equal(regionsBody.assignments[0].regionName, "Branch");
    assert.equal(regionsBody.assignments[0].regionLevel, 2);
    assert.equal(regionsBody.regions.length, 2);

    await plugin.routes["users/regions/assign"].handler({
      request: new Request("http://example.test/_emdash/api/plugins/awcms-users-admin/users/regions/assign", {
        method: "POST",
        headers: { ...createAdminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: "user_1",
          regionId: "region_root",
          assignmentType: "member",
          startsAt: "2026-05-01T10:00:00.000Z",
        }),
      }),
    });

    assert.equal(assignedInput.user_id, "user_1");
    assert.equal(assignedInput.region_id, "region_root");
    assert.equal(assignedInput.assignment_type, "member");
    assert.equal(authorizationCalls[0].context.permission_code, "governance.regions.read");
    assert.equal(authorizationCalls.some((call) => call.context.permission_code === "governance.regions.read" && call.context.action === "assign"), true);
    assert.equal(authorizationCalls.at(-1).context.permission_code, "governance.regions.read");
  } finally {
    resetUserAdminDatabaseGetter();
    resetUserAdminAuthorizationServiceFactory();
    resetUserAdminRegionAssignmentServiceFactory();
  }
});

test("awcms users admin plugin exposes user administrative region history and assignment routes", async () => {
  const plugin = createPlugin();
  let assignedInput;
  const authorizationCalls = [];
  const fakeDb = createFakeUserAdministrativeRegionsDb({
    users: [
      createAdminActorRow(),
      {
        id: "user_1",
        email: "user@example.com",
        username: "user1",
        display_name: "User One",
        status: "active",
        last_login_at: null,
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
        active_role_staff_level: 4,
      },
    ],
    regions: [
      {
        id: "province_jb",
        code: "province-jb",
        name: "Jawa Barat",
        type: "province",
        parent_id: null,
        path: "province_jb",
        province_code: "32",
        regency_code: null,
        district_code: null,
        village_code: null,
        is_active: true,
        created_at: "2026-04-01T10:00:00.000Z",
        updated_at: "2026-04-10T10:00:00.000Z",
      },
      {
        id: "regency_bdg",
        code: "regency-bdg",
        name: "Bandung",
        type: "regency_city",
        parent_id: "province_jb",
        path: "province_jb/regency_bdg",
        province_code: "32",
        regency_code: "32.04",
        district_code: null,
        village_code: null,
        is_active: true,
        created_at: "2026-04-01T10:00:00.000Z",
        updated_at: "2026-04-10T10:00:00.000Z",
      },
    ],
    assignments: [
      {
        id: "administrative_assignment_1",
        user_id: "user_1",
        administrative_region_id: "regency_bdg",
        assignment_type: "manager",
        is_primary: true,
        starts_at: "2026-04-01T10:00:00.000Z",
        ends_at: null,
        assigned_by_user_id: "admin_actor",
        created_at: "2026-04-01T10:00:00.000Z",
      },
    ],
  });

  setUserAdminDatabaseGetter(() => fakeDb);
  setUserAdminAuthorizationServiceFactory(createAllowingAuthorizationFactory(authorizationCalls));
  setUserAdminAdministrativeRegionAssignmentServiceFactory(() => ({
    async assignAdministrativeRegion(input) {
      assignedInput = input;
    },
  }));

  try {
    const body = await plugin.routes["users/administrative-regions"].handler({
      request: new Request("http://example.test/_emdash/api/plugins/awcms-users-admin/users/administrative-regions?id=user_1", { headers: createAdminHeaders() }),
    });

    assert.equal(body.assignments.length, 1);
    assert.equal(body.assignments[0].administrativeRegionName, "Bandung");
    assert.equal(body.assignments[0].administrativeRegionType, "regency_city");
    assert.equal(body.regions.length, 2);

    await plugin.routes["users/administrative-regions/assign"].handler({
      request: new Request("http://example.test/_emdash/api/plugins/awcms-users-admin/users/administrative-regions/assign", {
        method: "POST",
        headers: { ...createAdminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: "user_1",
          administrativeRegionId: "province_jb",
          assignmentType: "member",
          startsAt: "2026-05-01T10:00:00.000Z",
        }),
      }),
    });

    assert.equal(assignedInput.user_id, "user_1");
    assert.equal(assignedInput.administrative_region_id, "province_jb");
    assert.equal(assignedInput.assignment_type, "member");
    assert.equal(authorizationCalls[0].context.permission_code, "governance.administrative_regions.assign");
    assert.equal(authorizationCalls.some((call) => call.context.permission_code === "governance.administrative_regions.assign" && call.context.action === "assign"), true);
  } finally {
    resetUserAdminDatabaseGetter();
    resetUserAdminAuthorizationServiceFactory();
    resetUserAdminAdministrativeRegionAssignmentServiceFactory();
  }
});

test("awcms users admin plugin exposes user session and login history routes", async () => {
  const plugin = createPlugin();
  let revokedSessionId;
  const authorizationCalls = [];
  const fakeDb = createFakeUserSessionsDb({
    users: [
      createAdminActorRow(),
      {
        id: "user_1",
        email: "user@example.com",
        username: "user1",
        display_name: "User One",
        status: "active",
        last_login_at: "2026-04-10T10:00:00.000Z",
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
        active_session_count: 2,
        active_role_staff_level: 4,
      },
    ],
    sessions: [
      { id: "session_1", user_id: "user_1", session_token_hash: "hash_1", ip_address: "127.0.0.1", user_agent: "Browser A", trusted_device: true, last_seen_at: "2026-04-10T09:55:00.000Z", expires_at: "2026-05-10T10:00:00.000Z", revoked_at: null, created_at: "2026-04-01T10:00:00.000Z" },
      { id: "session_2", user_id: "user_1", session_token_hash: "hash_2", ip_address: "127.0.0.2", user_agent: "Browser B", trusted_device: false, last_seen_at: "2026-04-10T09:45:00.000Z", expires_at: "2026-05-10T10:00:00.000Z", revoked_at: null, created_at: "2026-04-02T10:00:00.000Z" },
    ],
    loginEvents: [
      { id: "login_event_1", user_id: "user_1", email_attempted: "user@example.com", event_type: "login.password", outcome: "success", reason: null, ip_address: "127.0.0.1", user_agent: "Browser A", occurred_at: "2026-04-10T09:55:00.000Z" },
      { id: "login_event_2", user_id: "user_1", email_attempted: "user@example.com", event_type: "login.password", outcome: "failure", reason: "INVALID_PASSWORD", ip_address: "127.0.0.3", user_agent: "Browser C", occurred_at: "2026-04-09T10:00:00.000Z" },
    ],
  });

  setUserAdminDatabaseGetter(() => fakeDb);
  setUserAdminAuthorizationServiceFactory(createAllowingAuthorizationFactory(authorizationCalls));
  setUserAdminSessionServiceFactory(() => ({
    async revokeSession(sessionId) {
      revokedSessionId = sessionId;
    },
  }));

  try {
    const body = await plugin.routes["users/sessions"].handler({
      request: new Request("http://example.test/_emdash/api/plugins/awcms-users-admin/users/sessions?id=user_1", { headers: createAdminHeaders() }),
    });

    assert.equal(body.sessions.length, 2);
    assert.equal(body.sessions[0].trustedDevice, true);
    assert.equal(body.loginEvents.length, 2);
    assert.equal(body.loginEvents[1].outcome, "failure");

    await plugin.routes["users/sessions/revoke"].handler({
      request: new Request("http://example.test/_emdash/api/plugins/awcms-users-admin/users/sessions/revoke", {
        method: "POST",
        headers: { ...createAdminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "user_1", sessionId: "session_1" }),
      }),
    });

    assert.equal(revokedSessionId, "session_1");
    assert.equal(authorizationCalls[0].context.permission_code, "security.sessions.read");
    assert.equal(authorizationCalls.some((call) => call.context.permission_code === "security.sessions.revoke"), true);
  } finally {
    resetUserAdminDatabaseGetter();
    resetUserAdminAuthorizationServiceFactory();
    resetUserAdminSessionServiceFactory();
  }
});

test("awcms users admin plugin exposes security settings routes and protected 2fa reset flow", async () => {
  const plugin = createPlugin();
  const authorizationCalls = [];
  const auditEntries = [];
  let resetInput;
  const fakeDb = {
    selectFrom(table) {
      if (table === "users") {
        const query = new FakeUsersQuery([
          createAdminActorRow(),
          {
            ...createAdminActorRow(),
            id: "user_1",
            email: "user@example.com",
            username: "user1",
            display_name: "User One",
            active_role_staff_level: 4,
            active_session_count: 0,
            is_protected: false,
          },
        ]);
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
      }

      if (table === "roles") {
        const query = new FakeRolesQuery([
          { id: "role_owner", slug: "owner", name: "Owner", staff_level: 10, is_assignable: true, is_protected: true, deleted_at: null },
          { id: "role_editor", slug: "editor", name: "Editor", staff_level: 4, is_assignable: true, is_protected: false, deleted_at: null },
        ]);
        return query;
      }

      assert.fail(`Unexpected table ${table}`);
    },
  };

  resetSecurityPolicy();
  setUserAdminDatabaseGetter(() => fakeDb);
  setUserAdminAuthorizationServiceFactory(createAllowingAuthorizationFactory(authorizationCalls));
  setUserAdminAuditServiceFactory(() => ({
    async append(entry) {
      auditEntries.push(entry);
      return entry;
    },
  }));
  setUserAdminAdminTwoFactorServiceFactory(() => ({
    async getUserTwoFactorStatus(userId) {
      return {
        userId,
        enrolled: true,
        pending: false,
        verifiedAt: "2026-04-01T10:00:00.000Z",
        lastUsedAt: "2026-04-02T10:00:00.000Z",
        recoveryCodeCount: 6,
      };
    },
    async resetUserTwoFactor(input) {
      resetInput = input;
      return {
        userId: input.user_id,
        enrolled: false,
        pending: false,
        verifiedAt: null,
        lastUsedAt: null,
        recoveryCodeCount: 0,
      };
    },
  }));

  try {
    const settingsBody = await plugin.routes["security/settings"].handler({
      request: new Request("http://example.test/_emdash/api/plugins/awcms-users-admin/security/settings", { headers: createAdminHeaders() }),
    });
    assert.equal(settingsBody.roles.length, 2);
    assert.deepEqual(settingsBody.policy.mandatoryTwoFactorRoleIds, []);

    const updated = await plugin.routes["security/settings/update"].handler({
      request: new Request("http://example.test/_emdash/api/plugins/awcms-users-admin/security/settings/update", {
        method: "POST",
        headers: { ...createAdminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ mandatoryTwoFactorRoleIds: ["role_owner"] }),
      }),
    });
    assert.deepEqual(updated.policy.mandatoryTwoFactorRoleIds, ["role_owner"]);
    assert.equal(auditEntries.length, 1);
    assert.equal(auditEntries[0].action, "plugin.security.settings.update");
    assert.equal(auditEntries[0].metadata.plugin_id, "awcms-users-admin");
    assert.deepEqual(auditEntries[0].before_payload, {
      mandatory_two_factor_role_ids: [],
    });
    assert.deepEqual(auditEntries[0].after_payload, {
      mandatory_two_factor_role_ids: ["role_owner"],
    });

    const statusBody = await plugin.routes["users/2fa/status"].handler({
      request: new Request("http://example.test/_emdash/api/plugins/awcms-users-admin/users/2fa/status?id=user_1", { headers: createAdminHeaders() }),
    });
    assert.equal(statusBody.enrolled, true);
    assert.equal(statusBody.recoveryCodeCount, 6);

    await assert.rejects(
      () =>
        plugin.routes["users/2fa/reset"].handler({
          request: new Request("http://example.test/_emdash/api/plugins/awcms-users-admin/users/2fa/reset", {
            method: "POST",
            headers: { ...createAdminHeaders(), "Content-Type": "application/json" },
            body: JSON.stringify({ userId: "user_1", reason: "Support recovery" }),
          }),
        }),
      /STEP_UP_REQUIRED/,
    );

    const resetBody = await plugin.routes["users/2fa/reset"].handler({
      request: new Request("http://example.test/_emdash/api/plugins/awcms-users-admin/users/2fa/reset", {
        method: "POST",
        headers: {
          ...createAdminHeaders({ "x-session-strength": "step_up", "x-step-up-authenticated": "true" }),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ userId: "user_1", reason: "Support recovery" }),
      }),
    });
    assert.equal(resetBody.enrolled, false);
    assert.equal(resetInput.user_id, "user_1");
    assert.equal(resetInput.reason, "Support recovery");
    assert.equal(authorizationCalls.some((call) => call.context.permission_code === "security.2fa.reset"), true);
  } finally {
    resetUserAdminDatabaseGetter();
    resetUserAdminAuthorizationServiceFactory();
    resetUserAdminAuditServiceFactory();
    resetUserAdminAdminTwoFactorServiceFactory();
    resetSecurityPolicy();
  }
});
