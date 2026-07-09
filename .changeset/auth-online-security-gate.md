---
"awcms-mini": minor
---

Add the full-online-only auth security feature gate (Issue #587), the
foundational config gate for the new full-online auth hardening epic
(#587-#593): Cloudflare Turnstile (#588), MFA/TOTP (#589), Google OIDC
login (#590), generic tenant OIDC SSO (#591), and an admin policy UI
(#592) will all depend on this gate before doing anything online/
provider-related — none of them exist yet in this repo, only the shared
gate itself.

Two new env vars, both optional/backward-compatible:
`AUTH_ONLINE_SECURITY_ENABLED` (default `false`) and
`AUTH_ONLINE_SECURITY_PROFILE` (default `disabled`, only other valid
value `full_online`). Left unset — the default for every local/offline/
LAN deployment — nothing changes and no provider credential is ever
required. Setting `AUTH_ONLINE_SECURITY_ENABLED=true` requires
`AUTH_ONLINE_SECURITY_PROFILE=full_online`; any other combination fails
`bun run config:validate`.

New `src/lib/auth/online-security-config.ts`: `isOnlineSecurityEnabled`,
`resolveOnlineSecurityProfile`, and `isFullOnlineSecurityActive` — the
one function every future full-online-only feature should call rather
than re-deriving the "both vars must agree" rule itself. Also adds
`checkOnlineAuthSecurityConfig` to `scripts/validate-env.ts` and
`checkOnlineAuthSecurityReady` to `scripts/security-readiness.ts`
(critical severity, but `status: pass` when the gate is simply
disabled — informational, not a failure, per the issue's own
acceptance criteria).

Docs updated: `.env.example`, `docs/awcms-mini/18_configuration_env_reference.md`,
`docs/awcms-mini/deployment-profiles.md`, `src/modules/identity-access/README.md`.
