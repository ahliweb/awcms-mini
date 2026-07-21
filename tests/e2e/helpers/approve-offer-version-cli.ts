/**
 * Standalone CLI (run as a SEPARATE `bun` subprocess, same Playwright-IPC
 * reasoning as `seed-service-catalog-cli.ts`) that commercially APPROVES a draft
 * offer version OUT-OF-BAND, as a DISTINCT approver identity.
 *
 * Issue #879 (ADR-0022 §5 HIGH-2) made `publishVersion` refuse a version that is
 * not commercially approved AND refuse a publisher equal to the approver
 * (maker/checker). The admin approve UI is #878 scope (out of #879); until it
 * ships, the E2E publish flow must obtain that distinct approval through a
 * back-channel — exactly as an operator would once a second approver exists.
 *
 * The approver id is a FRESH random uuid, guaranteed distinct from the publisher
 * (the seeded owner's tenant user), so the per-record `commercial_approved_by !==
 * publisher` check passes and maker != checker holds. Runs as the seed superuser
 * with the tenant RLS context set, mirroring `seed-service-catalog-cli.ts`.
 *
 * Usage:
 *   bun tests/e2e/helpers/approve-offer-version-cli.ts <databaseUrl> <tenantId> <planKey> <version>
 * — prints one JSON line (`{ approverTenantUserId }`) to stdout on success.
 */
import { approveOfferVersion } from "../../../src/modules/service-catalog/application/plan-directory";

const [databaseUrl, tenantId, planKey, versionArg] = process.argv.slice(2);

if (!databaseUrl || !tenantId || !planKey || !versionArg) {
  console.error(
    "Usage: bun approve-offer-version-cli.ts <databaseUrl> <tenantId> <planKey> <version>"
  );
  process.exit(1);
}

const version = Number(versionArg);
if (!Number.isInteger(version) || version <= 0) {
  console.error(`version must be a positive integer (got ${versionArg}).`);
  process.exit(1);
}

// A distinct approver identity — never the publisher (the seeded owner).
const approverTenantUserId = crypto.randomUUID();

const sql = new Bun.SQL(databaseUrl);
try {
  await sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);
    const result = await approveOfferVersion(
      tx as unknown as Bun.SQL,
      tenantId,
      approverTenantUserId,
      planKey,
      version
    );
    if (!result.ok) {
      throw new Error(`approveOfferVersion failed: ${JSON.stringify(result)}`);
    }
  });
} finally {
  await sql.end();
}

console.log(JSON.stringify({ approverTenantUserId }));
