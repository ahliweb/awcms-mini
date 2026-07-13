---
"awcms-mini": minor
---

Evolve `workflow-approval` from a linear single-step approval engine (Issue 11.1) into a managed, versioned, graph-based enterprise workflow minimum (Issue #747, epic `platform-evolution` #738 Wave 2).

- Managed workflow-definition lifecycle: `draft -> active -> retired`, full version history, immutable published/retired rows (migration `059`). New endpoints `POST/PUT/DELETE /api/v1/workflows/definitions`, `.../publish`, `.../retire`, `.../new-version`, `.../validate`.
- Generic node/transition graph (`approval`/`condition`/`parallel`/`join`/`notify`/`end`) replaces the old linear `steps` list — sequential approval, bounded conditional routing over declared facts (never arbitrary expressions/code, doc 21 §3 decision tree), and parallel fan-out/fan-in.
- Quorum/any/all approval rules per node, tracked via new `awcms_mini_workflow_task_assignments` (eligible deciders, reassignment history).
- Effective-dated delegation/substitute assignments (`awcms_mini_workflow_delegations`) — scoped, reasoned, audited, revocable; never widens the delegator's own verified authority.
- Escalation/timeout policies processed by a new scheduled worker job (`bun run workflow:escalations:dispatch`), built on the shared worker runner with bounded batches, an advisory lock, and an optimistic-concurrency idempotency guard so a task is never escalated twice for the same due event.
- Administrative recovery — reassign, cancel, force-approve/force-reject — each permission-gated, reason-required, `Idempotency-Key`, fully audited, and never overwriting prior decision/task history.
- Every instance is pinned to the exact definition version active when it started (`workflow_definition_id`/`workflow_definition_version`); newer published versions never retroactively change a running instance's behavior.
- Module-contributed condition resolvers/actions via a static, reviewed-source-code registry (`infrastructure/condition-action-registry.ts`, mirroring `domain_event_runtime`'s consumer registry) — never runtime-registered or tenant-uploaded code.
- Consolidated admin approval inbox: `GET /api/v1/workflows/tasks` gains keyset pagination, filters (workflow key/resource type/status/overdue), safe parameterized search, plus a new `GET /api/v1/workflows/instances/{id}` immutable action-history view; new admin UI screen at `/admin/workflows`.
- New workflow lifecycle events (`awcms-mini.workflow.instance.{started,advanced,approved,rejected,cancelled}`, `.task.escalated`, `.delegation.{created,revoked}`) published via `domain_event_runtime`'s transactional outbox (Issue #742) in the same transaction as the triggering state change.
- Low-cardinality metrics for active/overdue instances, decision latency, escalation, and recovery actions.
