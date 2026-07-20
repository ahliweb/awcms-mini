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
 * `reference_data`'s REAL producer registration (Issue #750, epic #738
 * platform-evolution Wave 3, ADR-0018) — `application/value-set-
 * directory.ts`, `code-directory.ts`, `tenant-code-directory.ts`, and
 * `import-service.ts` all call `appendDomainEvent` with these inside the
 * SAME transaction as the state change they describe. No "restored"
 * event for value set/code/tenant code — same precedent
 * `organization_structure`'s `legal_entity` events already set (restore
 * is audited but not published as a domain event).
 */
export const REFERENCE_DATA_EVENT_VERSION = "1.0";
export const REFERENCE_DATA_VALUE_SET_CREATED_EVENT_TYPE =
  "awcms-mini.reference-data.value-set.created";
export const REFERENCE_DATA_VALUE_SET_UPDATED_EVENT_TYPE =
  "awcms-mini.reference-data.value-set.updated";
export const REFERENCE_DATA_VALUE_SET_DEPRECATED_EVENT_TYPE =
  "awcms-mini.reference-data.value-set.deprecated";
export const REFERENCE_DATA_CODE_CREATED_EVENT_TYPE =
  "awcms-mini.reference-data.code.created";
export const REFERENCE_DATA_CODE_UPDATED_EVENT_TYPE =
  "awcms-mini.reference-data.code.updated";
export const REFERENCE_DATA_CODE_DEPRECATED_EVENT_TYPE =
  "awcms-mini.reference-data.code.deprecated";
export const REFERENCE_DATA_IMPORT_COMMITTED_EVENT_TYPE =
  "awcms-mini.reference-data.import.committed";
export const REFERENCE_DATA_IMPORT_ROLLED_BACK_EVENT_TYPE =
  "awcms-mini.reference-data.import.rolled-back";
export const REFERENCE_DATA_TENANT_CODE_CREATED_EVENT_TYPE =
  "awcms-mini.reference-data.tenant-code.created";
export const REFERENCE_DATA_TENANT_CODE_DEPRECATED_EVENT_TYPE =
  "awcms-mini.reference-data.tenant-code.deprecated";

/**
 * `document_infrastructure`'s FIRST real producer registration (Issue
 * #751, epic `platform-evolution` #738, Wave 3). `application/document-
 * directory.ts`, `document-version-service.ts`, and `document-number-
 * reservation-service.ts` call `appendDomainEvent` with these inside the
 * SAME transaction as the state change they describe.
 */
export const DOCUMENT_INFRASTRUCTURE_EVENT_VERSION = "1.0";
export const DOCUMENT_INFRASTRUCTURE_DOCUMENT_CREATED_EVENT_TYPE =
  "awcms-mini.document-infrastructure.document.created";
export const DOCUMENT_INFRASTRUCTURE_DOCUMENT_VOIDED_EVENT_TYPE =
  "awcms-mini.document-infrastructure.document.voided";
export const DOCUMENT_INFRASTRUCTURE_DOCUMENT_RESTORED_EVENT_TYPE =
  "awcms-mini.document-infrastructure.document.restored";
export const DOCUMENT_INFRASTRUCTURE_DOCUMENT_RECLASSIFIED_EVENT_TYPE =
  "awcms-mini.document-infrastructure.document.reclassified";
export const DOCUMENT_INFRASTRUCTURE_VERSION_CREATED_EVENT_TYPE =
  "awcms-mini.document-infrastructure.version.created";
export const DOCUMENT_INFRASTRUCTURE_NUMBER_RESERVED_EVENT_TYPE =
  "awcms-mini.document-infrastructure.number.reserved";
export const DOCUMENT_INFRASTRUCTURE_NUMBER_COMMITTED_EVENT_TYPE =
  "awcms-mini.document-infrastructure.number.committed";
