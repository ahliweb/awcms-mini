/**
 * The versioned catalog of event types this runtime is aware of (Issue
 * #742 acceptance criterion: "Runtime registry and AsyncAPI event
 * types/versions pass bidirectional parity checks"). `appendDomainEvent`
 * (`application/append-domain-event.ts`) REFUSES to persist an event whose
 * `(eventType, eventVersion)` is not listed here — this is the mechanism
 * (not just documentation) that stops "event types/versions silently
 * drifting" from the published AsyncAPI contract: a new/changed event type
 * must be added HERE first (reviewed source code), which
 * `tests/unit/domain-event-registry-parity.test.ts` then cross-checks
 * against `asyncapi/awcms-mini-domain-events.asyncapi.yaml` in both
 * directions (registry entry without a channel = fail; a channel this
 * runtime's own consumer registry subscribes to without a matching entry
 * here = fail). `module.ts`'s `events.publishes` array (checked by the
 * existing generic `checkModuleEventChannels`,
 * `scripts/api-spec-check.ts`, already part of `bun run check`) covers the
 * SAME direction for the module-descriptor surface every other module
 * already uses — this registry is the finer-grained, runtime-specific
 * complement scoped to events that actually flow through THIS dispatcher.
 *
 * Scope note: this issue ships exactly one registered event type — a
 * self-contained reference/example (`sample.recorded`) used to exercise
 * and prove the outbox/dispatcher/ordering/retry/DLQ/replay mechanism
 * end-to-end, mirroring the accepted "foundation issue ships zero real
 * business integrations" precedent (#643 shipped zero real provider
 * adapters; PR #713 migrated 2 of 8 scripts as proof-of-concept). Future
 * producer modules add their OWN entries here (and their own
 * `module.ts` `events.publishes` entries, and their own AsyncAPI
 * channels) when they start calling `appendDomainEvent` — deliberately
 * NOT done in this PR to keep this foundation issue's blast radius
 * confined to its own module (AGENTS.md rule #1, Atomic).
 */
export type RegisteredDomainEventType = {
  eventType: string;
  eventVersion: string;
  description: string;
};

export const SAMPLE_RECORDED_EVENT_TYPE =
  "awcms-mini.domain-event-runtime.sample.recorded";
export const SAMPLE_RECORDED_EVENT_VERSION = "1.0";

/**
 * `workflow-approval`'s FIRST real producer registration (Issue #747,
 * epic `platform-evolution` #738, Wave 2) — a small, real event set
 * (instance lifecycle + delegation lifecycle), not an exhaustive
 * taxonomy: `workflow-approval/application/workflow-instance.ts`,
 * `workflow-instance-decision.ts`, `workflow-recovery.ts`, and
 * `workflow-delegation-directory.ts` call `appendDomainEvent` with these
 * inside the SAME transaction as the state change they describe. All
 * share one contract version string (`WORKFLOW_EVENT_VERSION`) since they
 * were introduced together; bump per-event if any one payload shape
 * changes independently later.
 */
export const WORKFLOW_EVENT_VERSION = "1.0";
export const WORKFLOW_INSTANCE_STARTED_EVENT_TYPE =
  "awcms-mini.workflow.instance.started";
export const WORKFLOW_INSTANCE_ADVANCED_EVENT_TYPE =
  "awcms-mini.workflow.instance.advanced";
export const WORKFLOW_INSTANCE_APPROVED_EVENT_TYPE =
  "awcms-mini.workflow.instance.approved";
export const WORKFLOW_INSTANCE_REJECTED_EVENT_TYPE =
  "awcms-mini.workflow.instance.rejected";
export const WORKFLOW_INSTANCE_CANCELLED_EVENT_TYPE =
  "awcms-mini.workflow.instance.cancelled";
export const WORKFLOW_TASK_ESCALATED_EVENT_TYPE =
  "awcms-mini.workflow.task.escalated";
export const WORKFLOW_DELEGATION_CREATED_EVENT_TYPE =
  "awcms-mini.workflow.delegation.created";
export const WORKFLOW_DELEGATION_REVOKED_EVENT_TYPE =
  "awcms-mini.workflow.delegation.revoked";

