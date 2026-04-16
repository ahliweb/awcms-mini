import test from "node:test";
import assert from "node:assert/strict";

import { createJobsService, JobAssignmentError } from "../../src/services/jobs/service.mjs";

function createFakeDatabase() {
  const state = {
    users: [],
    job_levels: [],
    job_titles: [],
    user_jobs: [],
    audit_logs: [],
    transactions: 0,
  };

  const executor = {
    insertInto(table) {
      return {
        values: (values) => ({
          execute: async () => {
            state[table].push({
              created_at: values.created_at ?? "2026-01-01T00:00:00.000Z",
              updated_at: values.updated_at ?? "2026-01-01T00:00:00.000Z",
              deleted_at: values.deleted_at ?? null,
              ends_at: values.ends_at ?? null,
              is_primary: values.is_primary ?? false,
              is_system: values.is_system ?? false,
              is_active: values.is_active ?? true,
              ...values,
            });
          },
        }),
      };
    },

    selectFrom(table) {
      const source = state[table];
      const local = { where: [], orderBy: [], limit: undefined, offset: undefined };

      const apply = () => {
        let rows = [...source];

        for (const clause of local.where) {
          if (clause.operator === "=" || clause.operator === "is") {
            rows = rows.filter((row) => row[clause.column] === clause.value);
          } else if (clause.operator === "is not") {
            rows = rows.filter((row) => row[clause.column] !== clause.value);
          }
        }

        rows.sort((left, right) => {
          for (const clause of local.orderBy) {
            const leftValue = String(left[clause.column] ?? "");
            const rightValue = String(right[clause.column] ?? "");
            const comparison = leftValue.localeCompare(rightValue);
            if (comparison !== 0) {
              return clause.direction === "desc" ? -comparison : comparison;
            }
          }
          return 0;
        });

        if (local.offset !== undefined) rows = rows.slice(local.offset);
        if (local.limit !== undefined) rows = rows.slice(0, local.limit);
        return rows;
      };

      const query = {
        select: () => query,
        where: (column, operator, value) => {
          local.where.push({ column, operator, value });
          return query;
        },
        orderBy: (column, direction = "asc") => {
          local.orderBy.push({ column, direction });
          return query;
        },
        limit: (limit) => {
          local.limit = limit;
          return query;
        },
        offset: (offset) => {
          local.offset = offset;
          return query;
        },
        execute: async () => apply(),
        executeTakeFirst: async () => apply()[0],
      };

      return query;
    },

    updateTable(table) {
      const source = state[table];
      const local = { values: undefined, where: [] };

      return {
        set: (values) => {
          local.values = values;
          const chain = {
            where: (column, operator, value) => {
              local.where.push({ column, operator, value });
              return chain;
            },
            execute: async () => {
              for (const row of source) {
                const matches = local.where.every((clause) => {
                  if (clause.operator === "=" || clause.operator === "is") return row[clause.column] === clause.value;
                  if (clause.operator === "is not") return row[clause.column] !== clause.value;
                  return false;
                });
                if (!matches) continue;
                Object.assign(row, local.values);
              }
            },
          };
          return chain;
        },
      };
    },

    startTransaction() {
      return {
        execute: async () => {
          state.transactions += 1;
          return {
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
          };
        },
      };
    },
  };

  return { database: executor, state };
}

function seedBaseState(state) {
  state.users.push(
    { id: "user_1", status: "active", deleted_at: null },
    { id: "user_2", status: "active", deleted_at: null },
    { id: "user_3", status: "active", deleted_at: null },
  );

  state.job_levels.push(
    { id: "level_1", code: "manager", rank_order: 7, name: "Manager", is_system: true, deleted_at: null },
    { id: "level_2", code: "director", rank_order: 9, name: "Director", is_system: true, deleted_at: null },
  );

  state.job_titles.push(
    { id: "title_1", job_level_id: "level_1", code: "ops_manager", name: "Ops Manager", is_active: true, deleted_at: null },
    { id: "title_2", job_level_id: "level_2", code: "division_director", name: "Division Director", is_active: true, deleted_at: null },
  );
}

