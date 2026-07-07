---
"awcms-mini": minor
---

Add presentation and monetization extensions to the `blog_content` module
(Issue #542, epic #536): tenant-scoped admin CRUD for templates
(whitelisted layout config), hierarchical navigation menus, position-based
widgets, and advertisements with placement targeting and scheduling
(`/api/v1/blog/{templates,menus,widgets,ads}`), a per-tenant blog theme
mode override (`/api/v1/blog/theme`, falling back to the tenant's base
theme), an optional `translation_group_id` linking locale-variants of a
post, and a new whitelisted `gallery` `content_json` block type for public
image/video display. Per the issue's own scope control, none of this
rebuilds the base media library, tenant system, RBAC/ABAC, audit, or theme
engine.
