-- Issue #851 (spin-off epic #818) — SECURITY: quorum-'all' bypass hardening.
--
-- Closes the integrity leg of a READ COMMITTED TOCTOU race on
-- `POST /api/v1/workflows/tasks/{id}/decisions`: a single approver assigned to
-- a quorum-'all' task could satisfy the quorum ALONE by firing two CONCURRENT
-- approvals with DIFFERENT Idempotency-Keys (the same-key idempotency store
-- only protects a REUSED key). Both transactions read the assignment as
-- `pending`, both INSERT a decision, both flip the assignment to `decided`, and
-- `evaluateQuorumOutcome('all', eligibleCount=2, ['approve','approve'])`
-- completes the task — approved on one person's say-so.
--
-- The application fix (row-lock + `status = 'pending'` predicate in
-- `workflow-instance-decision.ts`) serialises concurrent same-assignee
-- requests, but a database-level invariant is the durable, refactor-proof
-- backstop and also closes a SEQUENTIAL variant the row-lock alone cannot
-- (the same user being BOTH a direct assignee AND an active delegate of a
-- second assignee on the same task, which would otherwise let them cast two
-- distinct votes toward one quorum). The invariant is: at most ONE ordinary
-- decision per (tenant, task, decider) — one human, one vote per task.
--
-- PARTIAL on `is_administrative_override = false` deliberately: an
-- administrative override (`workflow-recovery.ts`'s `forceWorkflowTaskDecision`,
-- migration 060's `is_administrative_override`/`override_reason` columns) is a
-- sanctioned quorum bypass recorded alongside — never subject to the "one vote"
-- rule — and is already limited to one row per task by its own
-- `task.status = 'pending'` guard. `is_administrative_override` is
-- `NOT NULL DEFAULT false` (migration 060), so an ordinary decision row is
-- always captured by this predicate.
--
-- `awcms_mini_workflow_decisions` is append-only (never UPDATE'd by app code),
-- so this index is additive. If a prior buggy run already recorded duplicate
-- ordinary decisions for one (tenant, task, decider), `CREATE UNIQUE INDEX`
-- will fail loudly here — that is intentional: a human must decide which of the
-- conflicting votes is authoritative (delete the spurious row) before the
-- invariant can be enforced.

CREATE UNIQUE INDEX IF NOT EXISTS
  awcms_mini_workflow_decisions_one_per_decider_uidx
  ON awcms_mini_workflow_decisions
    (tenant_id, workflow_task_id, decided_by_tenant_user_id)
  WHERE is_administrative_override = false;
