---
"awcms-mini": patch
---

Close Issue #603 (follow-up from the manual review of PR #602/Issue #591)
as a documented, explicit decision — no code change.

`awcms_mini_auth_providers.issuer_url` (generic tenant OIDC SSO) is the
only outbound URL in this codebase that comes from tenant-admin data
rather than server-side environment configuration, unlike every other
provider adapter (R2, Mailketing, Cloudflare DNS/Turnstile), which all
follow a documented "SSRF-safe" convention. Issue #603 asked whether to
add IP-range blocking (resolve hostname, reject private/loopback/
link-local/cloud-metadata ranges) before the discovery/JWKS/token-exchange
fetches in `generic-oidc-client.ts`.

**Decided: do not add IP-range blocking.** AWCMS-Mini explicitly supports
LAN-first/offline deployments (doc 18) where a tenant's OIDC provider can
legitimately run on a private IP (on-prem Keycloak/ADFS reachable only via
LAN) — a blanket private-IP block would break that deployment model, not
just prevent attacks. This mirrors how Okta, Auth0, and Azure AD
themselves handle admin-configured issuer URLs (no IP-range restriction).
Existing mitigations remain the primary controls: ABAC on provider
create/update (`identity_access.sso_providers.create`/`update`), audit
logging on every provider change, and operator-level network segmentation
for genuinely sensitive internal services.

Documented in `docs/awcms-mini/20_threat_model_security_architecture.md`
(A10 SSRF row + §Batasan yang dicatat) and the `awcms-mini-auth-online-hardening`
skill (new §SSRF/`issuer_url`), plus an inline code comment in
`src/lib/auth/generic-oidc-client.ts`, so this reads as a deliberate
decision rather than an oversight if revisited later. If a future
full-online/SaaS-only deployment profile needs stricter SSRF protection,
it should be added as an opt-in (env-gated, default off) rather than a
blanket change, to avoid silently regressing LAN-first deployments.
