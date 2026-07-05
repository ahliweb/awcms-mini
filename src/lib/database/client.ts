let sharedClient: Bun.SQL | undefined;

export function getDatabaseClient(): Bun.SQL {
  if (!sharedClient) {
    const databaseUrl = process.env.DATABASE_URL;

    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required to connect to the database.");
    }

    sharedClient = new Bun.SQL(databaseUrl);
  }

  return sharedClient;
}
