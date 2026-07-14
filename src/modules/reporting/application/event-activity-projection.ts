/**
 * Event-driven incremental projection apply function (Issue #753) — the
 * ONLY reporting-owned write path invoked from
 * `domain-event-runtime/infrastructure/consumer-registry.ts`'s registered
 * `reporting.event_activity_projector` consumer (that file is the ONE
 * place a cross-module edge exists: `domain_event_runtime` -> `reporting/
 * application`; this file itself imports nothing from `domain_event_runtime`,
 * so no import cycle is introduced — see `tests/unit/module-boundary-
 * cycles.test.ts`).
 *
 * Called from INSIDE the dispatcher's own transaction
 * (`dispatch-domain-events.ts`'s claim-check + handler + finalize, all one
 * transaction) — this function neither opens nor commits a transaction of
 * its own; a thrown error here rolls the WHOLE delivery back exactly like
 * any other consumer handler (the delivery stays `pending` and is retried
 * with backoff), which is why this file's own bookkeeping does not need a
 * separate try/catch for the "silently failed" case `projection-state-
 * store.ts`'s `recordProjectionFailure` exists for — a domain-event
 * delivery failure is already tracked by `domain_event_runtime`'s own
 * delivery/retry/dead-letter state; `projection_state.last_success_at`
 * for THIS projection simply stops advancing until a delivery next
 * succeeds, which is exactly what the freshness read path needs (see
 * `reporting/domain/freshness.ts`'s header comment).
 *
 * MUTUAL EXCLUSION WITH REBUILD: skips (no-op) while a rebuild owns this
 * projection — see `projection-rebuild.ts`'s header comment §3 for why
 * this is safe (a rebuild re-derives the FULL count directly from
 * `awcms_mini_domain_events`, so any event delivered during the rebuild
 * window is already covered by the rebuild's own re-scan by the time it
 * reaches that row).
 */
import { findRunningRebuild } from "./rebuild-run-store";
import { applyMetricDeltas } from "./projection-metric-store";
import { recordProjectionSuccess } from "./projection-state-store";
import {
  EVENT_ACTIVITY_METRIC_KEYS,
  EVENT_ACTIVITY_SUMMARY_PROJECTION_KEY
} from "../domain/projection-keys";

export async function applyEventActivityProjectionIncrement(
  tx: Bun.SQL,
  tenantId: string
): Promise<void> {
  const runningRebuild = await findRunningRebuild(
    tx,
    tenantId,
    EVENT_ACTIVITY_SUMMARY_PROJECTION_KEY
  );
  if (runningRebuild) {
    return;
  }

  await applyMetricDeltas(tx, tenantId, EVENT_ACTIVITY_SUMMARY_PROJECTION_KEY, [
    { metricKey: EVENT_ACTIVITY_METRIC_KEYS.sampleRecordedCount, delta: 1 }
  ]);

  await recordProjectionSuccess(
    tx,
    tenantId,
    EVENT_ACTIVITY_SUMMARY_PROJECTION_KEY
  );
}
