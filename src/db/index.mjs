import { createDatabase } from "./client/postgres.mjs";
import {
  acquireAdvisoryXactLock,
  buildAdvisoryLockKey,
  isSerializationFailure,
  SQLSTATE_DEADLOCK_DETECTED,
  SQLSTATE_SERIALIZATION_FAILURE,
  withAdvisoryXactLock,
  withSerializableRetry,
} from "./concurrency.mjs";
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
  acquireAdvisoryXactLock,
  buildAdvisoryLockKey,
  classifyDatabaseError,
  createDatabase,
  DATABASE_ERROR_KIND,
  defineTransactionStrategy,
  isDatabaseErrorKind,
  isSerializationFailure,
  SQLSTATE_DEADLOCK_DETECTED,
  SQLSTATE_SERIALIZATION_FAILURE,
  withAdvisoryXactLock,
  withSerializableRetry,
  withTransaction,
};
