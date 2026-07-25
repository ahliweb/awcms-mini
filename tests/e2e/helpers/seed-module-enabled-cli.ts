/**
 * Standalone CLI (run as a SEPARATE `bun` subprocess, same Playwright-IPC
 * reasoning as `seed-owner-tenant-cli.ts`) that seeds an owner tenant with all
 * permissions AND opts that tenant into ONE named module.
 *
 * The generic form of `seed-service-catalog-cli.ts` (which stays as-is, wired
 * into its own spec): every SaaS control-plane module is
 * `defaultTenantState: "disabled"` (ADR-0022 §7), so without an explicit
 * `awcms_mini_tenant_modules` enabled row the SSR permission gate strips every
 * `<module>.*` key and the admin page renders the denied notice instead of the
 * screen under test. Enabling it here is exactly what a platform operator's
 * own tenant must do to use that module's admin UI.
 *
 * Usage: `bun tests/e2e/helpers/seed-module-enabled-cli.ts <databaseUrl> <tenantCode> <moduleKey>`
 * — prints one JSON line (`SeededOwner`) to stdout on success.
 */
import { seedOwnerTenantInProcess } from "./seed-owner-tenant";
import { syncModuleDescriptors } from "../../../src/modules/module-management/application/descriptor-sync";
import { listModules } from "../../../src/modules";

const [databaseUrl, tenantCode, moduleKey] = process.argv.slice(2);

if (!databaseUrl || !tenantCode || !moduleKey) {
  console.error(
    "Usage: bun seed-module-enabled-cli.ts <databaseUrl> <tenantCode> <moduleKey>"
  );
  process.exit(1);
}

// Fail loudly on a typo rather than inserting a row the FK would reject with a
// far less obvious error (or, worse, enabling nothing and leaving the spec to
// fail later as a mysterious "denied notice rendered").
if (!listModules().some((module) => module.key === moduleKey)) {
  console.error(`Unknown module key: ${moduleKey}`);
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
    VALUES (${owner.tenantId}, ${moduleKey}, true, now(), null)
    ON CONFLICT (tenant_id, module_key) DO UPDATE SET enabled = true, enabled_at = now()
  `;
} finally {
  await sql.end();
}

console.log(JSON.stringify(owner));
