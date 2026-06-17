// Middleware Hono: set konteks user aktif di PostgreSQL sebelum query plugin dijalankan.
// Pasang pada router plugin, setelah middlewareOptionalAuth (yang meng-set c.get("actor")).

import { getDatabase } from "../../src/db/index.mjs";
import { setPluginDbContext } from "../../src/db/plugin-adapter.mjs";

/**
 * Middleware Hono untuk men-set app.current_user_id di PostgreSQL per request.
 * Dibutuhkan agar RLS policy plugin (`plugin_user_isolation`) bisa mengevaluasi
 * current_setting('app.current_user_id', true) dengan benar.
 *
 * Contoh pemakaian:
 *   router.use("*", middlewarePluginDbContext());
 *   router.get("/subjects", handler);
 *
 * @returns {import("hono").MiddlewareHandler}
 */
export function middlewarePluginDbContext() {
  return async function pluginDbContextMiddleware(ctx, next) {
    const actor = ctx.get("actor");

    if (actor?.id) {
      await setPluginDbContext(getDatabase(), actor.id);
    }

    await next();
  };
}
