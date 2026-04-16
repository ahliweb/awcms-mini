import { getDatabase } from "../index.mjs";

const USER_ADMINISTRATIVE_REGION_ASSIGNMENT_COLUMNS = [
  "id",
  "user_id",
  "administrative_region_id",
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

function normalizeUserAdministrativeRegionAssignment(row) {
  if (!row) {
    return undefined;
  }

  return {
    ...row,
    is_primary: normalizeBoolean(row.is_primary),
  };
}

function baseUserAdministrativeRegionAssignmentQuery(executor) {
  return executor.selectFrom("user_administrative_region_assignments").select(USER_ADMINISTRATIVE_REGION_ASSIGNMENT_COLUMNS);
}

export function createUserAdministrativeRegionAssignmentRepository(executor = getDatabase()) {
  return {
    async createUserAdministrativeRegionAssignment(input) {
      await executor.insertInto("user_administrative_region_assignments").values({
        id: input.id,
        user_id: input.user_id,
        administrative_region_id: input.administrative_region_id,
        assignment_type: input.assignment_type ?? "member",
        is_primary: input.is_primary ?? false,
        starts_at: input.starts_at,
        ends_at: input.ends_at ?? null,
        assigned_by_user_id: input.assigned_by_user_id ?? null,
        created_at: input.created_at ?? undefined,
      }).execute();

      return this.getUserAdministrativeRegionAssignmentById(input.id);
    },

    async getUserAdministrativeRegionAssignmentById(id) {
      const row = await baseUserAdministrativeRegionAssignmentQuery(executor).where("id", "=", id).executeTakeFirst();
      return normalizeUserAdministrativeRegionAssignment(row);
    },

    async listUserAdministrativeRegionAssignmentsByUserId(userId, options = {}) {
      let query = baseUserAdministrativeRegionAssignmentQuery(executor)
        .where("user_id", "=", userId)
        .orderBy("is_primary", "desc")
        .orderBy("starts_at", "desc")
        .orderBy("id", "asc");

      if (options.activeOnly === true) {
        query = query.where("ends_at", "is", null);
      }

      const rows = await query.execute();
      return rows.map(normalizeUserAdministrativeRegionAssignment);
    },

    async listUserAdministrativeRegionAssignmentsByRegionId(administrativeRegionId, options = {}) {
      let query = baseUserAdministrativeRegionAssignmentQuery(executor)
        .where("administrative_region_id", "=", administrativeRegionId)
        .orderBy("user_id", "asc")
        .orderBy("starts_at", "desc")
        .orderBy("id", "asc");

      if (options.activeOnly === true) {
        query = query.where("ends_at", "is", null);
      }

      const rows = await query.execute();
      return rows.map(normalizeUserAdministrativeRegionAssignment);
    },

    async listActivePrimaryAssignments() {
      const rows = await baseUserAdministrativeRegionAssignmentQuery(executor)
        .where("is_primary", "=", true)
        .where("ends_at", "is", null)
        .orderBy("user_id", "asc")
        .orderBy("starts_at", "desc")
        .execute();

      return rows.map(normalizeUserAdministrativeRegionAssignment);
    },
  };
}

export {
  USER_ADMINISTRATIVE_REGION_ASSIGNMENT_COLUMNS,
  normalizeUserAdministrativeRegionAssignment,
};
