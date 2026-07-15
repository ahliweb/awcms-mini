---
"awcms-mini": patch
---

Repo-wide docs/skills consistency audit (Issue #805), the 4th round of this recurring
maintenance pass (previous rounds: PR #554, #586, #768). Since the last audit
(2026-07-13), the platform-evolution epic (#738, 17 issues) grew the module registry
from 16 to 23 modules and landed idempotency-hash-binding and SoD hierarchy-aware
fixes — this pass reconciles docs/skills with that new state (~55 verified findings).

- Fixed stale "16 modules" claims (now 23) across `docs/awcms-mini/README.md`, doc 13,
  doc 21, `AGENTS.md`, `module-management/README.md`, and 3 skills.
- Fixed `module-management/README.md`'s permission/navigation/job-ownership counts
  (grown from 7/11/8 to 17/33/16 modules).
- Added explicit resource-identity-binding guidance and a worked code example to
  `awcms-mini-idempotency`, the skill responsible for preventing the idempotency-hash
  bug class that recurred 3 times (Issue #750/#795) — it previously had no guidance on
  this at all.
- Fixed `awcms-mini-abac-guard`'s `AccessAction` union (16 missing members),
  `awcms-mini-audit-log`'s mandatory-audit-action list (workflow decisions, document
  void/reclassify, generic export/import, legal hold), `awcms-mini-new-module`'s stale
  `api/` folder structure, `awcms-mini-new-event`'s wire-envelope shape and channel
  count, `awcms-mini-production-preflight`'s stage count (9 → 11).
- Corrected `src/modules/organization-structure/README.md`'s hierarchy-port
  composition function name/location after its PR #804 refactor.
- Added 4 missing epic-skills for core modules that previously had zero dedicated
  coverage: `awcms-mini-document-infrastructure`, `awcms-mini-integration-hub`,
  `awcms-mini-workflow-approval`, `awcms-mini-profile-identity`.
- Refreshed the stale `docs/awcms-mini/github/` snapshot (was 3 days old, claimed 35
  open issues against a real count of 0) and added narrative sections for the
  platform-evolution epic and follow-up issues #794-#804.
- Filled operational-doc gaps: `deployment-profiles.md`'s cron table (6 missing
  platform-evolution jobs), `08_sop_operasional_user_guide.md` (zero sections for any
  platform-evolution module), and `CONTRIBUTING.md`/root `README.md`'s description of
  the `bun run check` chain (missing several sub-checks).

No functional/runtime code changed — docs, skills, and ADR Context prose only (ADR
Decision/Consequences text left untouched per this repo's ADR immutability policy).
