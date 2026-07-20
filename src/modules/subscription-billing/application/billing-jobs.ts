/**
 * Scheduled `subscription_billing` workers (Issue #876, epic #868, pattern
 * #872). Per active tenant, inside ONE `withTenant` transaction, a worker CLAIMS
 * the per-tenant lease, drains a BOUNDED batch, and RELEASES the lease — so
 * multiple workers cooperate idempotently and a crashed worker's lease expires
 * for another to resume (AC worker-restart/lease). Cross-module effects (catalog
 * / usage / lifecycle ports) are INJECTED by the caller's composition root (the
 * `scripts/` CLI), never imported here (module-boundary). DB-only; offline-safe.
 */
import { withTenant } from "../../../lib/database/tenant-context";
import {
  fetchActiveTenants,
  iterateTenantsInBatches
} from "../../../lib/jobs/batching";
import type { JobContext } from "../../../lib/jobs/job-runner";
import type {
  LifecycleTransitionPort,
  LifecycleState
} from "../../_shared/ports/tenant-lifecycle-port";
import { claimLease, releaseLease } from "./billing-lease";
import {
  listDueRenewalSubscriptions,
  listDunningCandidates,
  updateSubscriptionPeriodAnchors,
  type SubscriptionRow
} from "./billing-directory";
import { nextPeriodEnd, type BillingInterval } from "../domain/period";
import { generateInvoiceDraft, type InvoiceEngineDeps } from "./invoice-engine";
import { runDunningAttempt, type DunningEngineDeps } from "./dunning-engine";
import type { ActionContext } from "./subscription-engine";

export type BillingJobOptions = {
  now?: Date;
  batchLimit?: number;
  maxPasses?: number;
  leaseHolder?: string;
};

export type RenewalJobResult = {
  tenantsChecked: number;
  subscriptionsRenewed: number;
  invoicesCreated: number;
  tenantsSkipped: number;
};

/**
 * Roll each due subscription to its next period and generate the next invoice
 * draft idempotently (AC "at most one invoice per period under concurrent
 * workers" — the invoice unique index + per-tenant lease guarantee it).
 */
export async function runBillingRenewal(
  sql: Bun.SQL,
  ctx: Pick<JobContext, "dryRun" | "correlationId"> &
    Partial<Pick<JobContext, "signal">>,
  buildInvoiceDeps: (tx: Bun.SQL, tenantId: string) => InvoiceEngineDeps,
  options: BillingJobOptions = {}
): Promise<RenewalJobResult> {
  const now = options.now ?? new Date();
  const batchLimit = options.batchLimit ?? 50;
  const holder = options.leaseHolder ?? crypto.randomUUID();

  if (ctx.dryRun) {
    const tenants = await fetchActiveTenants(sql);
    return {
      tenantsChecked: tenants.length,
      subscriptionsRenewed: 0,
      invoicesCreated: 0,
      tenantsSkipped: 0
    };
  }

  let subscriptionsRenewed = 0;
  let invoicesCreated = 0;
  let tenantsSkipped = 0;

  const { tenants } = await iterateTenantsInBatches(
    sql,
    async (tenantId) => {
      return withTenant(
        sql,
        tenantId,
        async (tx) => {
          const grant = await claimLease(tx, tenantId, "renewal", holder, now);
          if (!grant.granted) {
            tenantsSkipped += 1;
            return { count: 0 };
          }
          const actionCtx: ActionContext = {
            actorTenantUserId: null,
            correlationId: ctx.correlationId
          };
          const deps = buildInvoiceDeps(tx, tenantId);
          const due = await listDueRenewalSubscriptions(
            tx,
            tenantId,
            now.toISOString(),
            batchLimit
          );
          let processed = 0;
          for (const sub of due) {
            await rollAndInvoice(
              tx,
              tenantId,
              sub,
              deps,
              actionCtx,
              now,
              (created) => {
                subscriptionsRenewed += 1;
                if (created) invoicesCreated += 1;
              }
            );
            processed += 1;
          }
          await releaseLease(tx, tenantId, "renewal", holder);
          return { count: processed };
        },
        { workClass: "maintenance" }
      );
    },
    { signal: ctx.signal, maxPasses: options.maxPasses }
  );

  return {
    tenantsChecked: tenants.length,
    subscriptionsRenewed,
    invoicesCreated,
    tenantsSkipped
  };
}

