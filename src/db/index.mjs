import { createDatabase } from "./client/postgres.mjs";
import { classifyDatabaseError, DATABASE_ERROR_KIND, isDatabaseErrorKind } from "./errors.mjs";
import { defineTransactionStrategy, withTransaction } from "./transactions.mjs";

let databaseInstance;

export function getDatabase() {
  if (!databaseInstance) {
    databaseInstance = createDatabase();
  }

  return databaseInstance;
}

export async function destroyDatabase() {
  if (!databaseInstance) {
    return;
  }

  await databaseInstance.destroy();
  databaseInstance = undefined;
}

export {
  classifyDatabaseError,
  createDatabase,
  DATABASE_ERROR_KIND,
  defineTransactionStrategy,
  isDatabaseErrorKind,
  withTransaction,
};
