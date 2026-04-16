import test from "node:test";
import assert from "node:assert/strict";

import {
  createAuthorizationAdministrativeRegionContextResolver,
  createAuthorizationJobContextResolver,
  createAuthorizationLogicalRegionContextResolver,
  createAuthorizationService,
} from "../../src/services/authorization/service.mjs";

function createAuthorizationContextDatabase(state) {
  return {
    selectFrom(table) {
      const source = state[table];
      const filters = [];
      const query = {
        select: () => query,
        where: (column, operator, value) => {
          filters.push({ column, operator, value });
          return query;
        },
        orderBy: () => query,
        limit: () => query,
        offset: () => query,
        execute: async () =>
          source.filter((row) =>
            filters.every((filter) => {
              if (filter.operator === "=" || filter.operator === "is") return row[filter.column] === filter.value;
              if (filter.operator === "is not") return row[filter.column] !== filter.value;
              return false;
            }),
          ),
        executeTakeFirst: async () =>
          source.find((row) =>
            filters.every((filter) => {
              if (filter.operator === "=" || filter.operator === "is") return row[filter.column] === filter.value;
              if (filter.operator === "is not") return row[filter.column] !== filter.value;
              return false;
            }),
          ),
      };
      return query;
    },
  };
}

test("authorization service denies unauthenticated subjects before permission resolution", async () => {
  const service = createAuthorizationService({
    permissionResolver: {
      async getEffectivePermissions() {
        throw new Error("should not resolve permissions");
      },
    },
  });

  const result = await service.evaluate({
    subject: { kind: "user" },
    context: { permission_code: "admin.users.read", action: "read" },
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason.code, "DENY_UNAUTHENTICATED");
});

test("authorization service denies requests when the RBAC baseline lacks the permission", async () => {
  const service = createAuthorizationService({
    permissionResolver: {
      async getEffectivePermissions(userId) {
        assert.equal(userId, "user_1");
        return {
          user_id: userId,
          permission_codes: ["content.posts.read"],
        };
      },
    },
  });

  const result = await service.evaluate({
    subject: { kind: "user", user_id: "user_1" },
    context: { permission_code: "admin.users.read", action: "read" },
  });

  assert.equal(result.allowed, false);
  assert.equal(result.matched_rule, "rbac-baseline");
  assert.equal(result.reason.code, "DENY_PERMISSION_MISSING");
  assert.equal(result.reason.details.permission_code, "admin.users.read");
});

test("authorization service allows requests when the RBAC baseline grants the permission", async () => {
  const service = createAuthorizationService({
    permissionResolver: {
      async getEffectivePermissions(userId) {
        assert.equal(userId, "user_2");
        return {
          user_id: userId,
          permission_codes: ["admin.users.read", "content.posts.read"],
        };
      },
    },
  });

  const allowed = await service.hasPermission({
    subject: { kind: "user", user_id: "user_2" },
    context: { permission_code: "admin.users.read", action: "read" },
  });

  const result = await service.evaluate({
    subject: { kind: "user", user_id: "user_2" },
    context: { permission_code: "admin.users.read", action: "read" },
  });

  assert.equal(allowed, true);
  assert.equal(result.allowed, true);
  assert.equal(result.reason.code, "ALLOW_RBAC_PERMISSION");
});

test("authorization job context resolver hydrates the current active primary job cheaply", async () => {
  const state = {
    user_jobs: [
      {
        id: "job_1",
        user_id: "user_1",
        job_level_id: "level_manager",
        job_title_id: "title_ops_manager",
        supervisor_user_id: "user_9",
        employment_status: "active",
        starts_at: "2026-01-01T00:00:00.000Z",
        ends_at: null,
        is_primary: true,
        assigned_by_user_id: null,
        notes: null,
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ],
    job_levels: [
      {
        id: "level_manager",
        code: "manager",
        name: "Manager",
        rank_order: 7,
        description: null,
        is_system: true,
        deleted_at: null,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
    ],
    job_titles: [
      {
        id: "title_ops_manager",
        job_level_id: "level_manager",
        code: "ops_manager",
        name: "Ops Manager",
        description: null,
        is_active: true,
        deleted_at: null,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
  const database = createAuthorizationContextDatabase(state);

  const resolveCurrentJobContext = createAuthorizationJobContextResolver(database);
  const subject = await resolveCurrentJobContext({ kind: "user", user_id: "user_1", job_level_rank: 0 });

  assert.equal(subject.current_job_id, "job_1");
  assert.equal(subject.current_job_level_id, "level_manager");
  assert.equal(subject.current_job_title_id, "title_ops_manager");
  assert.equal(subject.supervisor_user_id, "user_9");
  assert.equal(subject.job_level_rank, 7);
  assert.equal(subject.current_job_level_code, "manager");
  assert.equal(subject.current_job_title_code, "ops_manager");
});

test("authorization logical region context resolver hydrates actor scope and target user scope from assignments", async () => {
  const state = {
    regions: [
      { id: "region_root", code: "root", name: "Root", parent_id: null, level: 1, path: "region_root", sort_order: 0, is_active: true, deleted_at: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" },
      { id: "region_north", code: "north", name: "North", parent_id: "region_root", level: 2, path: "region_root/region_north", sort_order: 0, is_active: true, deleted_at: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" },
      { id: "region_south", code: "south", name: "South", parent_id: "region_root", level: 2, path: "region_root/region_south", sort_order: 0, is_active: true, deleted_at: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" },
    ],
    user_region_assignments: [
      { id: "assignment_actor", user_id: "user_actor", region_id: "region_root", assignment_type: "manager", is_primary: true, starts_at: "2026-01-01T00:00:00.000Z", ends_at: null, assigned_by_user_id: null, created_at: "2026-01-01T00:00:00.000Z" },
      { id: "assignment_target", user_id: "user_target", region_id: "region_north", assignment_type: "member", is_primary: true, starts_at: "2026-01-01T00:00:00.000Z", ends_at: null, assigned_by_user_id: null, created_at: "2026-01-01T00:00:00.000Z" },
    ],
  };
  const resolveLogicalRegionContext = createAuthorizationLogicalRegionContextResolver(createAuthorizationContextDatabase(state));

  const evaluation = await resolveLogicalRegionContext({
    subject: { kind: "user", user_id: "user_actor", logical_region_ids: [] },
    resource: { kind: "user", target_user_id: "user_target", logical_region_ids: [] },
    context: { permission_code: "admin.users.read", action: "read", session_id: null },
  });

  assert.deepEqual(evaluation.subject.logical_region_ids, ["region_north", "region_root", "region_south"]);
  assert.deepEqual(evaluation.resource.logical_region_ids, ["region_north"]);
});

test("authorization administrative region context resolver hydrates actor scope and target user scope from assignments", async () => {
  const state = {
    administrative_regions: [
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
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
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
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "regency_bgr",
        code: "regency-bgr",
        name: "Bogor",
        type: "regency_city",
        parent_id: "province_jb",
        path: "province_jb/regency_bgr",
        province_code: "32",
        regency_code: "32.01",
        district_code: null,
        village_code: null,
        is_active: true,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
    ],
    user_administrative_region_assignments: [
      {
        id: "assignment_actor",
        user_id: "user_actor",
        administrative_region_id: "province_jb",
        assignment_type: "manager",
        is_primary: true,
        starts_at: "2026-01-01T00:00:00.000Z",
        ends_at: null,
        assigned_by_user_id: null,
        created_at: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "assignment_target",
        user_id: "user_target",
        administrative_region_id: "regency_bdg",
        assignment_type: "member",
        is_primary: true,
        starts_at: "2026-01-01T00:00:00.000Z",
        ends_at: null,
        assigned_by_user_id: null,
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
  const resolveAdministrativeRegionContext = createAuthorizationAdministrativeRegionContextResolver(
    createAuthorizationContextDatabase(state),
  );

  const evaluation = await resolveAdministrativeRegionContext({
    subject: { kind: "user", user_id: "user_actor", administrative_region_ids: [] },
    resource: { kind: "user", target_user_id: "user_target", administrative_region_ids: [] },
    context: { permission_code: "admin.users.read", action: "read", session_id: null },
  });

  assert.deepEqual(evaluation.subject.administrative_region_ids, ["province_jb", "regency_bdg", "regency_bgr"]);
  assert.deepEqual(evaluation.resource.administrative_region_ids, ["regency_bdg"]);
});

test("authorization service does not grant access from job context alone", async () => {
  const service = createAuthorizationService({
    jobContextResolver: async (subject) => ({
      ...subject,
      current_job_id: "job_1",
      current_job_level_id: "level_director",
      job_level_rank: 9,
    }),
    permissionResolver: {
      async getEffectivePermissions() {
        return {
          user_id: "user_8",
          permission_codes: [],
        };
      },
    },
  });

  const result = await service.evaluate({
    subject: { kind: "user", user_id: "user_8" },
    resource: { kind: "job", target_user_id: "user_9" },
    context: { permission_code: "governance.jobs.assign", action: "assign" },
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason.code, "DENY_PERMISSION_MISSING");
});

test("authorization service denies requests when target logical region falls outside actor subtree scope", async () => {
  const service = createAuthorizationService({
    logicalRegionContextResolver: async (evaluation) => ({
      ...evaluation,
      subject: {
        ...evaluation.subject,
        logical_region_ids: ["region_root", "region_north"],
      },
      resource: {
        ...evaluation.resource,
        logical_region_ids: ["region_south"],
      },
    }),
    permissionResolver: {
      async getEffectivePermissions() {
        return {
          user_id: "user_manager",
          permission_codes: ["admin.users.read"],
        };
      },
    },
  });

  const result = await service.evaluate({
    subject: { kind: "user", user_id: "user_manager" },
    resource: { kind: "user", target_user_id: "user_target" },
    context: { permission_code: "admin.users.read", action: "read" },
  });

  assert.equal(result.allowed, false);
  assert.equal(result.matched_rule, "logical-region:scope");
  assert.equal(result.reason.code, "DENY_REGION_SCOPE_MISMATCH");
});

test("authorization service allows requests when target logical region falls within actor subtree scope", async () => {
  const service = createAuthorizationService({
    logicalRegionContextResolver: async (evaluation) => ({
      ...evaluation,
      subject: {
        ...evaluation.subject,
        logical_region_ids: ["region_root", "region_north"],
      },
      resource: {
        ...evaluation.resource,
        logical_region_ids: ["region_north"],
      },
    }),
    permissionResolver: {
      async getEffectivePermissions() {
        return {
          user_id: "user_manager",
          permission_codes: ["admin.users.read"],
        };
      },
    },
  });

  const result = await service.evaluate({
    subject: { kind: "user", user_id: "user_manager" },
    resource: { kind: "user", target_user_id: "user_target" },
    context: { permission_code: "admin.users.read", action: "read" },
  });

  assert.equal(result.allowed, true);
  assert.equal(result.reason.code, "ALLOW_RBAC_PERMISSION");
});

test("authorization service denies requests when target administrative region falls outside actor subtree scope", async () => {
  const service = createAuthorizationService({
    administrativeRegionContextResolver: async (evaluation) => ({
      ...evaluation,
      subject: {
        ...evaluation.subject,
        administrative_region_ids: ["province_jb", "regency_bdg"],
      },
      resource: {
        ...evaluation.resource,
        administrative_region_ids: ["regency_bgr"],
      },
    }),
    permissionResolver: {
      async getEffectivePermissions() {
        return {
          user_id: "user_manager",
          permission_codes: ["admin.users.read"],
        };
      },
    },
  });

  const result = await service.evaluate({
    subject: { kind: "user", user_id: "user_manager" },
    resource: { kind: "user", target_user_id: "user_target" },
    context: { permission_code: "admin.users.read", action: "read" },
  });

  assert.equal(result.allowed, false);
  assert.equal(result.matched_rule, "administrative-region:scope");
  assert.equal(result.reason.code, "DENY_REGION_SCOPE_MISMATCH");
});

test("authorization service allows requests when target administrative region falls within actor subtree scope", async () => {
  const service = createAuthorizationService({
    administrativeRegionContextResolver: async (evaluation) => ({
      ...evaluation,
      subject: {
        ...evaluation.subject,
        administrative_region_ids: ["province_jb", "regency_bdg"],
      },
      resource: {
        ...evaluation.resource,
        administrative_region_ids: ["regency_bdg"],
      },
    }),
    permissionResolver: {
      async getEffectivePermissions() {
        return {
          user_id: "user_manager",
          permission_codes: ["admin.users.read"],
        };
      },
    },
  });

  const result = await service.evaluate({
    subject: { kind: "user", user_id: "user_manager" },
    resource: { kind: "user", target_user_id: "user_target" },
    context: { permission_code: "admin.users.read", action: "read" },
  });

  assert.equal(result.allowed, true);
  assert.equal(result.reason.code, "ALLOW_RBAC_PERMISSION");
});

test("authorization service marks self-service user actions through a scoped allow rule", async () => {
  const service = createAuthorizationService({
    permissionResolver: {
      async getEffectivePermissions() {
        return {
          user_id: "user_4",
          permission_codes: ["admin.users.update"],
        };
      },
    },
  });

  const result = await service.evaluate({
    subject: { kind: "user", user_id: "user_4" },
    resource: { kind: "user", target_user_id: "user_4" },
    context: { permission_code: "admin.users.update", action: "update" },
  });

  assert.equal(result.allowed, true);
  assert.equal(result.matched_rule, "self-service:user");
  assert.equal(result.reason.code, "ALLOW_ABAC_RULE");
});

test("authorization service marks self-session actions through a scoped allow rule", async () => {
  const service = createAuthorizationService({
    permissionResolver: {
      async getEffectivePermissions() {
        return {
          user_id: "user_5",
          permission_codes: ["security.sessions.revoke"],
        };
      },
    },
  });

  const result = await service.evaluate({
    subject: { kind: "user", user_id: "user_5" },
    resource: { kind: "session", owner_user_id: "user_5", resource_id: "session_1" },
    context: { permission_code: "security.sessions.revoke", action: "revoke" },
  });

  assert.equal(result.allowed, true);
  assert.equal(result.matched_rule, "self-service:session");
});

test("authorization service marks owned content actions through an ownership rule without elevating beyond baseline", async () => {
  const service = createAuthorizationService({
    permissionResolver: {
      async getEffectivePermissions(userId) {
        return {
          user_id: userId,
          permission_codes: userId === "user_6" ? ["content.posts.update"] : [],
        };
      },
    },
  });

  const ownedResult = await service.evaluate({
    subject: { kind: "user", user_id: "user_6" },
    resource: { kind: "content", owner_user_id: "user_6", resource_id: "post_1" },
    context: { permission_code: "content.posts.update", action: "update" },
  });

  const deniedResult = await service.evaluate({
    subject: { kind: "user", user_id: "user_7" },
    resource: { kind: "content", owner_user_id: "user_7", resource_id: "post_2" },
    context: { permission_code: "content.posts.update", action: "update" },
  });

  assert.equal(ownedResult.allowed, true);
  assert.equal(ownedResult.matched_rule, "ownership:content");
  assert.equal(deniedResult.allowed, false);
  assert.equal(deniedResult.reason.code, "DENY_PERMISSION_MISSING");
});

test("authorization service denies peer or higher protected targets by default", async () => {
  const service = createAuthorizationService({
    permissionResolver: {
      async getEffectivePermissions() {
        return {
          user_id: "user_admin",
          permission_codes: ["admin.users.update"],
        };
      },
    },
  });

  const peerResult = await service.evaluate({
    subject: { kind: "user", user_id: "user_admin", staff_level: 8 },
    resource: { kind: "user", target_user_id: "user_target", target_staff_level: 8, is_protected: true },
    context: { permission_code: "admin.users.update", action: "update" },
  });

  const lowerResult = await service.evaluate({
    subject: { kind: "user", user_id: "user_admin", staff_level: 7 },
    resource: { kind: "role", target_role_id: "role_owner", target_staff_level: 10, is_protected: true },
    context: { permission_code: "admin.users.update", action: "update" },
  });

  assert.equal(peerResult.allowed, false);
  assert.equal(peerResult.reason.code, "DENY_PROTECTED_TARGET");
  assert.equal(lowerResult.allowed, false);
  assert.equal(lowerResult.matched_rule, "staff-level:protected-target");
});

test("authorization service allows override path for protected targets when explicit override is supplied", async () => {
  const service = createAuthorizationService({
    permissionResolver: {
      async getEffectivePermissions() {
        return {
          user_id: "user_super_admin",
          permission_codes: ["admin.roles.assign"],
        };
      },
    },
  });

  const result = await service.evaluate({
    subject: { kind: "user", user_id: "user_super_admin", staff_level: 9 },
    resource: { kind: "role", target_role_id: "role_owner", target_staff_level: 10, is_protected: true },
    context: {
      permission_code: "admin.roles.assign",
      action: "assign",
      override_target_protection: true,
    },
  });

  assert.equal(result.allowed, true);
  assert.equal(result.reason.code, "ALLOW_RBAC_PERMISSION");
});

test("authorization service rejects evaluations without a permission code", async () => {
  const service = createAuthorizationService({
    permissionResolver: {
      async getEffectivePermissions() {
        throw new Error("should not resolve permissions");
      },
    },
  });

  const result = await service.evaluate({
    subject: { kind: "user", user_id: "user_3" },
    context: { action: "read" },
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason.code, "DENY_EXPLICIT_RULE");
});