test("jobs service assigns the first job as primary and lists active jobs", async () => {
  const { database, state } = createFakeDatabase();
  seedBaseState(state);
  const service = createJobsService({ database });

  const assigned = await service.assignJob({
    id: "job_1",
    user_id: "user_1",
    job_level_id: "level_1",
    job_title_id: "title_1",
    starts_at: "2026-01-01T00:00:00.000Z",
  });

  assert.equal(assigned.is_primary, true);

  const active = await service.listActiveJobs("user_1");
  assert.deepEqual(active.map((job) => job.id), ["job_1"]);
  assert.deepEqual(state.audit_logs.map((entry) => entry.action), ["job.assign"]);
  assert.equal(state.transactions, 2);
});

test("jobs service enforces one active primary job when changing the primary assignment", async () => {
  const { database, state } = createFakeDatabase();
  seedBaseState(state);
  const service = createJobsService({ database });

  await service.assignJob({
    id: "job_1",
    user_id: "user_1",
    job_level_id: "level_1",
    job_title_id: "title_1",
    starts_at: "2026-01-01T00:00:00.000Z",
  });

  const changed = await service.changeJob({
    id: "job_2",
    job_id: "job_1",
    job_level_id: "level_2",
    job_title_id: "title_2",
    starts_at: "2026-02-01T00:00:00.000Z",
    is_primary: true,
  });

  assert.equal(changed.job_level_id, "level_2");
  assert.equal(state.user_jobs.find((job) => job.id === "job_1").ends_at, "2026-02-01T00:00:00.000Z");

  const active = await service.listActiveJobs("user_1");
  assert.deepEqual(active.map((job) => job.id), ["job_2"]);
  assert.deepEqual(state.audit_logs.map((entry) => entry.action), ["job.assign", "job.change"]);
});

test("jobs service ends active jobs without deleting history", async () => {
  const { database, state } = createFakeDatabase();
  seedBaseState(state);
  const service = createJobsService({ database });

  await service.assignJob({
    id: "job_1",
    user_id: "user_1",
    job_level_id: "level_1",
    job_title_id: "title_1",
    starts_at: "2026-01-01T00:00:00.000Z",
  });

  const ended = await service.endJob({
    job_id: "job_1",
    ends_at: "2026-03-01T00:00:00.000Z",
  });

  assert.equal(ended.ends_at, "2026-03-01T00:00:00.000Z");
  assert.equal((await service.listActiveJobs("user_1")).length, 0);
  assert.deepEqual(state.audit_logs.map((entry) => entry.action), ["job.assign", "job.end"]);
});

test("jobs service rejects title-level mismatches and supervisor cycles", async () => {
  const { database, state } = createFakeDatabase();
  seedBaseState(state);
  const service = createJobsService({ database });

  await assert.rejects(
    () =>
      service.assignJob({
        id: "job_bad",
        user_id: "user_1",
        job_level_id: "level_1",
        job_title_id: "title_2",
        starts_at: "2026-01-01T00:00:00.000Z",
      }),
    (error) => error instanceof JobAssignmentError && error.code === "JOB_TITLE_LEVEL_MISMATCH",
  );

  await service.assignJob({
    id: "job_1",
    user_id: "user_1",
    job_level_id: "level_1",
    job_title_id: "title_1",
    supervisor_user_id: "user_2",
    starts_at: "2026-01-01T00:00:00.000Z",
  });
  await service.assignJob({
    id: "job_2",
    user_id: "user_2",
    job_level_id: "level_1",
    job_title_id: "title_1",
    supervisor_user_id: "user_3",
    starts_at: "2026-01-01T00:00:00.000Z",
  });

  await assert.rejects(
    () =>
      service.assignJob({
        id: "job_3",
        user_id: "user_3",
        job_level_id: "level_2",
        job_title_id: "title_2",
        supervisor_user_id: "user_1",
        starts_at: "2026-01-01T00:00:00.000Z",
      }),
    (error) => error instanceof JobAssignmentError && error.code === "SUPERVISOR_CYCLE",
  );
});
