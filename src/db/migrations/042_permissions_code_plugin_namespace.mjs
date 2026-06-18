import { sql } from "kysely";

/**
 * Longgarkan check constraint `permissions.code` agar menerima **namespace
 * permission plugin** `awcms:{module}:{resource}:{action}` (colon) selain format
 * core `domain.resource.action` (dot).
 *
 * Latar: tabel `permissions` dibuat sebelum kontrak plugin (ADR-018) & namespace
 * permission shared-standards §4.2. Plugin (SIKESRA/SatuSehat) men-seed permission
 * ber-namespace colon yang sebelumnya melanggar `permissions_code_format_check`.
 */

const DOT_FORMAT = "^[a-z0-9]+(.[a-z0-9_]+){2}$"; // format core (dipertahankan apa adanya)
const PLUGIN_NAMESPACE = "^awcms:[a-z0-9_]+:[a-z0-9_]+:[a-z0-9_]+$"; // awcms:{module}:{resource}:{action}

export async function up(db) {
  await sql`alter table permissions drop constraint if exists permissions_code_format_check`.execute(db);
  await sql.raw(
    `alter table permissions add constraint permissions_code_format_check check (` +
      `code ~ '${DOT_FORMAT}' or code ~ '${PLUGIN_NAMESPACE}')`,
  ).execute(db);
}

export async function down(db) {
  await sql`alter table permissions drop constraint if exists permissions_code_format_check`.execute(db);
  await sql.raw(
    `alter table permissions add constraint permissions_code_format_check check (code ~ '${DOT_FORMAT}')`,
  ).execute(db);
}