async function rollAndInvoice(
  tx: Bun.SQL,
  tenantId: string,
  sub: SubscriptionRow,
  deps: InvoiceEngineDeps,
  ctx: ActionContext,
  now: Date,
  onDone: (invoiceCreated: boolean) => void
): Promise<void> {
  // Roll the period anchors forward to the NEXT period (start = old end).
  const oldEnd = sub.current_period_end
    ? new Date(sub.current_period_end)
    : now;
  const newStart = oldEnd.toISOString();
  const newEnd = nextPeriodEnd(
    oldEnd,
    sub.billing_interval as BillingInterval
  ).toISOString();
  await updateSubscriptionPeriodAnchors(tx, tenantId, sub.id, newStart, newEnd);

  const result = await generateInvoiceDraft(
    tx,
    tenantId,
    sub.id,
    { includeUsage: true, dueInDays: null, reason: "scheduled renewal" },
    deps,
    ctx,
    now
  );
  onDone(result.ok && result.created);
}

export type DunningJobResult = {
  tenantsChecked: number;
  attemptsMade: number;
  tenantsSkipped: number;
};

/**
 * Run dunning for each tenant's past-due invoices. Each attempt REQUESTS a
 * lifecycle transition through the injected #873 port (fail-closed) — billing
 * never mutates lifecycle state directly.
 */
export async function runBillingDunning(
  sql: Bun.SQL,
  ctx: Pick<JobContext, "dryRun" | "correlationId"> &
    Partial<Pick<JobContext, "signal">>,
  buildDunningDeps: (tx: Bun.SQL, tenantId: string) => DunningEngineDeps,
  requestedLifecycleState: LifecycleState,
  options: BillingJobOptions = {}
): Promise<DunningJobResult> {
  const now = options.now ?? new Date();
  const batchLimit = options.batchLimit ?? 50;
  const holder = options.leaseHolder ?? crypto.randomUUID();

  if (ctx.dryRun) {
    const tenants = await fetchActiveTenants(sql);
    return {
      tenantsChecked: tenants.length,
      attemptsMade: 0,
      tenantsSkipped: 0
    };
  }

  let attemptsMade = 0;
  let tenantsSkipped = 0;

  const { tenants } = await iterateTenantsInBatches(
    sql,
    async (tenantId) => {
      return withTenant(
        sql,
        tenantId,
        async (tx) => {
          const grant = await claimLease(tx, tenantId, "dunning", holder, now);
          if (!grant.granted) {
            tenantsSkipped += 1;
            return { count: 0 };
          }
          const deps = buildDunningDeps(tx, tenantId);
          const candidates = await listDunningCandidates(
            tx,
            tenantId,
            now.toISOString(),
            batchLimit
          );
          let processed = 0;
          for (const invoice of candidates) {
            const outcome = await runDunningAttempt(
              tx,
              tenantId,
              invoice.id,
              {
                requestedLifecycleState,
                reason: "invoice past due (scheduled dunning)"
              },
              deps,
              { actorTenantUserId: null, correlationId: ctx.correlationId },
              now
            );
            if (outcome.ok) attemptsMade += 1;
            processed += 1;
          }
          await releaseLease(tx, tenantId, "dunning", holder);
          return { count: processed };
        },
        { workClass: "maintenance" }
      );
    },
    { signal: ctx.signal, maxPasses: options.maxPasses }
  );

  return { tenantsChecked: tenants.length, attemptsMade, tenantsSkipped };
}