/**
 * `organization_structure`'s producer registration (Issue #749, epic
 * `platform-evolution` #738, Wave 2) — same real-producer pattern as
 * `workflow_approval` above (Optional → System is an allowed DAG
 * direction, ADR-0013 §1), unlike `profile_identity`'s Core-constrained
 * literal-string approach below. `organization-structure/application/
 * legal-entity-directory.ts`, `organization-unit-directory.ts`,
 * `organization-unit-hierarchy-service.ts`, and `organization-unit-
 * assignment-service.ts` all call `appendDomainEvent` with these inside
 * the SAME transaction as the state change they describe.
 */
export const ORGANIZATION_STRUCTURE_EVENT_VERSION = "1.0";
export const ORGANIZATION_STRUCTURE_LEGAL_ENTITY_CREATED_EVENT_TYPE =
  "awcms-mini.organization-structure.legal-entity.created";
export const ORGANIZATION_STRUCTURE_LEGAL_ENTITY_UPDATED_EVENT_TYPE =
  "awcms-mini.organization-structure.legal-entity.updated";
export const ORGANIZATION_STRUCTURE_LEGAL_ENTITY_DEACTIVATED_EVENT_TYPE =
  "awcms-mini.organization-structure.legal-entity.deactivated";
export const ORGANIZATION_STRUCTURE_UNIT_CREATED_EVENT_TYPE =
  "awcms-mini.organization-structure.unit.created";
export const ORGANIZATION_STRUCTURE_UNIT_UPDATED_EVENT_TYPE =
  "awcms-mini.organization-structure.unit.updated";
export const ORGANIZATION_STRUCTURE_UNIT_DEACTIVATED_EVENT_TYPE =
  "awcms-mini.organization-structure.unit.deactivated";
export const ORGANIZATION_STRUCTURE_HIERARCHY_CHANGED_EVENT_TYPE =
  "awcms-mini.organization-structure.hierarchy.changed";
export const ORGANIZATION_STRUCTURE_ASSIGNMENT_CREATED_EVENT_TYPE =
  "awcms-mini.organization-structure.assignment.created";
export const ORGANIZATION_STRUCTURE_ASSIGNMENT_ENDED_EVENT_TYPE =
  "awcms-mini.organization-structure.assignment.ended";

/**
 * `data_exchange`'s producer registration (Issue #752, epic
 * `platform-evolution` #738, Wave 3, ADR-0017) — same real-producer pattern
 * as `organization_structure`/`workflow_approval` above (Optional → System
 * is an allowed DAG direction, ADR-0013 §1). `data-exchange/application/
 * import-batch-directory.ts`, `import-commit-job.ts`, `export-job-
 * directory.ts`, and `reconciliation-service.ts` call `appendDomainEvent`
 * with these inside the SAME transaction as the state change they describe.
 */
export const DATA_EXCHANGE_EVENT_VERSION = "1.0";
export const DATA_EXCHANGE_IMPORT_STAGED_EVENT_TYPE =
  "awcms-mini.data-exchange.import.staged";
export const DATA_EXCHANGE_IMPORT_PREVIEWED_EVENT_TYPE =
  "awcms-mini.data-exchange.import.previewed";
export const DATA_EXCHANGE_IMPORT_COMMITTED_EVENT_TYPE =
  "awcms-mini.data-exchange.import.committed";
export const DATA_EXCHANGE_IMPORT_FAILED_EVENT_TYPE =
  "awcms-mini.data-exchange.import.failed";
export const DATA_EXCHANGE_EXPORT_COMPLETED_EVENT_TYPE =
  "awcms-mini.data-exchange.export.completed";
export const DATA_EXCHANGE_RECONCILIATION_MISMATCH_EVENT_TYPE =
  "awcms-mini.data-exchange.reconciliation.mismatch";

