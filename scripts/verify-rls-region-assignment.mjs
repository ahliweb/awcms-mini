/**
 * Verifikasi RLS plugin assignment/role-based (#353) terhadap PostgreSQL nyata.
 *
 * Pola #352: isolasi RLS HANYA berlaku untuk role **non-superuser** (superuser
 * mem-bypass RLS). Skrip ini karena itu membuat role login non-superuser khusus,
 * menerapkan `buildPluginRlsStatements()` PRODUKSI (bukan reimplementasi), lalu
 * memverifikasi visibilitas baris lewat `withUserContext()` PRODUKSI.
 *
 * Yang dibuktikan (model akses #353):
 *   1. Creator    — pemilik baris (`created_by = app.current_user_id`) selalu lihat.
 *   2. Region     — user dengan penugasan AKTIF (`ends_at is null`) ke region baris
 *                   boleh akses LINTAS-creator.
 *   3. NULL-safe  — baris dengan region NULL hanya untuk creator (tidak melebar).
 *   4. Penugasan kedaluwarsa (`ends_at` lampau) TIDAK memberi akses.
 *   5. Admin bypass (`app.is_admin = 'true'`) melihat semua.
 *   6. User asing (tanpa creator/region/admin) melihat NOL baris.
 *
 * Prasyarat: DATABASE sudah dimigrasi (`bun run db:migrate`) — butuh tabel
 * `public.user_administrative_region_assignments`, `users`, `administrative_regions`.
 * Role admin pada DATABASE_URL harus boleh CREATE ROLE / CREATE SCHEMA (owner DB).
 *
 * Pakai: `bun ./scripts/verify-rls-region-assignment.mjs`  (atau `bun run verify:rls`)
 * Skrip idempotent + self-cleaning: semua objek bertanda prefix `rls_verify` /
 * `rlsv_` dibersihkan di akhir, sukses maupun gagal.
 */
import { randomBytes } from "node:crypto";

import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";

import { applyLocalCloudflareRuntimeEnv, loadLocalEnvFiles } from "./_local-env.mjs";
import { buildPluginRlsStatements, withUserContext } from "../src/db/plugin-adapter.mjs";
import { withTransaction } from "../src/db/transactions.mjs";

const { Client, Pool } = pg;

const TEST_SCHEMA = "rls_verify";
const TEST_ROLE = "rls_verify_app";
// Prefix unik agar baris seed di tabel produksi (users / regions / assignments)
// mudah dibersihkan tanpa menyentuh data lain.
const P = "rlsv_";

const REGION_1 = `${P}region_1`;
const REGION_2 = `${P}region_2`;
const USER_A = `${P}user_a`; // creator row1 (R1) + row2 (NULL)
const USER_B = `${P}user_b`; // creator row3 (R2) + penugasan AKTIF ke R1
const USER_C = `${P}user_c`; // penugasan ke R1 tapi KEDALUWARSA
const USER_X = `${P}user_x`; // user asing tanpa apa pun

function buildTestRoleUrl(adminUrl, password) {
  const url = new URL(adminUrl);
  url.username = TEST_ROLE;
  url.password = password;
  return url.toString();
}

function assertEqual(label, actual, expected, failures) {
  const ok = actual === expected;
  console.log(`  ${ok ? "✅" : "❌"} ${label}: ${actual} (harap ${expected})`);
  if (!ok) {
    failures.push(`${label}: dapat ${actual}, harap ${expected}`);
  }
}

async function seedFixtures(admin) {
  // Region (administrative_regions: code/name/type/path NOT NULL).
  for (const [id, code] of [
    [REGION_1, "RLSV-R1"],
    [REGION_2, "RLSV-R2"],
  ]) {
    await admin.query(
      `insert into administrative_regions (id, code, name, type, path)
       values ($1, $2, $2, 'district', $3) on conflict (id) do nothing`,
      [id, code, id],
    );
  }

  // Users (email unique NOT NULL).
  for (const id of [USER_A, USER_B, USER_C, USER_X]) {
    await admin.query(
      `insert into users (id, email, status) values ($1, $2, 'active')
       on conflict (id) do nothing`,
      [id, `${id}@verify.local`],
    );
  }

  // Penugasan region: USER_B aktif ke R1; USER_C ke R1 tapi sudah berakhir.
  await admin.query(
    `insert into user_administrative_region_assignments
       (id, user_id, administrative_region_id, starts_at, ends_at)
     values
       ($1, $2, $3, now(), null),
       ($4, $5, $3, now() - interval '2 day', now() - interval '1 day')
     on conflict (id) do nothing`,
    [`${P}asg_b`, USER_B, REGION_1, `${P}asg_c`, USER_C],
  );

  // Tabel plugin tiruan + RLS produksi (regionColumn + adminBypass).
  await admin.query(`drop schema if exists ${TEST_SCHEMA} cascade`);
  await admin.query(`create schema ${TEST_SCHEMA}`);
  await admin.query(
    `create table ${TEST_SCHEMA}.records (
       id varchar(64) primary key,
       created_by varchar(64) not null,
       administrative_region_id varchar(64),
       title text not null
     )`,
  );
  for (const statement of buildPluginRlsStatements(TEST_SCHEMA, "records", {
    regionColumn: "administrative_region_id",
    adminBypass: true,
  })) {
    await admin.query(statement);
  }

  // Baris uji:
  //   row1: creator A, region R1  → A (creator) + B (penugasan R1)
  //   row2: creator A, region NULL→ hanya A (NULL-safe)
  //   row3: creator B, region R2  → hanya B (creator); A tak punya penugasan R2
  await admin.query(
    `insert into ${TEST_SCHEMA}.records (id, created_by, administrative_region_id, title)
     values ('row1', $1, $2, 'A@R1'), ('row2', $1, null, 'A@NULL'), ('row3', $3, $4, 'B@R2')`,
    [USER_A, REGION_1, USER_B, REGION_2],
  );
}

