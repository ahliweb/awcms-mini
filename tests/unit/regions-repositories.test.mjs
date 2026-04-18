import test from "node:test";
import assert from "node:assert/strict";

import { buildRegionPatch, createRegionRepository } from "../../src/db/repositories/regions.mjs";
import { createUserRegionAssignmentRepository } from "../../src/db/repositories/user-region-assignments.mjs";

class FakeRegionsExecutor {
  constructor() {
    this.regions = [];
    this.user_region_assignments = [];
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
              deleted_at: item.deleted_at ?? null,
              deleted_by_user_id: item.deleted_by_user_id ?? null,
              delete_reason: item.delete_reason ?? null,
              ends_at: item.ends_at ?? null,
              sort_order: item.sort_order ?? 0,
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

              if (!matches) {
                continue;
              }

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

test("buildRegionPatch filters unsupported fields and adds updated_at", () => {
  const patch = buildRegionPatch({ name: "Updated", random: true });
  assert.equal(patch.name, "Updated");
  assert.equal(Object.hasOwn(patch, "random"), false);
  assert.equal(Object.hasOwn(patch, "updated_at"), true);
});

test("region repository supports create/get/list/lineage/subtree/update flows", async () => {
  const executor = new FakeRegionsExecutor();
  const repo = createRegionRepository(executor);

  await repo.createRegion({ id: "region_root", code: "root", name: "Root", level: 1, path: "region_root", sort_order: 1 });
  await repo.createRegion({
    id: "region_north",
    code: "north",
    name: "North",
    parent_id: "region_root",
    level: 2,
    path: "region_root/region_north",
    sort_order: 1,
  });
  await repo.createRegion({
    id: "region_jakarta",
    code: "jakarta",
    name: "Jakarta",
    parent_id: "region_north",
    level: 3,
    path: "region_root/region_north/region_jakarta",
    sort_order: 2,
  });
  await repo.createRegion({
    id: "region_archived",
    code: "archived",
    name: "Archived",
    parent_id: "region_root",
    level: 2,
    path: "region_root/region_archived",
  });
  await repo.softDeleteRegion("region_archived", { deleted_at: "2026-01-15T00:00:00.000Z" });

  const byCode = await repo.getRegionByCode("north");
  assert.equal(byCode.id, "region_north");

  const roots = await repo.listRegions({ parent_id: null });
  assert.deepEqual(roots.map((entry) => entry.id), ["region_root"]);

  const children = await repo.listRegionChildren("region_root");
  assert.deepEqual(children.map((entry) => entry.id), ["region_north"]);

  const lineage = await repo.listRegionLineage("region_jakarta");
  assert.deepEqual(lineage.map((entry) => entry.id), ["region_root", "region_north", "region_jakarta"]);

  const subtree = await repo.listRegionSubtree("region_north");
  assert.deepEqual(subtree.map((entry) => entry.id), ["region_north", "region_jakarta"]);

  const updated = await repo.updateRegion("region_north", { name: "North Updated", is_active: false });
  assert.equal(updated.name, "North Updated");
  assert.equal(updated.is_active, false);

  const visibleArchived = await repo.getRegionById("region_archived");
  assert.equal(visibleArchived, undefined);

  const includedArchived = await repo.listRegions({ includeDeleted: true });
  assert.equal(includedArchived.some((entry) => entry.id === "region_archived"), true);

  const deleted = await repo.softDeleteRegion("region_north", { deleted_by_user_id: "user_admin", delete_reason: "merge" });
  assert.equal(deleted.deleted_by_user_id, "user_admin");
  assert.equal(deleted.delete_reason, "merge");

  const hidden = await repo.getRegionById("region_north");
  assert.equal(hidden, undefined);

  const restored = await repo.restoreRegion("region_north");
  assert.equal(restored.deleted_at, null);
  assert.equal(restored.delete_reason, null);
});

test("user region assignment repository supports history and active-primary queries", async () => {
  const executor = new FakeRegionsExecutor();
  const repo = createUserRegionAssignmentRepository(executor);

  await repo.createUserRegionAssignment({
    id: "assignment_1",
    user_id: "user_1",
    region_id: "region_north",
    assignment_type: "manager",
    is_primary: true,
    starts_at: "2026-01-01T00:00:00.000Z",
  });
  await repo.createUserRegionAssignment({
    id: "assignment_2",
    user_id: "user_1",
    region_id: "region_jakarta",
    assignment_type: "member",
    starts_at: "2025-01-01T00:00:00.000Z",
    ends_at: "2025-12-31T00:00:00.000Z",
  });
  await repo.createUserRegionAssignment({
    id: "assignment_3",
    user_id: "user_2",
    region_id: "region_north",
    assignment_type: "member",
    is_primary: true,
    starts_at: "2026-01-02T00:00:00.000Z",
  });

  const byId = await repo.getUserRegionAssignmentById("assignment_1");
  assert.equal(byId.assignment_type, "manager");

  const history = await repo.listUserRegionAssignmentsByUserId("user_1");
  assert.equal(history.length, 2);

  const active = await repo.listUserRegionAssignmentsByUserId("user_1", { activeOnly: true });
  assert.deepEqual(active.map((entry) => entry.id), ["assignment_1"]);

  const byRegion = await repo.listUserRegionAssignmentsByRegionId("region_north", { activeOnly: true });
  assert.deepEqual(byRegion.map((entry) => entry.id), ["assignment_1", "assignment_3"]);

  const primary = await repo.listActivePrimaryAssignments();
  assert.deepEqual(primary.map((entry) => entry.id), ["assignment_1", "assignment_3"]);
});
