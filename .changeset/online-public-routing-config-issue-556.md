---
"awcms-mini": minor
---

Add config-only support for online public tenant routing (Issue #556,
epic #555): `PUBLIC_TENANT_RESOLUTION_MODE`
(`host_default`/`env_default`/`setup_default`/`tenant_code_legacy`),
`PUBLIC_DEFAULT_TENANT_ID`, `PUBLIC_DEFAULT_TENANT_CODE`,
`PUBLIC_CANONICAL_BASE_PATH` (default `/news`), `PUBLIC_TRUST_PROXY`
(safe default `false`), and `PUBLIC_PLATFORM_ROOT_DOMAIN`. `bun run
config:validate` (`scripts/validate-env.ts`) now enforces the mode enum,
`host_default` requiring `PUBLIC_PLATFORM_ROOT_DOMAIN`, `env_default`
requiring at least one of `PUBLIC_DEFAULT_TENANT_ID`/
`PUBLIC_DEFAULT_TENANT_CODE`, and `PUBLIC_CANONICAL_BASE_PATH` being an
absolute path — while leaving every new var unset still passes
`config:validate`, so existing offline/LAN deployments are unaffected.
Documented in `docs/awcms-mini/18_configuration_env_reference.md` §Public
routing and `docs/awcms-mini/deployment-profiles.md` §Profil online, with
an explicit security note that `PUBLIC_TRUST_PROXY=true` must only be set
behind a trusted reverse proxy (a future host-based resolver, Issue #559,
would otherwise trust a spoofable `X-Forwarded-Host` header). No
tenant-domain schema, `/news` routes, or Cloudflare DNS integration in
this issue — those land in epic #555's remaining child issues
(#557-#567).
