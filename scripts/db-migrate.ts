import postgres from "postgres";
import { loadMigrationFiles } from "../src/lib/database/migrations";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("DATABASE_URL is required for db:migrate.");
  process.exit(1);
}

const sql = postgres(databaseUrl, { max: 1 });

try {
  const migrations = await loadMigrationFiles();

  await sql.begin(async (tx) => {
    await tx`
      CREATE TABLE IF NOT EXISTS awcms_schema_migrations (
        id bigserial PRIMARY KEY,
        migration_name text NOT NULL UNIQUE,
        checksum text NOT NULL,
        executed_at timestamptz NOT NULL DEFAULT now()
      )
    `;

    for (const migration of migrations) {
      const [applied] = await tx`
        SELECT checksum
        FROM awcms_schema_migrations
        WHERE migration_name = ${migration.name}
      `;

      if (applied) {
        if (applied.checksum !== migration.checksum) {
          throw new Error(`Migration checksum mismatch: ${migration.name}`);
        }
        continue;
      }

      await tx.unsafe(migration.sql);
      await tx`
        INSERT INTO awcms_schema_migrations (migration_name, checksum)
        VALUES (${migration.name}, ${migration.checksum})
      `;
      console.log(`applied ${migration.name}`);
    }
  });
} finally {
  await sql.end();
}
