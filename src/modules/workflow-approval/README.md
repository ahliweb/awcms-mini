# Workflow Approval

Implementation of Issue 11.1 (`docs/awcms-mini/06_github_issues_detail.md` §Issue 11.1), evolved by **Issue #747** (epic `platform-evolution` #738, Wave 2) into a managed, versioned, graph-based enterprise workflow minimum — while keeping the base's original guardrail: no domain-specific business terms/actions (base ships no POS cancel/Coretax export/warehouse transfer), no external BPMN engine, and no runtime code execution in conditions/actions (doc 21 §3 decision tree, node Q5).

## What changed from Issue 11.1

| Issue 11.1 (linear)                                | Issue #747 (managed, graph-based)                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| One `status: active/inactive` per definition       | `version` + `lifecycle_status: draft/active/retired`, full version history, immutable published/retired rows  |
| `steps` (ordered jsonb list)                       | `graph` (nodes/transitions — approval/condition/parallel/join/notify/end)                                     |
| No public create-definition endpoint               | `POST/PUT/DELETE /workflows/definitions`, `.../publish`, `.../retire`, `.../new-version`, `.../validate`      |
| `current_step_order` (single int)                  | `awcms_mini_workflow_tasks` rows (one per activated node) — supports multiple concurrently-active nodes       |
| One implicit assignee (whoever calls the decision) | `awcms_mini_workflow_task_assignments` — explicit assignees, quorum/any/all, delegation-resolved deciders     |
| No delegation                                      | `awcms_mini_workflow_delegations` — effective-dated, scoped, reason, audited, revocable                       |
| No escalation/timeout                              | Per-node `escalation` config + `bun run workflow:escalations:dispatch`, idempotent via optimistic concurrency |
| No administrative recovery                         | Reassign / cancel / force-approve / force-reject, permission-gated + `Idempotency-Key` + audit                |
| `GET /workflows/tasks` (offset-free, no filters)   | Keyset-paginated, filterable (workflow key/resource type/status/overdue), safe search, action-history view    |

## Schema (migration `012` + `060`)

Same 4 core tables (`awcms_mini_workflow_definitions`/`_instances`/`_tasks`/`_decisions`), evolved in place (migration `060`), plus 3 new tables:

- `awcms_mini_workflow_task_assignments` — eligible deciders per task (quorum/any/all counting, delegation resolution, reassignment history — never deleted, only `reassigned`).
- `awcms_mini_workflow_delegations` — effective-dated substitute assignments.
- `awcms_mini_workflow_join_arrivals` — fan-in bookkeeping for `parallel`/`join` nodes (append-only, idempotent by unique constraint).

`awcms_mini_idempotency_keys` (from migration `012`) is reused unchanged for every new high-risk action here.

## Graph model (`domain/workflow-graph.ts`)

A small, closed set of node types — never a scripting/expression engine:

