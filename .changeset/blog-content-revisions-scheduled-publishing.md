---
"awcms-mini": minor
---

Add revision history and scheduled publishing to the `blog_content` module
(Issue #541, epic #536): append-only revisions for posts/pages (a
significant title/contentJson/contentText change on `PATCH` snapshots
one), revision list/detail/restore at
`/api/v1/blog/posts/{id}/revisions` (restore requires explicit
`blog_content.revisions.restore` permission and an `Idempotency-Key`, and
itself appends a new revision rather than overwriting history), the
`bun run blog:publish:scheduled` job (idempotent, publishes due
`status='scheduled'` posts per tenant), and the full AsyncAPI
domain-event contract for the module's post/term/revision lifecycle
(documented-contract-only, same structured-logger-producer convention as
every other module's events).
