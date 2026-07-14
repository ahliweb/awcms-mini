/**
 * Read-side aggregator (Issue #753) — combines a projection's code-declared
 * descriptor metadata with its live persisted state/metrics/freshness for
 * the `GET /api/v1/reports/projections[/​{key}]` API and admin UI. A
 * projection is a DERIVED read model, never an authorization source of
 * truth (issue #753 security requirement) — every function here only
 * READS; callers must independently re-check RBAC/ABAC before calling
 * (every route in `src/pages/api/v1/reports/projections*.ts` does, via the
 * same `authorizeInTransaction` guard every other endpoint in this repo
 * uses).
 */
import { computeProjectionFreshness } from "../domain/freshness";
import { collectProjectionDescriptors } from "../domain/projection-registry";
import { listModules } from "../../index";
import type { ProjectionDescriptor } from "../../_shared/module-contract";
import { getProjectionMetrics } from "./projection-metric-store";
import { getProjectionState } from "./projection-state-store";
import { findRunningRebuild } from "./rebuild-run-store";
import { listReconciliationRuns } from "./reconciliation-run-store";

export type ProjectionSummaryView = {
  key: string;
  version: number;
  ownerModuleKey: string;
  scope: string;
  description: string;
  metricLabels: Readonly<Record<string, string>>;
  metrics: Record<string, number>;
  freshness: {
    status: string;
    ageSeconds: number | null;
    lastSuccessAt: string | null;
    lastAttemptAt: string | null;
    consecutiveFailures: number;
    lastErrorMessage: string | null;
  };
  drillDownPath: string | null;
};

export function listRegisteredProjectionDescriptors(): ProjectionDescriptor[] {
  return collectProjectionDescriptors(listModules());
}

export function findProjectionDescriptor(
  key: string
): ProjectionDescriptor | undefined {
  return listRegisteredProjectionDescriptors().find(
    (descriptor) => descriptor.key === key
  );
}

async function buildSummaryView(
  tx: Bun.SQL,
  tenantId: string,
  descriptor: ProjectionDescriptor,
  now: Date
): Promise<ProjectionSummaryView> {
  // Sequential, NOT `Promise.all` — every call below issues a query on
  // the SAME transaction/connection (`tx`); a single Postgres connection
  // processes one query at a time, and running these concurrently
  // produced a real hang in this repo (see `projection-reconciliation.ts`'s
  // matching comment for the confirmed empirical failure).
  const metrics = await getProjectionMetrics(tx, tenantId, descriptor.key);
  const state = await getProjectionState(tx, tenantId, descriptor.key);
  const runningRebuild = await findRunningRebuild(tx, tenantId, descriptor.key);

  const freshness = computeProjectionFreshness(
    { ...state, rebuildInProgress: runningRebuild !== null },
    descriptor.freshness,
    now
  );

  return {
    key: descriptor.key,
    version: descriptor.version,
    ownerModuleKey: descriptor.ownerModuleKey,
    scope: descriptor.scope,
    description: descriptor.description,
    metricLabels: descriptor.metricLabels,
    metrics,
    freshness: {
      status: freshness.status,
      ageSeconds: freshness.ageSeconds,
      lastSuccessAt: freshness.lastSuccessAt?.toISOString() ?? null,
      lastAttemptAt: freshness.lastAttemptAt?.toISOString() ?? null,
      consecutiveFailures: freshness.consecutiveFailures,
      lastErrorMessage: freshness.lastErrorMessage
    },
    drillDownPath: descriptor.drillDownPath ?? null
  };
}

export async function listProjectionSummariesForTenant(
  tx: Bun.SQL,
  tenantId: string,
  now: Date = new Date()
): Promise<ProjectionSummaryView[]> {
  const descriptors = listRegisteredProjectionDescriptors();
  const views: ProjectionSummaryView[] = [];

  for (const descriptor of descriptors) {
    if (descriptor.scope !== "tenant") {
      // Known limitation (matches `data_lifecycle`'s own documented
      // scope): `scope: "global"` descriptors are accepted by the
      // registry validator (forward-compatible typing) but this read
      // path — and the incremental/rebuild engines — only implement the
      // `"tenant"` path end-to-end today. No registered descriptor
      // currently declares `scope: "global"`.
      continue;
    }
    views.push(await buildSummaryView(tx, tenantId, descriptor, now));
  }

  return views;
}

export async function getProjectionSummaryForTenant(
  tx: Bun.SQL,
  tenantId: string,
  key: string,
  now: Date = new Date()
): Promise<{
  summary: ProjectionSummaryView;
  recentReconciliations: Awaited<ReturnType<typeof listReconciliationRuns>>;
} | null> {
  const descriptor = findProjectionDescriptor(key);
  if (!descriptor || descriptor.scope !== "tenant") {
    return null;
  }

  // Sequential — same same-connection reasoning as `buildSummaryView`'s
  // own comment above.
  const summary = await buildSummaryView(tx, tenantId, descriptor, now);
  const recentReconciliations = await listReconciliationRuns(tx, tenantId, key);

  return { summary, recentReconciliations };
}
