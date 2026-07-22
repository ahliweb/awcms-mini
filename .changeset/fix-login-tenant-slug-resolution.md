---
"awcms-mini": patch
---

Fix `POST /api/v1/auth/login` throwing `Expected a UUID, received: <slug>` when the `x-awcms-mini-tenant-id` header carries a tenant_code slug (as the demo login page collects) instead of a UUID — every real login failed with a stream of `auth.login.audit_write_failed` warnings. A non-UUID header is now resolved to its tenant UUID via `tenant_code`; an unresolvable code returns `403 ACCESS_DENIED` (never a 500). UUID headers are unchanged.