export const DOCUMENT_INFRASTRUCTURE_NUMBER_CANCELED_EVENT_TYPE =
  "awcms-mini.document-infrastructure.number.canceled";

/**
 * `data_exchange`'s producer registration (Issue #752, epic
 * `platform-evolution` #738, Wave 3, ADR-0018) — same real-producer pattern
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

/**
 * `integration_hub`'s producer registration (Issue #754, epic
 * `platform-evolution` #738 Wave 3, ADR-0019) — same real-producer pattern
 * as `workflow_approval`/`organization_structure` above (Optional/System ->
 * System is an allowed DAG direction, ADR-0013 §1).
 * `integration-hub/application/inbound-webhook-intake.ts` calls
 * `appendDomainEvent` with this event type, inside the SAME transaction
 * that persists the verified inbound delivery row, after a signed inbound
 * webhook passes verification and is normalized. `integration_hub`'s own
 * static fan-out consumer (`integration-hub/infrastructure/domain-event-
 * consumer-registration.ts`'s `integrationHubOutboundFanoutConsumer`,
 * which that module registers into this runtime itself — this runtime
 * never imports it back, Issue #826) subscribes to this event type to
 * create outbound-subscription delivery rows (a DB-only write, still
 * inside this same transaction) — the real HTTP delivery to each
 * subscriber happens later, outside any transaction, via `bun run
 * integration-hub:outbound:dispatch`.
 */
export const INTEGRATION_HUB_EVENT_VERSION = "1.0";
export const INTEGRATION_HUB_INBOUND_MESSAGE_NORMALIZED_EVENT_TYPE =
  "awcms-mini.integration-hub.inbound-message.normalized";

/**
 * `service_catalog`'s producer registration (Issue #870, epic #868 SaaS
 * control plane, Wave 1, ADR-0022 §4) — the first control-plane module.
 * `service-catalog/application/plan-directory.ts` calls `appendDomainEvent`
 * with these inside the SAME transaction as the state change they describe:
 * `.offer.published` when a draft version is published into an immutable
 * offer, `.offer.retired` when a published offer is retired. No event for
 * draft create/edit (working data, not a domain fact) — same precedent as
 * `reference_data` (create/deprecate published, restore not).
 */
export const SERVICE_CATALOG_EVENT_VERSION = "1.0";
export const SERVICE_CATALOG_OFFER_PUBLISHED_EVENT_TYPE =
  "awcms-mini.service-catalog.offer.published";
export const SERVICE_CATALOG_OFFER_RETIRED_EVENT_TYPE =
  "awcms-mini.service-catalog.offer.retired";

/**
 * `tenant_entitlement` (Issue #871, epic #868 SaaS control plane Wave 1,
 * ADR-0022). `tenant_entitlement` is a REAL producer via `appendDomainEvent`,
 * emitting these inside the SAME transaction as the entitlement change + the
 * append-only evaluation snapshot: `.assignment.changed` when an assignment is
 * assigned/suspended/resumed/canceled, `.override.changed` when an override is
 * created/revoked. Each payload carries the resolved `snapshotHash` for
 * deterministic derived-cache invalidation — never an operator's free-text
 * reason (ADR-0022 §4/§5, tenant-facing shape only).
 */
export const TENANT_ENTITLEMENT_EVENT_VERSION = "1.0";
export const TENANT_ENTITLEMENT_ASSIGNMENT_CHANGED_EVENT_TYPE =
  "awcms-mini.tenant-entitlement.assignment.changed";
export const TENANT_ENTITLEMENT_OVERRIDE_CHANGED_EVENT_TYPE =
  "awcms-mini.tenant-entitlement.override.changed";

