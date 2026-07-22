---
"awcms-mini": patch
---

Fix `Dockerfile.production` runtime image missing `i18n/`, `sql/`, `openapi/`, `asyncapi/` — caused HTTP 500 on any page needing translation (e.g. `/login`) when deployed via this Dockerfile.
