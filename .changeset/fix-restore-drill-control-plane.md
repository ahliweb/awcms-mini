---
"awcms-mini": patch
---

fix(backup): make the restore drill actually look at the control plane (#930)

`deploy/backup/restore-drill.sh` proved three things: the migration ledger came
back, a sample tenant row exists, and RLS still isolates tenants on
`awcms_mini_offices`. All three are base platform. **Nothing looked at the
control plane at all**, so a restore could report `overall: "pass"` with every
provisioning run, entitlement, invoice, payment envelope, support-access grant,
and projection cursor missing — a green verdict on incomplete evidence, which
is worse than no verdict.

The drill now checks seven control-plane tables, including
`reporting_projection_state` and `reporting_projection_cursors` — the
"projections and jobs" half of #930's criterion. Without the cursors a restore
looks fine and then silently reprocesses projections from zero.

Two failures are distinguished because they mean opposite things:

- A control-plane table **absent from the restored schema** is always a `fail`:
  the dump or restore lost part of the schema, and that is true whether or not
  the deployment uses the control plane.
- Tables present but **empty** is a `skip`, not a pass. A LAN/offline
  deployment never enables the control plane, and every control-plane module is
  `defaultTenantState: "disabled"` per tenant (ADR-0022 §7).

A control-plane `skip` deliberately does NOT force the overall verdict to
`incomplete`, while a `tenant_isolation` skip still does. That asymmetry is
reasoned, not a loophole: RLS isolation is something every deployment has and
the drill exists to prove, so an unproven one is a real gap; control-plane data
is something most deployments legitimately lack, and demanding it would make
`incomplete` the normal result — and a verdict that is always amber is a
verdict people stop reading.

`docs/awcms-mini/resilience-dr-verification.md` gains the control-plane RTO/RPO
section: the numbers are the same as the database as a whole (there is no
separate control-plane backup artifact), but what must be RE-RUN after a
restore is not, so each follow-up job is listed with what its absence actually
costs — including that an unswept expired entitlement is bookkeeping drift and
not retained access, and that non-terminal payment outbox rows must be left for
the dispatcher rather than cleaned up.
