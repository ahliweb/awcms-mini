/**
 * Standalone CLI (run as a SEPARATE `bun` subprocess, same Playwright-IPC
 * reasoning as `seed-owner-tenant-cli.ts`) for the service_catalog E2E spec.
 * Seeds an owner tenant (all permissions) AND opts that tenant into the
 * `service_catalog` module — which is `defaultTenantState: "disabled"` (Issue
 * #870, ADR-0022 §7), so without an explicit `awcms_mini_tenant_modules`
 * enabled row the SSR permission gate strips every `service_catalog.*` key and
 * the admin page renders the denied notice. Enabling it here is exactly what a
 * platform operator's own tenant must do to use the catalog admin UI.
 *
 * Usage: `bun tests/e2e/helpers/seed-service-catalog-cli.ts <databaseUrl> <tenantCode>`
 * — prints one JSON line (`SeededOwner`) to stdout on success.
 */
import { seedOwnerTenantInProcess } from "./seed-owner-tenant";
import { syncModuleDescriptors } from "../../../src/modules/module-management/application/descriptor-sync";

const [databaseUrl, tenantCode] = process.argv.slice(2);

if (!databaseUrl || !tenantCode) {
  console.error(
    "Usage: bun seed-service-catalog-cli.ts <databaseUrl> <tenantCode>"
  );
  process.exit(1);
}

const owner = await seedOwnerTenantInProcess(databaseUrl, tenantCode);

const sql = new Bun.SQL(databaseUrl);
try {
  // The module_key FK requires the descriptor to be synced to awcms_mini_modules first.
  await sql.begin((tx) => syncModuleDescriptors(tx as unknown as Bun.SQL));
  await sql`
    INSERT INTO awcms_mini_tenant_modules
      (tenant_id, module_key, enabled, enabled_at, enabled_by)
    VALUES (${owner.tenantId}, 'service_catalog', true, now(), null)
    ON CONFLICT (tenant_id, module_key) DO UPDATE SET enabled = true, enabled_at = now()
  `;
} finally {
  await sql.end();
}

console.log(JSON.stringify(owner));