export const DOMAIN_EVENT_TYPE_REGISTRY: readonly RegisteredDomainEventType[] =
  [
    {
      eventType: SAMPLE_RECORDED_EVENT_TYPE,
      eventVersion: SAMPLE_RECORDED_EVENT_VERSION,
      description:
        "Reference/example event type used to exercise the domain-event-runtime outbox, dispatcher, ordering, retry/backoff, dead-letter, and replay mechanism end-to-end (Issue #742). Real producer modules publish their OWN event types the same way, via appendDomainEvent — this one is intentionally self-contained rather than tied to another module's business logic in this foundation issue."
    },
    {
      eventType: WORKFLOW_INSTANCE_STARTED_EVENT_TYPE,
      eventVersion: WORKFLOW_EVENT_VERSION,
      description:
        "A workflow instance was started, pinned to the currently-active workflow definition version (Issue #747)."
    },
    {
      eventType: WORKFLOW_INSTANCE_ADVANCED_EVENT_TYPE,
      eventVersion: WORKFLOW_EVENT_VERSION,
      description:
        "A workflow instance's active task was decided and the instance advanced to its next node(s), without yet reaching a terminal outcome (Issue #747)."
    },
    {
      eventType: WORKFLOW_INSTANCE_APPROVED_EVENT_TYPE,
      eventVersion: WORKFLOW_EVENT_VERSION,
      description:
        "A workflow instance reached an `end` node with outcome `approved` (Issue #747)."
    },
    {
      eventType: WORKFLOW_INSTANCE_REJECTED_EVENT_TYPE,
      eventVersion: WORKFLOW_EVENT_VERSION,
      description:
        "A workflow instance reached an `end` node with outcome `rejected`, or was force-rejected (Issue #747)."
    },
    {
      eventType: WORKFLOW_INSTANCE_CANCELLED_EVENT_TYPE,
      eventVersion: WORKFLOW_EVENT_VERSION,
      description:
        "An administrator cancelled a running workflow instance (Issue #747, `application/workflow-recovery.ts`)."
    },
    {
      eventType: WORKFLOW_TASK_ESCALATED_EVENT_TYPE,
      eventVersion: WORKFLOW_EVENT_VERSION,
      description:
        "A pending workflow task passed its due date and was escalated by the scheduled escalation/timeout job (Issue #747)."
    },
    {
      eventType: WORKFLOW_DELEGATION_CREATED_EVENT_TYPE,
      eventVersion: WORKFLOW_EVENT_VERSION,
      description:
        "A workflow delegation/substitute assignment was created (Issue #747)."
    },
    {
      eventType: WORKFLOW_DELEGATION_REVOKED_EVENT_TYPE,
      eventVersion: WORKFLOW_EVENT_VERSION,
      description:
        "A workflow delegation/substitute assignment was revoked (Issue #747)."
    },
    // Issue #748 (profile_identity, epic #738 platform-evolution Wave 2) —
    // another real (non-reference) producer registered here. Literal
    // strings match `profile-identity/domain/merge-event.ts`'s
    // `PROFILE_MERGED_EVENT_TYPE`/`PROFILE_MERGED_EVENT_VERSION` constants
    // (kept in sync by convention, not by cross-module import — see that
    // file's own header comment).
    {
      eventType: "awcms-mini.profile-identity.profile.merged",
      eventVersion: "1.0",
      description:
        "Published when a profile merge request is executed: the loser profile is soft-deleted (merged_into_profile_id set) and its awcms_mini_profile_entity_links rows are repointed to the survivor. Lets domain modules react to the merge mapping without importing profile-identity tables directly (see _shared/ports/party-directory-port.ts for the pull-based equivalent)."
    },
    {
      eventType: ORGANIZATION_STRUCTURE_LEGAL_ENTITY_CREATED_EVENT_TYPE,
      eventVersion: ORGANIZATION_STRUCTURE_EVENT_VERSION,
      description: "A legal entity was created (Issue #749)."
    },
    {
      eventType: ORGANIZATION_STRUCTURE_LEGAL_ENTITY_UPDATED_EVENT_TYPE,
      eventVersion: ORGANIZATION_STRUCTURE_EVENT_VERSION,
      description: "A legal entity's neutral metadata was updated (Issue #749)."
    },
    {
      eventType: ORGANIZATION_STRUCTURE_LEGAL_ENTITY_DEACTIVATED_EVENT_TYPE,
      eventVersion: ORGANIZATION_STRUCTURE_EVENT_VERSION,
      description: "A legal entity was deactivated (soft-deleted, Issue #749)."
    },
    {
      eventType: ORGANIZATION_STRUCTURE_UNIT_CREATED_EVENT_TYPE,
      eventVersion: ORGANIZATION_STRUCTURE_EVENT_VERSION,
      description: "An organization unit was created (Issue #749)."
    },
    {
      eventType: ORGANIZATION_STRUCTURE_UNIT_UPDATED_EVENT_TYPE,
      eventVersion: ORGANIZATION_STRUCTURE_EVENT_VERSION,
      description: "An organization unit was updated (Issue #749)."
    },
    {
      eventType: ORGANIZATION_STRUCTURE_UNIT_DEACTIVATED_EVENT_TYPE,
      eventVersion: ORGANIZATION_STRUCTURE_EVENT_VERSION,
      description:
        "An organization unit was deactivated (soft-deleted, Issue #749)."
    },
    {
      eventType: ORGANIZATION_STRUCTURE_HIERARCHY_CHANGED_EVENT_TYPE,
      eventVersion: ORGANIZATION_STRUCTURE_EVENT_VERSION,
      description:
        "An organization-unit hierarchy edge was created or reparented — the previous open edge (if any) was closed and a new one opened at the current timestamp (Issue #749)."
    },
    {
      eventType: ORGANIZATION_STRUCTURE_ASSIGNMENT_CREATED_EVENT_TYPE,
      eventVersion: ORGANIZATION_STRUCTURE_EVENT_VERSION,
      description: "An organization-unit assignment was created (Issue #749)."
    },
    {
      eventType: ORGANIZATION_STRUCTURE_ASSIGNMENT_ENDED_EVENT_TYPE,
      eventVersion: ORGANIZATION_STRUCTURE_EVENT_VERSION,
      description: "An organization-unit assignment was ended (Issue #749)."
    },
    {
      eventType: DATA_EXCHANGE_IMPORT_STAGED_EVENT_TYPE,
      eventVersion: DATA_EXCHANGE_EVENT_VERSION,
      description:
        "A staged import batch was created (file intake accepted, checksum/media-type verified, Issue #752)."
    },
    {
      eventType: DATA_EXCHANGE_IMPORT_PREVIEWED_EVENT_TYPE,
      eventVersion: DATA_EXCHANGE_EVENT_VERSION,
      description:
        "A staged import batch's asynchronous parse/validate pass completed and a preview (totals, proposed actions, errors) is available (Issue #752)."
    },
    {
      eventType: DATA_EXCHANGE_IMPORT_COMMITTED_EVENT_TYPE,
      eventVersion: DATA_EXCHANGE_EVENT_VERSION,
      description:
        "A staged import batch's asynchronous commit pass finished (fully or partially committed) — see the batch's own status for which (Issue #752)."
    },
    {
      eventType: DATA_EXCHANGE_IMPORT_FAILED_EVENT_TYPE,
      eventVersion: DATA_EXCHANGE_EVENT_VERSION,
      description:
        "A staged import batch's validate or commit pass failed outright (distinct from a partial commit, which uses the .committed event above, Issue #752)."
    },
    {
      eventType: DATA_EXCHANGE_EXPORT_COMPLETED_EVENT_TYPE,
      eventVersion: DATA_EXCHANGE_EVENT_VERSION,
      description:
        "An export job finished writing its manifest/checksum and became downloadable (Issue #752)."
    },
    {
      eventType: DATA_EXCHANGE_RECONCILIATION_MISMATCH_EVENT_TYPE,
      eventVersion: DATA_EXCHANGE_EVENT_VERSION,
      description:
        "A reconciliation report detected a source/commit or source/export count or checksum mismatch (Issue #752)."
    }
  ];

export function isRegisteredDomainEventType(
  eventType: string,
  eventVersion: string
): boolean {
  return DOMAIN_EVENT_TYPE_REGISTRY.some(
    (entry) =>
      entry.eventType === eventType && entry.eventVersion === eventVersion
  );
}
