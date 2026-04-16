import { getDatabase } from "../index.mjs";

const USER_REGION_ASSIGNMENT_COLUMNS = [
  "id",
  "user_id",
  "region_id",
  "assignment_type",
  "is_primary",
  "starts_at",
  "ends_at",
  "assigned_by_user_id",
  "created_at",
];

function normalizeBoolean(value) {
  if (value === null || value === undefined) {
    return value;
  }

  return Boolean(value);
}

function normalizeUserRegionAssignment(row) {
  if (!row) {
    return undefined;
  }

  return {
    ...row,
    is_primary: normalizeBoolean(row.is_primary),
  };
}

function baseUserRegionAssignmentQuery(executor) {
  return executor.selectFrom("user_region_assignments").select(USER_REGION_ASSIGNMENT_COLUMNS);
}

export function createUserRegionAssignmentRepository(executor = getDatabase()) {
  return {
    async createUserRegionAssignment(input) {
      await executor.insertInto("user_region_assignments").values({
        id: input.id,
        user_id: input.user_id,
        region_id: input.region_id,
        assignment_type: input.assignment_type ?? "member",
        is_primary: input.is_primary ?? false,
        starts_at: input.starts_at,
        ends_at: input.ends_at ?? null,
        assigned_by_user_id: input.assigned_by_user_id ?? null,
        created_at: input.created_at ?? undefined,
      }).execute();

      return this.getUserRegionAssignmentById(input.id);
    },

    async getUserRegionAssignmentById(id) {
      const row = await baseUserRegionAssignmentQuery(executor).where("id", "=", id).executeTakeFirst();
      return normalizeUserRegionAssignment(row);
    },

    async listUserRegionAssignmentsByUserId(userId, options = {}) {
      let query = baseUserRegionAssignmentQuery(executor)
        .where("user_id", "=", userId)
        .orderBy("is_primary", "desc")
        .orderBy("starts_at", "desc")
        .orderBy("id", "asc");

      if (options.activeOnly === true) {
        query = query.where("ends_at", "is", null);
      }

      const rows = await query.execute();
      return rows.map(normalizeUserRegionAssignment);
    },

    async listUserRegionAssignmentsByRegionId(regionId, options = {}) {
      let query = baseUserRegionAssignmentQuery(executor)
        .where("region_id", "=", regionId)
        .orderBy("user_id", "asc")
        .orderBy("starts_at", "desc")
        .orderBy("id", "asc");

      if (options.activeOnly === true) {
        query = query.where("ends_at", "is", null);
      }

      const rows = await query.execute();
      return rows.map(normalizeUserRegionAssignment);
    },

    async listActivePrimaryAssignments() {
      const rows = await baseUserRegionAssignmentQuery(executor)
        .where("is_primary", "=", true)
        .where("ends_at", "is", null)
        .orderBy("user_id", "asc")
        .orderBy("starts_at", "desc")
        .execute();

      return rows.map(normalizeUserRegionAssignment);
    },
  };
}

export { USER_REGION_ASSIGNMENT_COLUMNS, normalizeUserRegionAssignment };
