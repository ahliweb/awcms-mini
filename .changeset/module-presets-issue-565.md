---
"awcms-mini": minor
---

Add reusable tenant module presets (Issue #565, epic #555): five named
sets of modules (`online_website`, `news_portal`, `saas_online`, `pos_lan`,
`minimal`) matching common deployment profiles, plus
`applyModulePreset(tx, tenantId, actorTenantUserId, presetName)`
(`src/modules/module-management/application/module-presets.ts`) — a plain
callable service, no new API route or UI in this issue (that's #566/a
future setup wizard step). Applying a preset both enables every listed
module and disables every currently-enabled module that isn't listed and
isn't protected, so a tenant actually reaches the target profile instead of
only ever accumulating modules. "Protected" is computed generically
(`domain/module-presets.ts`'s `resolveProtectedModuleKeys`) as every
`isCore: true` module plus its full transitive dependency closure — in
this registry, `module_management`'s own dependency closure
(`tenant_admin`, `identity_access`, `profile_identity`). Every enable/disable
still goes through the real `enableTenantModule`/`disableTenantModule`
lifecycle validation (dependency graph, reverse-dependency protection,
core-module protection) — never a direct `awcms_mini_tenant_modules` write.
Idempotent: a module already in its target state is left untouched (no
audit event); a module that can't be disabled because a still-enabled
module transitively depends on it is skipped and reported, never
force-disabled or silently dropped. One `tenant_module_enabled`/
`tenant_module_disabled` audit event per module actually changed (never one
aggregate "preset applied" event), tagged with `presetName`. Corrects the
issue's own illustrative `workflow_approval` module key to the actually
registered key, `workflow`. See
`src/modules/module-management/domain/module-presets.ts`'s header comment
for the full design rationale and
`src/modules/module-management/README.md`'s "Tenant module presets"
section.

Post-review fix: the disable-planner's "stays enabled" base set previously
only accounted for modules enabled before the plan ran, not modules the
same plan is about to newly enable — so a disable candidate blocked only by
a freshly-enabling dependent could slip through the pre-emptive skip check
and surface as a spurious rejection from the real `disableTenantModule`
call instead. Fixed by seeding that base set with the union of both, with
a new regression test.
