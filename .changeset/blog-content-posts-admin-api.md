---
"awcms-mini": minor
---

Add the blog post admin API (Issue #538, epic #536): tenant-scoped CRUD
plus lifecycle actions (submit-review, publish, schedule, archive,
restore, purge) at `/api/v1/blog/posts`, built on the `blog_content`
schema/permission foundation from Issue #537. Enforces RBAC/ABAC
(including an author-may-edit-their-own-unpublished-draft override),
rejects unsafe HTML/script content, requires `Idempotency-Key` on
publish/schedule/archive/restore/purge, and writes an audit event for
every state change. Extends `identity-access`'s `AccessAction` union with
`publish`/`schedule`/`archive`. OpenAPI updated with the new "Blog Posts"
paths/schemas.