/**
 * `tenant_provisioning` (Issue #872, epic #868 SaaS control plane Wave 1,
 * ADR-0022 §11.1). The THIRD control-plane module is a REAL producer via
 * `appendDomainEvent`, emitting these inside the SAME transaction as the
 * provisioning state change: `.requested` when a run is created (tenant
 * bootstrapped), `.completed` when a run reaches `provisioned` (tenant active),
 * `.failed` when a run is compensated to failed/blocked/canceled (tenant left
 * inactive, data preserved), `.reconciled` after a non-destructive
 * desired-vs-actual reconciliation. Payloads carry only bounded, non-sensitive
 * fields (request/tenant id, plan, status, step key, drift count) — never a
 * provider secret, owner password, or a step's raw I/O (ADR-0022 §6/§8).
 */
export const TENANT_PROVISIONING_EVENT_VERSION = "1.0";
export const TENANT_PROVISIONING_REQUESTED_EVENT_TYPE =
  "awcms-mini.tenant-provisioning.requested";
export const TENANT_PROVISIONING_COMPLETED_EVENT_TYPE =
  "awcms-mini.tenant-provisioning.completed";
export const TENANT_PROVISIONING_FAILED_EVENT_TYPE =
  "awcms-mini.tenant-provisioning.failed";
export const TENANT_PROVISIONING_RECONCILED_EVENT_TYPE =
  "awcms-mini.tenant-provisioning.reconciled";

/**
 * `usage_metering` (Issue #875, epic #868 SaaS control plane Wave 1, ADR-0022).
 * A REAL producer via `appendDomainEvent`, emitting these inside the SAME
 * transaction as the state change they describe: `.usage.corrected` when a
 * signed correction/reversal is applied to a billable meter,
 * `.usage.reconciled` when a reconciliation run compares recomputed windows to
 * stored aggregates. Both payloads are NUMERIC-ONLY (meter key, ids, counts,
 * signed delta / drift counts) — NEVER the operator's free-text correction
 * reason or any raw sample payload (ADR-0022 §8, tenant-facing shape only).
 * NOT the usage EVENTS themselves: producing modules append those through the
 * transaction-safe `usage_append` port (the usage_events table is the outbox),
 * not the domain-event stream.
 */
export const USAGE_METERING_EVENT_VERSION = "1.0";
export const USAGE_METERING_USAGE_CORRECTED_EVENT_TYPE =
  "awcms-mini.usage-metering.usage.corrected";