- **`approval`** — one or more `assigneeTenantUserIds`; `quorumRule` (`all`/`any`/`quorum` with `quorumThreshold`) decides when the node completes. A single `reject` always completes the node as rejected, regardless of rule (a deliberate, documented conservative default — see `domain/workflow-quorum.ts`). Optional `escalation` config (`timeoutMinutes`, `escalateToTenantUserId`, `maxEscalations`).
- **`condition`** — EITHER a bounded comparison (`factKey`/`operator`/`value`, operators `eq|neq|gt|gte|lt|lte|in`) over a fact declared in the definition's `factsSchema`, OR a reference to a statically-registered `WorkflowConditionResolver` (`resolverName` — see below). Never both, never neither.
- **`parallel`**/**`join`** — fan-out into 2+ concurrent branches, fan back in once every branch has arrived at the join (`awcms_mini_workflow_join_arrivals`). Nested parallel/join is **not supported** in this issue (see §Deferred).
- **`notify`** — fires a notification via the `WorkflowNotificationPort` capability port (ADR-0011; adapter in `email`, wraps `enqueueAnnouncement` unchanged) and advances immediately; never blocks.
- **`end`** — terminal; sets the instance's outcome.

`validateWorkflowGraph` structurally validates every node reference, quorum threshold bound, parallel/join branch-set matching, and rejects cycles (DFS) — run on every definition write and again at publish (defense in depth).

## Module-contributed condition resolvers/actions (`_shared/ports/workflow-condition-port.ts`, `infrastructure/condition-action-registry.ts`)

A static, reviewed-source-code registry — mirrors `domain-event-runtime`'s `DOMAIN_EVENT_CONSUMERS` exactly. Ships one self-contained reference resolver (`workflow_approval.reference.always_true`) and one reference action handler (`workflow_approval.reference.noop`), proving the mechanism end-to-end without inventing real business logic in this foundation-adjacent issue (matches the accepted "foundation issue ships zero real business integrations" precedent, #643/#742). **Deferred**: an `action` node type that would invoke a registered `WorkflowActionHandler` mid-graph does not exist yet in this issue's node schema — the handler registry exists and is tested, but nothing calls it yet; a follow-up issue wires a real node type to it once a real consumer needs one.

## Version pinning

`awcms_mini_workflow_instances.workflow_definition_id` (FK, immutable once published) + denormalized `workflow_definition_version` pin every instance to the EXACT definition row active when `startWorkflowInstance` ran. Because published/active/retired rows are never edited in place (`application/workflow-definition-directory.ts` enforces `draft`-only editing), every later read/advance of that instance re-fetches the identical graph regardless of newer versions published afterward.

## Delegation (`domain/workflow-delegation.ts`)

A delegation only ever lets the delegate act using the delegator's OWN standing — never a permission grant, never wider than the delegation row's own declared `workflowKey`/`resourceType`/effective window. Self-approval denial (`identity-access/domain/access-control.ts`, unchanged) still compares the ACTING tenant user against the instance's original requester — a delegate cannot be used to approve a request the delegator themselves filed. Both create (`POST /workflows/delegations`) and revoke (`POST /workflows/delegations/{id}/revoke`) require `Idempotency-Key` and are recorded via `recordAuditEvent` (in addition to the `workflow.delegation.created`/`.revoked` domain events already published through `domain_event_runtime`'s outbox — the audit log entry and the domain event are two distinct, independently-consumed records, not the same thing). Revoke is gated on the `workflow.delegation.revoke` permission (Owner/Manager per doc 17's RBAC matrix) — `revokeWorkflowDelegation`'s ownership check (only the original delegator may revoke) remains as defense-in-depth on top of that permission gate, not instead of it (security-auditor finding, PR #778: the permission was previously seeded but never enforced by any guard).

## Escalation/timeout (`application/workflow-escalation.ts`, `scripts/workflow-escalations-dispatch.ts`)

Built on the shared worker runner (`src/lib/jobs/job-runner.ts`) — bounded batch, advisory lock, `--dry-run`. **Idempotency guard**: the escalation `UPDATE` is conditioned on `WHERE status = 'pending' AND escalation_step = <value read this pass>` — a lost race (concurrent run, or a retried pass) affects zero rows and is silently skipped, never double-escalates. Runs as the least-privilege `awcms_mini_worker` role (migration `060` grants).

## Administrative recovery (`application/workflow-recovery.ts`)

Reassign (`POST /workflows/tasks/{id}/reassign`), cancel (`POST /workflows/instances/{id}/cancel`), and force-approve/force-reject (`POST /workflows/tasks/{id}/force-decision`) — each permission-gated (`workflow.recovery.reassign`/`.cancel`/`.force_decide`), reason-required, `Idempotency-Key`, fully audited (`recordAuditEvent`). Never overwrites/deletes a prior decision/task/assignment row — always appends a new row or a guarded status transition.

## Consolidated approval inbox (`application/workflow-inbox-directory.ts`)

`GET /workflows/tasks` — keyset pagination (`(created_at, id)`, doc 16 §Pagination keyset), filters (`workflowKey`/`resourceType`/`status`/`overdue`), safe parameterized search (ILIKE with escaped wildcards, never string concatenation). `GET /workflows/instances/{id}` — instance detail + immutable action history, built by REUSING `awcms_mini_workflow_decisions` + `awcms_mini_audit_events` (no new history table).

## Self-approval guard — still reused, not a new mechanism

`evaluateAccess` (`src/modules/identity-access/domain/access-control.ts`, Issue 2.4) is called unchanged; the decision route still looks up the instance's `requested_by_tenant_user_id` BEFORE the guard so the comparison has the right value.

## Metrics (`src/lib/observability/metrics-port.ts`)

`workflow_instances_active_total`/`workflow_tasks_overdue_total` (gauges, sampled per escalation-job pass), `workflow_task_decision_duration_ms` (histogram), `workflow_escalation_total`/`workflow_recovery_action_total` (counters) — all unlabeled or labeled with a fixed, code-defined enum only (never a tenant/resource id).

## Admin UI (`/admin/workflows`)

`src/pages/admin/workflows/index.astro` — the consolidated approval inbox screen: filters (status/workflow key/resource type/overdue), safe search, keyset "load more" pagination, per-row approve/reject/reassign/force-decide/cancel actions (each gated by its own permission, each a real client-side `fetch` against the existing endpoints above, same convention `admin/analytics.astro` established — the UI is never the enforcement point, only a second, strictly-more-restrictive convenience layer over already-guarded server-side ABAC), and an expandable immutable action-history panel per row. Deliberately NOT built in this issue: a visual definition/graph editor — `POST/PUT /workflows/definitions/**` are exercised by tests and usable directly, but authoring a node/transition graph today is done via the API, same precedent Issue 11.1 set for the original linear engine (backlog for a follow-up issue, not silently dropped).

## Deferred (explicitly out of scope for Issue #747, not silently dropped)

- **Nested `parallel`/`join`** — a branch containing its own `parallel` node is not supported; the fan-in tracking (`awcms_mini_workflow_join_arrivals`) assumes one level of nesting. Real need would require branch-id disambiguation across nesting levels.
- **`any`-join** (proceed once ANY one branch, not all, arrives) — only `all`-join is implemented; `any`-join is more naturally modeled today by routing each branch independently to the same next node without a join at all.
- **A graph `action` node type** invoking a registered `WorkflowActionHandler` — the static registry/port exists and is tested, no node type calls it yet.
- **SoD (segregation-of-duties) hooks from Issue #746** — that issue (`identity-access` business-scope + SoD) is not yet merged; self-approval/delegation authorization here is designed so a future SoD hook could plug into `findEligibleAssignment`/`evaluateAccess` without a rewrite, but nothing SoD-specific is built here.
- **Full metrics cardinality tuning per workflowKey/nodeId** — deliberately kept unlabeled/low-cardinality per Issue #747's own guardrail; a future dashboard wanting per-workflow breakdowns would need a bounded-cardinality follow-up (e.g. capping to the tenant's top-N workflow keys), not unbounded labels.

## Idempotency

Every high-risk mutation here (`decisions`, `reassign`, `force-decision`, `publish`, `retire`, `DELETE .../definitions/{id}`, `.../instances/{id}/cancel`, `.../delegations` create, `.../delegations/{id}/revoke`) requires `Idempotency-Key`, using the same generic `awcms_mini_idempotency_keys` store (migration `012`) — same key + same request hash replays the stored response; same key + different hash -> `409 IDEMPOTENCY_CONFLICT`.

## Decision concurrency safety (Issue #851)

The `Idempotency-Key` store only de-duplicates a **reused** key. A single approver could therefore satisfy a quorum-`all` task **alone** by firing two _concurrent_ approvals with _different_ keys — a READ COMMITTED TOCTOU race: both transactions read the assignment as `pending`, both record a decision, and the instance transitions to `approved` on one person's say-so. Closed with three layered defenses:

1. **Row lock** — `findEligibleAssignment` selects the task's assignment rows `ORDER BY id FOR UPDATE` (blocking wait, not `SKIP LOCKED`, and a deterministic lock order so two different deciders can't deadlock). The losing concurrent request blocks until the winner commits, then re-reads the row as `decided` and is reported ineligible (`403`).
2. **Guarded transition** — the assignment `UPDATE ... SET status = 'decided'` carries an `AND status = 'pending'` predicate; a lost race affects zero rows.
3. **Integrity invariant** — migration `078` adds a **partial** unique index `awcms_mini_workflow_decisions (tenant_id, workflow_task_id, decided_by_tenant_user_id) WHERE is_administrative_override = false` — one ordinary vote per decider per task. Administrative overrides (`is_administrative_override = true`, `forceWorkflowTaskDecision`) are deliberately excluded (they are a sanctioned quorum bypass, already limited to one per task by their own `status = 'pending'` guard). This also closes the sequential variant where one user is both a direct assignee **and** an active delegate of a second assignee on the same task.

A duplicate decision (concurrent or sequential) surfaces as `409 IDEMPOTENCY_CONFLICT` via `WorkflowTaskDecisionConflictError`, never a raw `500`. Regression guard: `tests/integration/workflow-approval-decision-hardening.integration.test.ts` (the concurrency test — previously committed `test.failing` while the bug was live, now a permanent RED-on-regression assertion).

## Security-auditor findings fixed (PR #778, before merge)

- **`force-decision` self-approval bypass (High)** — the route authorized via `workflow.recovery.force_decide` without populating `resourceAttributes.requestedByTenantUserId`, and `access-control.ts`'s self-approval-deny check was hardwired to the `"approve"` action only — so a caller who filed their own instance and held `force_decide` could force-approve their own request, bypassing quorum entirely. Fixed by looking up the task/instance before the guard (same pattern `decisions.ts` uses) and extending the self-approval-deny check to also cover `"force_decide"` (blocks both force-approve and force-reject of one's own instance).
- **Missing audit log entries (High)** — `publish`, `retire`, the definitions `DELETE` handler, and delegation create/revoke did not call `recordAuditEvent` despite being high-risk mutations; all 5 now do. `DELETE .../definitions/{id}` and both delegation endpoints were also missing `Idempotency-Key` enforcement; now added.
- **Unenforced `workflow.delegation.revoke` permission (Low)** — the revoke route gated on `workflow.delegation.read` and relied solely on the ownership check; the seeded `revoke` permission (doc 17: Owner/Manager `RCV`) was dead. Fixed to gate on `workflow.delegation.revoke`.
- **Escalation-job worker role over-grant (Low)** — migration `060` granted `SELECT, UPDATE` on `awcms_mini_workflow_instances` to `awcms_mini_worker`, but the escalation job only ever `SELECT`s from that table. Trimmed to `SELECT`-only.
