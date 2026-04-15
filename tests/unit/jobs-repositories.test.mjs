import test from "node:test";
import assert from "node:assert/strict";

import { buildJobLevelPatch, createJobLevelRepository } from "../../src/db/repositories/job-levels.mjs";
import { buildJobTitlePatch, createJobTitleRepository } from "../../src/db/repositories/job-titles.mjs";
import { createUserJobRepository } from "../../src/db/repositories/user-jobs.mjs";

class FakeJobsExecutor {
  constructor() {
    this.job_levels = [];
    this.job_titles = [];
    this.user_jobs = [];
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
              ends_at: item.ends_at ?? null,
              is_system: item.is_system ?? false,
              is_active: item.is_active ?? true,
              is_primary: item.is_primary ?? false,
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

test("buildJobLevelPatch filters unsupported fields and adds updated_at", () => {
  const patch = buildJobLevelPatch({ name: "Updated", random: true });
  assert.equal(patch.name, "Updated");
  assert.equal(Object.hasOwn(patch, "random"), false);
  assert.equal(Object.hasOwn(patch, "updated_at"), true);
});

test("buildJobTitlePatch filters unsupported fields and adds updated_at", () => {
  const patch = buildJobTitlePatch({ name: "Updated", random: true });
  assert.equal(patch.name, "Updated");
  assert.equal(Object.hasOwn(patch, "random"), false);
  assert.equal(Object.hasOwn(patch, "updated_at"), true);
});

test("job level repository supports create/get/list/update flows", async () => {
  const executor = new FakeJobsExecutor();
  const repo = createJobLevelRepository(executor);

  const created = await repo.createJobLevel({ id: "level_1", code: "manager", name: "Manager", rank_order: 7, is_system: true });
  assert.equal(created.code, "manager");

  const byCode = await repo.getJobLevelByCode("manager");
  assert.equal(byCode.id, "level_1");

  const updated = await repo.updateJobLevel("level_1", { name: "Senior Manager" });
  assert.equal(updated.name, "Senior Manager");

  const listed = await repo.listJobLevels({ is_system: true });
  assert.equal(listed.length, 1);
});

test("job title repository supports create/get/list/update flows", async () => {
  const executor = new FakeJobsExecutor();
  const repo = createJobTitleRepository(executor);

  const created = await repo.createJobTitle({ id: "title_1", job_level_id: "level_1", code: "ops_manager", name: "Ops Manager" });
  assert.equal(created.code, "ops_manager");

  const byCode = await repo.getJobTitleByCode("ops_manager");
  assert.equal(byCode.id, "title_1");

  const updated = await repo.updateJobTitle("title_1", { is_active: false });
  assert.equal(updated.is_active, false);

  const listed = await repo.listJobTitles({ job_level_id: "level_1" });
  assert.equal(listed.length, 1);
});

test("user job repository supports assignment history and active queries", async () => {
  const executor = new FakeJobsExecutor();
  const repo = createUserJobRepository(executor);

  await repo.createUserJob({
    id: "job_1",
    user_id: "user_1",
    job_level_id: "level_1",
    job_title_id: "title_1",
    supervisor_user_id: "user_manager",
    starts_at: "2026-01-01T00:00:00.000Z",
    is_primary: true,
  });
  await repo.createUserJob({
    id: "job_2",
    user_id: "user_1",
    job_level_id: "level_2",
    job_title_id: "title_2",
    supervisor_user_id: "user_director",
    starts_at: "2025-01-01T00:00:00.000Z",
    ends_at: "2025-12-31T00:00:00.000Z",
    is_primary: false,
  });
  await repo.createUserJob({
    id: "job_3",
    user_id: "user_2",
    job_level_id: "level_1",
    job_title_id: "title_1",
    supervisor_user_id: "user_manager",
    starts_at: "2026-01-02T00:00:00.000Z",
    is_primary: true,
  });

  const byId = await repo.getUserJobById("job_1");
  assert.equal(byId.supervisor_user_id, "user_manager");

  const history = await repo.listUserJobsByUserId("user_1");
  assert.equal(history.length, 2);

  const active = await repo.listUserJobsByUserId("user_1", { activeOnly: true });
  assert.deepEqual(active.map((job) => job.id), ["job_1"]);

  const primary = await repo.listActivePrimaryJobs();
  assert.deepEqual(primary.map((job) => job.id), ["job_1", "job_3"]);

  const supervised = await repo.listUserJobsBySupervisorId("user_manager", { activeOnly: true });
  assert.deepEqual(supervised.map((job) => job.id), ["job_1", "job_3"]);
});
