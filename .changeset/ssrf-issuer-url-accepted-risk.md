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

**Decided: do not add IP-range blocking.** This generic SSO feature only
activates in the `full_online` deployment profile, which still often
needs to reach an enterprise tenant's on-prem IdP (Keycloak/ADFS) over a
private VPN/tunnel path — a "bring-your-own-IdP" pattern common in
multi-tenant SaaS. A blanket private-IP block would break that legitimate
pattern.

**Correction from an initial draft of this decision** (caught by a
security-auditor pass before merge): the first version of this writeup
incorrectly invoked "AWCMS-Mini's LAN-first/offline deployment support"
as the rationale — but this feature is gated to activate *only* in the
`full_online` profile, the opposite of LAN-first/offline, which never
loads this code path at all. The corrected rationale above (enterprise
on-prem IdP reachable via VPN, from a `full_online` deployment) is what
actually applies. The writeup also initially overstated how much the
existing ABAC gate mitigates this: ABAC on
`identity_access.sso_providers.create`/`update` only limits who can
*configure* a malicious `issuer_url` — it does not limit who can *trigger*
the outbound fetch afterward, since `GET /api/v1/auth/sso/{providerKey}/start`
is unauthenticated and only rate-limited per-source+tenant (not per
`providerKey`), with a discovery cache that only fills on success. This
residual is now documented explicitly as accepted alongside the "no IP
blocking" decision, rather than implied to already be closed by ABAC.

Documented in `docs/awcms-mini/20_threat_model_security_architecture.md`
(A10 SSRF row + §Batasan yang dicatat), the `awcms-mini-auth-online-hardening`
skill (§SSRF/`issuer_url`), and an inline code comment in
`src/lib/auth/generic-oidc-client.ts`, so this reads as a deliberate,
accurately-scoped decision if revisited later — including a list of
cheap, not-yet-implemented follow-ups (per-`providerKey` rate limiting,
negative-TTL caching on failed discovery attempts, an infra-layer
recommendation to block cloud-metadata-endpoint egress for `full_online`
deployments, and a possible future opt-in strict-SSRF mode) that don't
require revisiting the core "no blanket IP blocking" call.
