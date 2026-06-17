// Middleware Hono: set konteks DB per request untuk mendukung RLS (ADR-015, #310)
// Berbeda dari plugin-db-context.mjs (khusus plugin routes), middleware ini
// dirancang untuk dipasang secara global — setelah middlewareOptionalAuth.

import { sql } from "kysely";

import { getDatabase } from "../../src/db/index.mjs";

/**
 * Set app.current_user_id + app.is_admin di PostgreSQL untuk RLS policy.
 *
 * - app.current_user_id: ID user aktif (string, dari actor.id)
 * - app.is_admin: 'true' jika actor memiliki staff_level >= minAdminStaffLevel
 *
 * Konteks bersifat lokal per transaksi (set_config dengan local=true).
 *
 * @param {import("kysely").Kysely<unknown>} db
 * @param {object|null} actor - Actor dari ctx.get("actor")
 * @param {number} minAdminStaffLevel - Staff level minimum untuk admin bypass RLS (default: 7)
 */
export async function setRequestDbContext(db, actor, minAdminStaffLevel = 7) {
  const userId = actor?.id ?? "";
  const isAdmin = actor && Number(actor.staff_level ?? 0) >= minAdminStaffLevel;

  await sql`
    select
      set_config('app.current_user_id', ${userId}, true),
      set_config('app.is_admin', ${isAdmin ? "true" : "false"}, true)
  `.execute(db);
}

/**
 * Middleware Hono global untuk set konteks DB (current_user_id + is_admin).
 * Pasang setelah middlewareOptionalAuth, sebelum route handler.
 *
 * Contoh pemakaian di createApp():
 *   app.use("*", middlewareOptionalAuth(...));
 *   app.use("*", middlewareDbContext());
 *
 * @param {{ minAdminStaffLevel?: number }} [options]
 * @returns {import("hono").MiddlewareHandler}
 */
export function middlewareDbContext({ minAdminStaffLevel = 7 } = {}) {
  return async function dbContextMiddleware(ctx, next) {
    const actor = ctx.get("actor") ?? null;
    await setRequestDbContext(getDatabase(), actor, minAdminStaffLevel);
    await next();
  };
}
