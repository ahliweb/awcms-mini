import test from "node:test";
import assert from "node:assert/strict";

import { getSecurityPolicy, resetSecurityPolicy, resolveMandatoryTwoFactorRoleIds, updateSecurityPolicy } from "../../src/security/policy.mjs";

function createFakeOptionsDb(initial = {}) {
  const rows = new Map(Object.entries(initial));

  return {
    selectFrom(table) {
      assert.equal(table, "options");
      const whereClauses = [];

      const query = {
        select() {
          return query;
        },
        where(column, operator, value) {
          whereClauses.push({ column, operator, value });
          return query;
        },
        async executeTakeFirst() {
          const name = whereClauses.find((clause) => clause.column === "name" && clause.operator === "=")?.value;
          if (!rows.has(name)) {
            return undefined;
          }

          return {
            name,
            value: rows.get(name),
          };
        },
      };

      return query;
    },
    insertInto(table) {
      assert.equal(table, "options");
      return {
        values(input) {
          return {
            async execute() {
              rows.set(input.name, input.value);
            },
          };
        },
      };
    },
    updateTable(table) {
      assert.equal(table, "options");
      let nextValue;
      let nextName;

      const chain = {
        set(input) {
          nextValue = input.value;
          return chain;
        },
        where(column, operator, value) {
          assert.equal(column, "name");
          assert.equal(operator, "=");
          nextName = value;
          return chain;
        },
        async execute() {
          rows.set(nextName, nextValue);
        },
      };

      return chain;
    },
    read(name) {
      return rows.get(name);
    },
  };
}

test("security policy supports protected-role rollout and custom role selection", async () => {
  const roles = [
    { id: "role_owner", isProtected: true },
    { id: "role_editor", isProtected: false },
  ];
  const db = createFakeOptionsDb();

  await resetSecurityPolicy({ database: db });

  const protectedFirst = await updateSecurityPolicy({ mandatoryTwoFactorRolloutMode: "protected_roles" }, { database: db, roles });
  assert.equal(protectedFirst.mandatoryTwoFactorRolloutMode, "protected_roles");
  assert.deepEqual(protectedFirst.mandatoryTwoFactorRoleIds, ["role_owner"]);
  assert.deepEqual(protectedFirst.customMandatoryTwoFactorRoleIds, []);

  const custom = await updateSecurityPolicy({ mandatoryTwoFactorRolloutMode: "custom", customMandatoryTwoFactorRoleIds: ["role_editor"] }, { database: db, roles });
  assert.equal(custom.mandatoryTwoFactorRolloutMode, "custom");
  assert.deepEqual(custom.mandatoryTwoFactorRoleIds, ["role_editor"]);
  assert.deepEqual((await getSecurityPolicy({ database: db, roles })).customMandatoryTwoFactorRoleIds, ["role_editor"]);
  assert.match(db.read("awcms.security.policy"), /role_editor/);

  assert.deepEqual(resolveMandatoryTwoFactorRoleIds({ mandatoryTwoFactorRolloutMode: "protected_roles" }, roles), ["role_owner"]);
  await resetSecurityPolicy({ database: db });
  assert.deepEqual((await getSecurityPolicy({ database: db, roles })).mandatoryTwoFactorRoleIds, []);
});
