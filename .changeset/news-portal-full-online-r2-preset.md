---
"awcms-mini": minor
---

Add the `news_portal_full_online_r2` tenant module preset (Issue #632,
epic `news_portal` #631-#642/#649) — the first concrete implementation
step after Issue #631's architecture documentation.

New module `news_portal` (`src/modules/news-portal/`, minimal descriptor
only — no permissions/navigation/API/settings yet), a new tenant module
preset `news_portal_full_online_r2` (bundling `blog_content` +
`tenant_domain` + `visitor_analytics` + `module_management` +
`identity_access` + `news_portal`, `module-management/domain/module-presets.ts`),
and its activation readiness gate: `applyNewsPortalFullOnlineR2Preset`
(`news-portal/application/apply-news-portal-preset.ts`) is the sanctioned
entry point, requiring `NEWS_PORTAL_ENABLED=true`,
`NEWS_PORTAL_PROFILE=full_online_r2`, and complete `NEWS_MEDIA_R2_*`
config kept separate from `sync-storage`'s own `R2_*` credentials/bucket
(enforced, not just documented) before delegating to the existing generic
`applyModulePreset`. Every activation attempt (rejected or applied) is
audited.

New env vars (`.env.example`, doc 18 §News portal): `NEWS_PORTAL_ENABLED`,
`NEWS_PORTAL_PROFILE`, and the `NEWS_MEDIA_R2_*` family
(`ENABLED`/`ACCOUNT_ID`/`ACCESS_KEY_ID`/`SECRET_ACCESS_KEY`/`BUCKET`/
`PUBLIC_BASE_URL`/`PRESIGNED_UPLOAD_TTL_SECONDS`/`MAX_UPLOAD_BYTES`/
`ALLOWED_MIME_TYPES`/`PENDING_TTL_MINUTES`) — deliberately namespaced
`NEWS_MEDIA_R2_*` rather than reusing `sync-storage`'s `R2_*` names (see
architecture doc §2/§4 and `.claude/skills/awcms-mini-news-portal/SKILL.md`
§632 for the full naming-reconciliation rationale). No new
`DEPLOYMENT_PROFILE`/`BLOG_PUBLIC_ROUTE_MODE`/`BLOG_PUBLIC_BASE_PATH` env
vars were added — those concepts already exist as other mechanisms
(per-tenant `blog_content` settings, `PUBLIC_CANONICAL_BASE_PATH`, or
simply don't exist as a real need in this repo's per-feature-flag
convention).

`bun run config:validate` and `bun run security:readiness` both cover the
new preset's config (shape, conditional-required vars, and hard
separation from `sync-storage`'s R2 config). No schema/migration changes
in this issue — no local filesystem upload fallback exists or was added
(structurally guarded by a new test, not a runtime flag).
