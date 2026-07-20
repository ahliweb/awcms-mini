/**
 * `bun run subscription-billing:run-renewal` (Issue #876) — roll due
 * subscriptions to their next billing period and generate the next invoice
 * draft idempotently under a per-tenant lease (row-lock + partial-unique +
 * ON CONFLICT). DB-only and safe offline/LAN; no provider call. This CLI is the
 * COMPOSITION ROOT: it wires the #870 catalog + #875 usage ports into the engine
 * deps (the module's own application code never imports them — module-boundary).
 */
import { getDatabaseClient } from "../src/lib/database/client";
import { listModules } from "../src/modules";
import { createServiceCatalogReadPort } from "../src/modules/service-catalog/application/service-catalog-read-port-adapter";
import { createEffectiveEntitlementPort } from "../src/modules/tenant-entitlement/application/effective-entitlement-port-adapter";
import { buildContractRegistry } from "../src/modules/usage-metering/application/meter-registry";
import { createUsageAggregatePort } from "../src/modules/usage-metering/application/usage-aggregate-adapter";
import { runBillingRenewal } from "../src/modules/subscription-billing/application/billing-jobs";
import type { InvoiceEngineDeps } from "../src/modules/subscription-billing/application/invoice-engine";

async function main(): Promise<void> {
  const sql = getDatabaseClient();
  const dryRun = process.argv.includes("--dry-run");

  const buildInvoiceDeps = (
    tx: Bun.SQL,
    tenantId: string
  ): InvoiceEngineDeps => {
    const catalog = createServiceCatalogReadPort(tx);
    const entitlementPort = createEffectiveEntitlementPort(tx, tenantId, {
      catalogPort: catalog,
      moduleDescriptors: listModules()
    });
    const usage = createUsageAggregatePort(
      tx,
      tenantId,
      buildContractRegistry(listModules()),
      entitlementPort
    );
    return { catalog, usage };
  };

  const result = await runBillingRenewal(
    sql,
    { dryRun, correlationId: crypto.randomUUID() },
    buildInvoiceDeps
  );
  console.log(
    `subscription-billing:run-renewal — tenants=${result.tenantsChecked} renewed=${result.subscriptionsRenewed} invoicesCreated=${result.invoicesCreated} skipped=${result.tenantsSkipped}${dryRun ? " (dry-run)" : ""}`
  );
}

await main();
