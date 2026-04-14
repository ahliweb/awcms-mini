const DEFAULT_SAVEPOINT_NAME = "nested_operation";

function isControlledTransaction(executor) {
  return Boolean(
    executor &&
      typeof executor === "object" &&
      typeof executor.commit === "function" &&
      typeof executor.rollback === "function",
  );
}

async function withRootTransaction(db, callback) {
  const trx = await db.startTransaction().execute();

  try {
    const result = await callback(trx);
    await trx.commit().execute();
    return result;
  } catch (error) {
    await trx.rollback().execute();
    throw error;
  }
}

async function withSavepoint(trx, callback, savepointName = DEFAULT_SAVEPOINT_NAME) {
  const savepoint = await trx.savepoint(savepointName).execute();

  try {
    const result = await callback(savepoint);
    await savepoint.releaseSavepoint(savepointName).execute();
    return result;
  } catch (error) {
    await savepoint.rollbackToSavepoint(savepointName).execute();
    throw error;
  }
}

export async function withTransaction(executor, callback, options = {}) {
  const nested = options.nested ?? "reuse";
  const savepointName = options.savepointName ?? DEFAULT_SAVEPOINT_NAME;

  if (isControlledTransaction(executor)) {
    if (nested === "reuse") {
      return callback(executor);
    }

    if (nested === "savepoint") {
      return withSavepoint(executor, callback, savepointName);
    }

    throw new Error(`Unsupported nested transaction strategy: ${nested}`);
  }

  if (!executor || typeof executor.startTransaction !== "function") {
    throw new Error("withTransaction requires a Kysely database or controlled transaction executor");
  }

  return withRootTransaction(executor, callback);
}

export function defineTransactionStrategy(nested = "reuse") {
  if (!["reuse", "savepoint"].includes(nested)) {
    throw new Error(`Unsupported transaction strategy: ${nested}`);
  }

  return { nested };
}
