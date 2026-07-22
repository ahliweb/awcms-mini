---
"awcms-mini": minor
---

Add opt-in login tenant picker (`AUTH_LOGIN_TENANT_PICKER`). When enabled, `/login` renders the tenant field as a dropdown of active tenant names instead of a manual Tenant ID text input — the option value stays the tenant UUID, so form submit and Google-login wiring are unchanged. Off by default: enabling it lists every active tenant's name pre-auth (tenant enumeration), acceptable for single/few-tenant deployments but an info-disclosure for a multi-tenant one. Ported from the same feature in awcms-micro.
