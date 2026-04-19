import test from "node:test";
import assert from "node:assert/strict";

import { handleSetupStatus } from "../../src/auth/handlers/setup-status.mjs";

function createDbStub({ options = [], userCount = 0, throwOptions = false, throwUsers = false } = {}) {
  return {
    selectFrom(table) {
      return {
        select() {
          return this;
        },
        where(column, operator, value) {
          void column;
          void operator;
          this.value = value;
          return this;
        },
        executeTakeFirst() {
          if (table === "options") {
            if (throwOptions) {
              throw new Error("options table missing");
            }

            const match = options.find((entry) => entry.name === this.value);
            return Promise.resolve(match ? { value: match.value } : undefined);
          }

          return Promise.resolve(undefined);
        },
        executeTakeFirstOrThrow() {
          if (table === "users") {
            if (throwUsers) {
              throw new Error("users table missing");
            }

            return Promise.resolve({ count: userCount });
          }

          throw new Error(`Unsupported table ${table}`);
        },
      };
    },
  };
}

test("handleSetupStatus reports a fresh setup state when Mini tables are missing", async () => {
  const response = await handleSetupStatus({
    db: createDbStub({ throwOptions: true, throwUsers: true }),
  });

  assert.equal(response.status, 200);

  const body = await response.json();
  assert.deepEqual(body, {
    data: {
      needsSetup: true,
      step: "start",
      seedInfo: null,
      authMode: "passkey",
    },
  });
});

test("handleSetupStatus reports setup complete when the flag is set and users exist", async () => {
  const response = await handleSetupStatus({
    db: createDbStub({
      options: [{ name: "emdash:setup_complete", value: "true" }],
      userCount: 1,
    }),
  });

  assert.equal(response.status, 200);

  const body = await response.json();
  assert.deepEqual(body, {
    data: {
      needsSetup: false,
    },
  });
});
