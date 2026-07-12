---
"awcms-mini": minor
---

Add failure-injection and disaster-recovery verification (Issue #699,
epic #679 platform-hardening): `bun run resilience:dr-drill`
(`scripts/dr-drill.ts`) runs deterministic, non-destructive scenarios —
PostgreSQL disconnect (client-level simulation), pool saturation, worker
interruption (real SIGTERM, reusing Issue #697's job-runner fixture),
and partial SSO/email provider outage — and, in the `--full` tier, a real
backup/restore/rollback round trip reusing Issue #691's
`deploy/backup/restore-drill.sh`. A non-overridable safety interlock
(`src/lib/resilience/target-guard.ts`) refuses to run against
`APP_ENV=production` or any unrecognized/production-like database host by
default. Produces a tri-state (`pass`/`incomplete`/`fail`) JSON report
with RTO/RPO evidence. CI runs the safe subset on every PR; the full tier
is documented for staging rehearsal and scheduled cadence (see
`docs/awcms-mini/resilience-dr-verification.md`).
