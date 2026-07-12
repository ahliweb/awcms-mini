---
"awcms-mini": minor
---

Add a content quality checklist for news portal publishing (Issue #640,
epic `news_portal` #631-#642/#649): title/slug/excerpt/meta description
presence, featured image existence + verified-R2 reference + alt text +
dimensions + MIME/size metadata, `og:image` trust, rejection of local
image paths and arbitrary external image URLs in news image blocks,
gallery image verification, category/taxonomy presence, unsafe
HTML/script/embed rejection, and scheduled-publish-time validity — 17
rules across three severities (`blocking`/`warning`/`info`).

Server-side enforcement, not just a client-side preview: `POST
/api/v1/blog/posts/{id}/publish` and `.../schedule` now run the
checklist before the state transition and reject with `422
CONTENT_QUALITY_CHECKLIST_BLOCKED` when a blocking rule fails (audited
via `blog.post.publish_blocked_by_checklist`/`schedule_blocked_by_checklist`).
The scheduled-publish worker (`publishDueScheduledPosts`) was
restructured from a single bulk `UPDATE` into a per-post loop so a due
post that now fails the checklist is left `scheduled` (audited via
`blog.post.scheduled_publish_blocked`) instead of silently publishing —
closing the same class of bypass Issue #636's revision-restore fix
closed for content_json/featuredMediaId writes. Two new read-only
preview endpoints, `GET /api/v1/blog/posts/{id}/quality-checklist` and
`GET /api/v1/blog/pages/{id}/quality-checklist`, back a new checklist
panel in both admin editors.

Five security rules (unsafe HTML, local image path, external image
URL, unverified/cross-tenant featured image, unverified gallery image)
can never be downgraded by tenant policy, in any environment. Seven
non-security rules are tenant-configurable via a new
`contentQualityChecklistPolicy` field on `PATCH /api/v1/blog/settings`
(stored in the existing `awcms_mini_blog_settings.settings` column —
no new migration).

The entire checklist is a no-op (`applicable: false`) unless
full-online R2-only news portal mode (Issue #632/#636) is active for
the tenant — the vast majority of `blog_content`-only tenants see zero
behavior change.