async function provisionTestRole(admin, password) {
  const { rows } = await admin.query(`select 1 from pg_roles where rolname = $1`, [
    TEST_ROLE,
  ]);
  if (rows.length > 0) {
    await admin.query(`drop owned by ${TEST_ROLE}`);
    await admin.query(`drop role ${TEST_ROLE}`);
  }
  await admin.query(
    `create role ${TEST_ROLE} login password '${password}' nosuperuser nocreatedb nocreaterole`,
  );
  await admin.query(`grant usage on schema ${TEST_SCHEMA} to ${TEST_ROLE}`);
  await admin.query(`grant select on ${TEST_SCHEMA}.records to ${TEST_ROLE}`);
  await admin.query(
    `grant select on public.user_administrative_region_assignments to ${TEST_ROLE}`,
  );
}

async function countVisibleAs(db, userId) {
  const rows = await withUserContext(db, userId, (trx) =>
    trx.withSchema(TEST_SCHEMA).selectFrom("records").select("id").execute(),
  );
  return rows.map((r) => r.id).sort();
}

async function countVisibleAsAdmin(db, userId) {
  // Admin bypass butuh app.is_admin selain app.current_user_id pada transaksi yang sama.
  return withTransaction(db, async (trx) => {
    await sql`select set_config('app.current_user_id', ${userId}, true)`.execute(trx);
    await sql`select set_config('app.is_admin', 'true', true)`.execute(trx);
    const rows = await trx
      .withSchema(TEST_SCHEMA)
      .selectFrom("records")
      .select("id")
      .execute();
    return rows.map((r) => r.id).sort();
  });
}

async function cleanup(admin) {
  try {
    await admin.query(`drop schema if exists ${TEST_SCHEMA} cascade`);
    const { rows } = await admin.query(`select 1 from pg_roles where rolname = $1`, [
      TEST_ROLE,
    ]);
    if (rows.length > 0) {
      // Lepas privilege (mis. grant select pada tabel assignments) sebelum drop role.
      await admin.query(`drop owned by ${TEST_ROLE}`);
      await admin.query(`drop role ${TEST_ROLE}`);
    }
    await admin.query(
      `delete from user_administrative_region_assignments where id like '${P}%'`,
    );
    await admin.query(`delete from administrative_regions where id like '${P}%'`);
    await admin.query(`delete from users where id like '${P}%'`);
  } catch (error) {
    console.warn("⚠️  cleanup parsial:", error.message);
  }
}

async function main() {
  loadLocalEnvFiles();
  applyLocalCloudflareRuntimeEnv();

  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.error("❌ DATABASE_URL belum diset (cek .env.local / docker compose).");
    process.exit(2);
  }

  const password = randomBytes(18).toString("hex");
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();

  let failures = [];
  let testDb;
  try {
    // Preflight: DB harus sudah dimigrasi.
    const { rows: pre } = await admin.query(
      `select to_regclass('public.user_administrative_region_assignments') as t`,
    );
    if (!pre[0].t) {
      console.error(
        "❌ Tabel migrasi belum ada. Jalankan `bun run db:migrate` lebih dulu.",
      );
      process.exit(2);
    }

    console.log("→ Seeding fixtures + menerapkan RLS produksi…");
    await seedFixtures(admin);
    await provisionTestRole(admin, password);

    testDb = new Kysely({
      dialect: new PostgresDialect({
        pool: new Pool({ connectionString: buildTestRoleUrl(adminUrl, password) }),
      }),
    });

    // Sanity: koneksi uji WAJIB non-superuser, kalau tidak RLS ter-bypass.
    const meta = await sql`
      select current_user as who, rolsuper as super
      from pg_roles where rolname = current_user
    `.execute(testDb);
    const { who, super: isSuper } = meta.rows[0];
    console.log(`\nKoneksi uji: ${who} (superuser=${isSuper})`);
    if (isSuper) {
      console.error("❌ Role uji superuser → RLS ter-bypass. Verifikasi tidak valid.");
      failures.push("role uji superuser");
      throw new Error("role uji superuser");
    }

    console.log("\nSkenario visibilitas (RLS aktif, non-superuser):");
    assertEqual(
      "USER_A creator R1+NULL → [row1,row2]",
      (await countVisibleAs(testDb, USER_A)).join(","),
      "row1,row2",
      failures,
    );
    assertEqual(
      "USER_B creator R2 + penugasan R1 → [row1,row3]",
      (await countVisibleAs(testDb, USER_B)).join(","),
      "row1,row3",
      failures,
    );
    assertEqual(
      "USER_C penugasan R1 KEDALUWARSA → []",
      (await countVisibleAs(testDb, USER_C)).join(","),
      "",
      failures,
    );
    assertEqual(
      "USER_X asing → []",
      (await countVisibleAs(testDb, USER_X)).join(","),
      "",
      failures,
    );
    assertEqual(
      "ADMIN bypass → [row1,row2,row3]",
      (await countVisibleAsAdmin(testDb, USER_X)).join(","),
      "row1,row2,row3",
      failures,
    );
  } finally {
    if (testDb) {
      await testDb.destroy();
    }
    await cleanup(admin);
    await admin.end();
  }

  console.log("");
  if (failures.length > 0) {
    console.error(`❌ GAGAL (${failures.length}):`);
    for (const f of failures) {
      console.error(`   - ${f}`);
    }
    process.exit(1);
  }
  console.log("✅ Semua skenario RLS region/assignment (#353) terverifikasi nyata.");
}

main().catch((error) => {
  console.error("❌ Verifikasi error:", error);
  process.exit(1);
});
