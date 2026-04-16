import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAdministrativeRegionPatch,
  createAdministrativeRegionRepository,
} from "../../src/db/repositories/administrative-regions.mjs";
import { createUserAdministrativeRegionAssignmentRepository } from "../../src/db/repositories/user-administrative-region-assignments.mjs";

class FakeAdministrativeRegionsExecutor {
  constructor() {
    this.administrative_regions = [];
    this.user_administrative_region_assignments = [];
  }

  insertInto(table) {
    const source = this[table];
    assert.ok(Array.isArray(source));

    return {
      values: (values) => ({
        execute: async () => {
          const items = Array.isArray(values) ? values : [values];

          for (const item of items) {
            source.push({
              created_at: item.created_at ?? "2026-01-01T00:00:00.000Z",
              updated_at: item.updated_at ?? "2026-01-01T00:00:00.000Z",
              ends_at: item.ends_at ?? null,
              is_active: item.is_active ?? true,
              is_primary: item.is_primary ?? false,
              assignment_type: item.assignment_type ?? "member",
              ...item,
            });
          }
        },
      }),
    };
  }

  selectFrom(table) {
    const source = this[table];
    assert.ok(Array.isArray(source));
    const state = { where: [], orderBy: [], limit: undefined, offset: undefined };

    const apply = () => {
      let rows = [...source];

      for (const clause of state.where) {
        if (clause.operator === "=" || clause.operator === "is") {
          rows = rows.filter((row) => row[clause.column] === clause.value);
        } else if (clause.operator === "is not") {
          rows = rows.filter((row) => row[clause.column] !== clause.value);
        }
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
        state.where.push({ column, operator, value });
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

  updateTable(table) {
    const source = this[table];
    assert.ok(Array.isArray(source));
    const state = { values: undefined, where: [] };

    return {
      set: (values) => {
        state.values = values;
        const chain = {
          where: (column, operator, value) => {
            state.where.push({ column, operator, value });
            return chain;
          },
          execute: async () => {
            for (const row of source) {
              const matches = state.where.every((clause) => {
                if (clause.operator === "=" || clause.operator === "is") return row[clause.column] === clause.value;
                if (clause.operator === "is not") return row[clause.column] !== clause.value;
                return false;
              });

              if (!matches) continue;

              for (const [key, nextValue] of Object.entries(state.values)) {
                row[key] = nextValue !== null && typeof nextValue === "object" ? "2026-01-02T00:00:00.000Z" : nextValue;
              }
            }
          },
        };

        return chain;
      },
    };
  }
}

test("buildAdministrativeRegionPatch filters unsupported fields and adds updated_at", () => {
  const patch = buildAdministrativeRegionPatch({ name: "Updated", random: true });
  assert.equal(patch.name, "Updated");
  assert.equal(Object.hasOwn(patch, "random"), false);
  assert.equal(Object.hasOwn(patch, "updated_at"), true);
});

test("administrative region repository supports create/get/list/lineage/subtree/update flows", async () => {
  const executor = new FakeAdministrativeRegionsExecutor();
  const repo = createAdministrativeRegionRepository(executor);

  await repo.createAdministrativeRegion({
    id: "province_jb",
    code: "province-jb",
    name: "Jawa Barat",
    type: "province",
    path: "province_jb",
    province_code: "32",
  });
  await repo.createAdministrativeRegion({
    id: "regency_bdg",
    code: "regency-bdg",
    name: "Bandung",
    type: "regency_city",
    parent_id: "province_jb",
    path: "province_jb/regency_bdg",
    province_code: "32",
    regency_code: "32.04",
  });
  await repo.createAdministrativeRegion({
    id: "district_coblong",
    code: "district-coblong",
    name: "Coblong",
    type: "district",
    parent_id: "regency_bdg",
    path: "province_jb/regency_bdg/district_coblong",
    province_code: "32",
    regency_code: "32.04",
    district_code: "32.04.10",
  });

  const byCode = await repo.getAdministrativeRegionByCode("regency-bdg");
  assert.equal(byCode.id, "regency_bdg");

  const roots = await repo.listAdministrativeRegions({ parent_id: null });
  assert.deepEqual(roots.map((entry) => entry.id), ["province_jb"]);

  const children = await repo.listAdministrativeRegionChildren("province_jb");
  assert.deepEqual(children.map((entry) => entry.id), ["regency_bdg"]);

  const lineage = await repo.listAdministrativeRegionLineage("district_coblong");
  assert.deepEqual(lineage.map((entry) => entry.id), ["province_jb", "regency_bdg", "district_coblong"]);

  const subtree = await repo.listAdministrativeRegionSubtree("regency_bdg");
  assert.deepEqual(subtree.map((entry) => entry.id), ["regency_bdg", "district_coblong"]);

  const updated = await repo.updateAdministrativeRegion("regency_bdg", { name: "Bandung Updated", is_active: false });
  assert.equal(updated.name, "Bandung Updated");
  assert.equal(updated.is_active, false);
});

test("user administrative region assignment repository supports history and active-primary queries", async () => {
  const executor = new FakeAdministrativeRegionsExecutor();
  const repo = createUserAdministrativeRegionAssignmentRepository(executor);

  await repo.createUserAdministrativeRegionAssignment({
    id: "assignment_1",
    user_id: "user_1",
    administrative_region_id: "regency_bdg",
    assignment_type: "manager",
    is_primary: true,
    starts_at: "2026-01-01T00:00:00.000Z",
  });
  await repo.createUserAdministrativeRegionAssignment({
    id: "assignment_2",
    user_id: "user_1",
    administrative_region_id: "district_coblong",
    assignment_type: "member",
    starts_at: "2025-01-01T00:00:00.000Z",
    ends_at: "2025-12-31T00:00:00.000Z",
  });
  await repo.createUserAdministrativeRegionAssignment({
    id: "assignment_3",
    user_id: "user_2",
    administrative_region_id: "regency_bdg",
    assignment_type: "member",
    is_primary: true,
    starts_at: "2026-01-02T00:00:00.000Z",
  });

  const byId = await repo.getUserAdministrativeRegionAssignmentById("assignment_1");
  assert.equal(byId.assignment_type, "manager");

  const history = await repo.listUserAdministrativeRegionAssignmentsByUserId("user_1");
  assert.equal(history.length, 2);

  const active = await repo.listUserAdministrativeRegionAssignmentsByUserId("user_1", { activeOnly: true });
  assert.deepEqual(active.map((entry) => entry.id), ["assignment_1"]);

  const byRegion = await repo.listUserAdministrativeRegionAssignmentsByRegionId("regency_bdg", { activeOnly: true });
  assert.deepEqual(byRegion.map((entry) => entry.id), ["assignment_1", "assignment_3"]);

  const primary = await repo.listActivePrimaryAssignments();
  assert.deepEqual(primary.map((entry) => entry.id), ["assignment_1", "assignment_3"]);
});
