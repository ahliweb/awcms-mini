/**
 * `lifecycle_transition` capability adapter (Issue #873, epic #868, ADR-0022
 * §11.2). `tenant_lifecycle` PROVIDES this WRITE contract so subscription
 * billing (#876) can request a lifecycle transition (trial->active,
 * active->past_due, grace->suspended, ...) through the validated, audited,
 * concurrency-safe engine INSTEAD of mutating tenant state directly — the exact
 * dependency #873 exists to satisfy. A consumer wires it at ITS composition root
 * inside its own `withTenant` transaction (never a direct module import —
 * module-boundary). The engine deps (status projection, etc.) are those the
 * caller injects; billing typically passes the same projection so a
 * billing-driven suspension propagates to public/worker in one commit.
 */
import { transition, type LifecycleEngineDeps } from "./lifecycle-transition";
import type {
  LifecycleTransitionPort,
  LifecycleTransitionRequest,
  LifecycleTransitionResult
} from "../../_shared/ports/tenant-lifecycle-port";

export function createLifecycleTransitionPort(
  tx: Bun.SQL,
  tenantId: string,
  deps: LifecycleEngineDeps
): LifecycleTransitionPort {
  return {
    async requestTransition(
      request: LifecycleTransitionRequest
    ): Promise<LifecycleTransitionResult> {
      const result = await transition(
        tx,
        tenantId,
        {
          toState: request.toState,
          reason: request.reason,
          source: request.source,
          expectedVersion: request.expectedVersion ?? null
        },
        deps,
        {
          actorTenantUserId: request.actorTenantUserId ?? null,
          correlationId: request.correlationId
        }
      );
      if (result.ok) {
        return {
          ok: true,
          state: result.state.state,
          version: result.state.version
        };
      }
      const reason =
        result.reason === "illegal_transition"
          ? "illegal_transition"
          : result.reason === "version_conflict"
            ? "version_conflict"
            : result.reason === "not_found"
              ? "not_found"
              : "validation";
      return {
        ok: false,
        reason,
        message: result.message,
        currentState: result.current?.state,
        currentVersion: result.current?.version
      };
    }
  };
}