export const USAGE_METERING_USAGE_RECONCILED_EVENT_TYPE =
  "awcms-mini.usage-metering.usage.reconciled";

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
      eventType: REFERENCE_DATA_VALUE_SET_CREATED_EVENT_TYPE,
      eventVersion: REFERENCE_DATA_EVENT_VERSION,
      description: "A reference value set was created (Issue #750)."
    },
    {
      eventType: REFERENCE_DATA_VALUE_SET_UPDATED_EVENT_TYPE,
      eventVersion: REFERENCE_DATA_EVENT_VERSION,
      description: "A reference value set's metadata was updated (Issue #750)."
    },
    {
      eventType: REFERENCE_DATA_VALUE_SET_DEPRECATED_EVENT_TYPE,
      eventVersion: REFERENCE_DATA_EVENT_VERSION,
      description:
        "A reference value set was deprecated (soft-deleted, Issue #750)."
    },
    {
      eventType: REFERENCE_DATA_CODE_CREATED_EVENT_TYPE,
      eventVersion: REFERENCE_DATA_EVENT_VERSION,
      description:
        "A reference code was created within a value set (Issue #750)."
    },
    {
      eventType: REFERENCE_DATA_CODE_UPDATED_EVENT_TYPE,
      eventVersion: REFERENCE_DATA_EVENT_VERSION,
      description:
        "A reference code's mutable attributes were updated (Issue #750)."
    },
    {
      eventType: REFERENCE_DATA_CODE_DEPRECATED_EVENT_TYPE,
      eventVersion: REFERENCE_DATA_EVENT_VERSION,
      description: "A reference code was deprecated (soft-deleted, Issue #750)."
    },
    {
      eventType: REFERENCE_DATA_IMPORT_COMMITTED_EVENT_TYPE,
      eventVersion: REFERENCE_DATA_EVENT_VERSION,
      description:
        "A validated reference-data import batch was committed to the global baseline (Issue #750)."
    },
    {
      eventType: REFERENCE_DATA_IMPORT_ROLLED_BACK_EVENT_TYPE,
      eventVersion: REFERENCE_DATA_EVENT_VERSION,
      description:
        "A committed reference-data import batch was rolled back (Issue #750)."
    },
    {
      eventType: REFERENCE_DATA_TENANT_CODE_CREATED_EVENT_TYPE,
      eventVersion: REFERENCE_DATA_EVENT_VERSION,
      description:
        "A tenant reference code override or extension was created (Issue #750)."
    },
    {
      eventType: REFERENCE_DATA_TENANT_CODE_DEPRECATED_EVENT_TYPE,
      eventVersion: REFERENCE_DATA_EVENT_VERSION,
      description:
        "A tenant reference code override or extension was deprecated (Issue #750)."
    },
    {
      eventType: DOCUMENT_INFRASTRUCTURE_DOCUMENT_CREATED_EVENT_TYPE,
      eventVersion: DOCUMENT_INFRASTRUCTURE_EVENT_VERSION,
      description: "A document registry entry was created (Issue #751)."
    },
    {
      eventType: DOCUMENT_INFRASTRUCTURE_DOCUMENT_VOIDED_EVENT_TYPE,
      eventVersion: DOCUMENT_INFRASTRUCTURE_EVENT_VERSION,
      description:
        "A document was voided (irreversible-by-default business-state transition, kept visible as evidence, Issue #751)."
    },
    {
      eventType: DOCUMENT_INFRASTRUCTURE_DOCUMENT_RESTORED_EVENT_TYPE,
      eventVersion: DOCUMENT_INFRASTRUCTURE_EVENT_VERSION,
      description:
        "A soft-deleted document was restored, or a voided document was un-voided (Issue #751)."
    },
    {
      eventType: DOCUMENT_INFRASTRUCTURE_DOCUMENT_RECLASSIFIED_EVENT_TYPE,
      eventVersion: DOCUMENT_INFRASTRUCTURE_EVENT_VERSION,
      description:
        "A document's classification and/or confidentiality level was changed (Issue #751)."
    },
    {
      eventType: DOCUMENT_INFRASTRUCTURE_VERSION_CREATED_EVENT_TYPE,
      eventVersion: DOCUMENT_INFRASTRUCTURE_EVENT_VERSION,
      description:
        "A new immutable, append-only document version was created (Issue #751)."
    },
    {
      eventType: DOCUMENT_INFRASTRUCTURE_NUMBER_RESERVED_EVENT_TYPE,
      eventVersion: DOCUMENT_INFRASTRUCTURE_EVENT_VERSION,
      description:
        "A document number was atomically reserved from a numbering sequence (Issue #751)."
    },
    {
      eventType: DOCUMENT_INFRASTRUCTURE_NUMBER_COMMITTED_EVENT_TYPE,
      eventVersion: DOCUMENT_INFRASTRUCTURE_EVENT_VERSION,
      description:
        "A reserved document number was committed to a document (Issue #751)."
    },
    {
      eventType: DOCUMENT_INFRASTRUCTURE_NUMBER_CANCELED_EVENT_TYPE,
      eventVersion: DOCUMENT_INFRASTRUCTURE_EVENT_VERSION,
      description:
        "A reserved document number was canceled without being committed — the number is never reused (gap evidence, Issue #751)."
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
    },
    {
      eventType: INTEGRATION_HUB_INBOUND_MESSAGE_NORMALIZED_EVENT_TYPE,
      eventVersion: INTEGRATION_HUB_EVENT_VERSION,
      description:
        "A signed inbound webhook delivery was verified and normalized into this repo's own domain-event shape (Issue #754). Payload carries only the normalized/bounded envelope (endpoint id, adapter key, provider delivery id, inbound delivery id, received-at, content type, body size, and the parsed JSON body when the content type was application/json) — never raw provider credentials."
    },
    {
      eventType: SERVICE_CATALOG_OFFER_PUBLISHED_EVENT_TYPE,
      eventVersion: SERVICE_CATALOG_EVENT_VERSION,
      description:
        "A service catalog plan version was published into an immutable offer (Issue #870). Payload carries plan key, version, offer hash, and currency — never internal prices."
    },
    {
      eventType: SERVICE_CATALOG_OFFER_RETIRED_EVENT_TYPE,
      eventVersion: SERVICE_CATALOG_EVENT_VERSION,
      description:
        "A published service catalog offer version was retired (Issue #870). The offer stays readable; the payload carries plan key and version."
    },
    {
      eventType: TENANT_ENTITLEMENT_ASSIGNMENT_CHANGED_EVENT_TYPE,
      eventVersion: TENANT_ENTITLEMENT_EVENT_VERSION,
      description:
        "A tenant entitlement assignment was assigned/suspended/resumed/canceled (Issue #871). Payload carries the assignment id, plan key, offer version, change type, resulting status, and the resolved snapshotHash for deterministic cache invalidation — never an operator reason or internal price."
    },
    {
      eventType: TENANT_ENTITLEMENT_OVERRIDE_CHANGED_EVENT_TYPE,
      eventVersion: TENANT_ENTITLEMENT_EVENT_VERSION,
      description:
        "A tenant entitlement override was created or revoked (Issue #871). Payload carries the override id, target kind/key, effect, change type, and the resolved snapshotHash — never the operator's free-text reason."
    },
    {
      eventType: TENANT_PROVISIONING_REQUESTED_EVENT_TYPE,
      eventVersion: TENANT_PROVISIONING_EVENT_VERSION,
      description:
        "A tenant provisioning run was requested and the target tenant record was bootstrapped (Issue #872). Payload carries the request id, tenant id, plan key/version, target key, and total step count — never a secret or owner password."
    },
    {
      eventType: TENANT_PROVISIONING_COMPLETED_EVENT_TYPE,
      eventVersion: TENANT_PROVISIONING_EVENT_VERSION,
      description:
        "A tenant provisioning run reached `provisioned` and the tenant became active (Issue #872). Payload carries the request id, tenant id, and status."
    },
    {
      eventType: TENANT_PROVISIONING_FAILED_EVENT_TYPE,
      eventVersion: TENANT_PROVISIONING_EVENT_VERSION,
      description:
        "A tenant provisioning run was compensated to failed/blocked/canceled; the tenant was left inactive with its data preserved (Issue #872). Payload carries the request id, tenant id, resulting status, and the failing step key (when applicable)."
    },
    {
      eventType: TENANT_PROVISIONING_RECONCILED_EVENT_TYPE,
      eventVersion: TENANT_PROVISIONING_EVENT_VERSION,
      description:
        "A non-destructive desired-vs-actual reconciliation of a provisioned run completed (Issue #872). Payload carries the request id, tenant id, reconciliation status, and drift count — no auto-fix is ever applied."
    },
    {
      eventType: USAGE_METERING_USAGE_CORRECTED_EVENT_TYPE,
      eventVersion: USAGE_METERING_EVENT_VERSION,
      description:
        "A signed usage correction/reversal was applied to a billable meter (Issue #875). Payload carries the correction id, original event id, meter key, correction type, and signed delta quantity — never the operator's free-text reason."
    },
    {
      eventType: USAGE_METERING_USAGE_RECONCILED_EVENT_TYPE,
      eventVersion: USAGE_METERING_EVENT_VERSION,
      description:
        "A usage reconciliation run compared recomputed windows to stored aggregates (Issue #875). Payload carries the run id, meter key, window type, status, and windows-checked / drift / missing counts — numeric-only evidence."
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
