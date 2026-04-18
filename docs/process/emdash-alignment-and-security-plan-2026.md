# EmDash Alignment And Security Plan 2026

## Purpose

This document captures the current repository-state review for AWCMS Mini and recommends the next update plan to keep Mini aligned with current EmDash conventions and modern security practice.

It is based on:

- current AWCMS Mini core docs, implementation, and scripts
- current EmDash reference repository docs and package conventions
- current OWASP guidance for authentication and session management
- current Cloudflare guidance for origin protection and edge hardening

## Current Baseline

### Confirmed Repository State

- AWCMS Mini remains structurally aligned with EmDash-first architecture.
- The installed `emdash` package version is still `0.5.0`, which matches the current EmDash core package version inspected in the reference repo.
- The main alignment gap is not package-version drift. The bigger gap is operational and architectural maturity around runtime configuration, security controls, and plugin/admin integration conventions.

### Confirmed Strengths

- Mini keeps EmDash as the host architecture instead of creating a parallel CMS core.
- Governance logic is primarily service-layer based.
- The repository has explicit architecture, governance, security, plugin, and process docs.
- The repo already includes migration scripts, healthcheck, audit logging, session handling, TOTP, recovery codes, and rollout-oriented authorization controls.

### Confirmed Gaps

- `src/security/policy.mjs` stores mandatory 2FA rollout policy in process memory only.
- `src/security/runtime-rate-limits.mjs` stores lockout and throttling counters in process memory only.
- Admin/plugin actor and session context currently depend on request headers such as `x-actor-user-id` and `x-session-id` in multiple places.
- The admin 2FA reset path currently trusts `x-session-strength` and `x-step-up-authenticated` request headers instead of deriving fresh step-up state from the server session.
- Runtime configuration docs only formalize `DATABASE_URL`, while the code also depends on security-sensitive configuration such as `MINI_TOTP_ENCRYPTION_KEY` or `APP_SECRET`.
- Login IP extraction currently trusts `x-forwarded-for` directly, which is not sufficient without an explicit trusted-proxy model.
- The password-reset handler returns a reset token in the JSON response. It does not appear to be routed today, but if exposed as-is it would not meet normal production security expectations.
- Mini does not yet reflect EmDash’s stronger contributor/tooling baseline such as `check`, `lint`, and `format` commands.

## EmDash Alignment Summary

### Already Aligned

- EmDash-first host architecture
- Astro server runtime with Node adapter
- PostgreSQL plus Kysely as the data layer
- plugin-based admin extension model
- service-layer authorization emphasis

### Needs Further Alignment

#### Runtime And Deployment Conventions

EmDash now documents a broader runtime contract, especially around:

- `siteUrl` and public-origin correctness
- reverse-proxy and forwarded-host handling
- secret-driven auth/runtime configuration
- deployment-specific operational expectations

Mini should adopt the same style of explicit runtime and deployment guidance.

#### Engineering Workflow Conventions

EmDash currently enforces a stronger baseline around:

- lint and format discipline
- additive, backward-compatible evolution
- forward-only migration mindset
- consistent API envelope and error handling rules
- documented database and index discipline

Mini already follows some of these informally, but they are not yet captured strongly enough in scripts and docs.

#### Plugin Conventions

EmDash’s plugin documentation now clearly distinguishes:

- descriptor/build-time concerns
- definition/runtime concerns
- admin entrypoints
- route and storage patterns

Mini’s plugin system is directionally correct, but its docs should map more explicitly to current EmDash vocabulary and patterns.

## Security Review Summary

### Highest-Priority Security Recommendations

#### 1. Stop Trusting Client-Supplied Admin Context Headers

Mini currently authorizes some plugin/admin behavior using request headers such as:

- `x-actor-user-id`
- `x-session-id`
- `x-session-strength`
- `x-step-up-authenticated`

These values should be derived from server-side session state or trusted host context, not accepted from the client request as authorization truth.

This is the most important correctness gap in the current implementation.

#### 2. Persist Security Policy And Rollout State

Mandatory 2FA rollout state should not live only in memory. In multi-instance or restart scenarios, this creates policy drift and makes operator behavior unreliable.

#### 3. Replace In-Memory Rate Limiting With Shared Storage

Current rate limiting and lockout counters are process-local. That is acceptable for early development, but not for scaled or multi-instance deployment.

Move these counters to a shared backend such as Redis or another TTL-capable store, and formalize the storage contract.

#### 4. Introduce Trusted Proxy And Real Client IP Rules

Direct use of `x-forwarded-for` is not enough. Mini should only trust forwarded client IP headers when the request comes through a trusted proxy path.

For Cloudflare-backed deployments, use a documented origin strategy and either:

- Cloudflare Tunnel
- Cloudflare allowlisted source ranges plus authenticated origin protections
- strict origin header validation where applicable

#### 5. Harden Sensitive Recovery Paths

OWASP guidance strongly favors:

- reauthentication for sensitive actions
- generic login and recovery responses where feasible
- session renewal or invalidation after risk events
- out-of-band password reset delivery instead of returning live reset tokens to the caller

Mini already has the right direction on step-up and session revocation, but the production path needs stricter enforcement.

### Additional Security Recommendations

#### Authentication

- Keep TOTP as the current enforced MFA baseline, but plan for phishing-resistant MFA support such as WebAuthn/passkeys if Mini remains a long-lived admin surface.
- Evaluate whether login error responses should be made more generic to reduce account-state enumeration risk.
- Add explicit password policy and reset-token handling rules to the security docs.

#### Session Management

- Ensure all auth cookies and session settings are explicitly documented and verified for `Secure`, `HttpOnly`, and `SameSite` behavior.
- Regenerate or rotate session state after authentication-strength changes and password reset events where the host/session framework allows it.
- Define idle timeout, absolute timeout, and step-up freshness expectations in docs.

#### Logging And Monitoring

- Keep logging decision-grade security events: login success/failure, lockout, step-up success/failure, session revocation, policy changes, and recovery actions.
- Add operator guidance for forwarding logs to centralized storage and alerting on abnormal auth behavior.

#### Cloudflare And Edge Hardening

- Prefer proxied DNS and origin IP concealment.
- Prefer Cloudflare Tunnel if operationally acceptable.
- Otherwise block direct origin access as much as possible and validate origin-bound traffic.
- Add rate limiting or managed challenge rules at the edge for login, password reset, and other abuse-prone endpoints.

## Recommended Workstreams

### P0: Security Correctness

1. Derive admin actor, session, and step-up state from trusted server context.
2. Persist security policy and rollout settings in durable storage.
3. Move lockout/rate-limit counters to a shared TTL-capable backend.
4. Formalize trusted-proxy client IP extraction and Cloudflare deployment assumptions.
5. Harden password-reset exposure and generic recovery behavior before routing the handlers publicly.

### P1: EmDash Runtime And Conventions Alignment

1. Expand runtime config to include public-origin and security-secret requirements.
2. Add deployment docs for Node, reverse proxy, and Cloudflare-backed operation.
3. Add `check`, `lint`, and `format` scripts and define the minimum validation path.
4. Strengthen architecture docs with EmDash-style API, migration, and database discipline guidance.
5. Update plugin docs to reflect current EmDash descriptor/definition/admin-route terminology.

### P2: Operational Hardening

1. Add centralized security logging and alerting guidance.
2. Expand healthcheck and smoke-test guidance for auth and admin readiness.
3. Add a Cloudflare origin-hardening runbook.
4. Evaluate phishing-resistant MFA roadmap after core step-up and policy correctness work is complete.

## Script And Tooling Recommendations

### Current Script Coverage

The repository currently includes:

- `pnpm dev`
- `pnpm build`
- `pnpm preview`
- `pnpm start`
- `pnpm typecheck`
- `pnpm test:unit`
- `pnpm healthcheck`
- `pnpm db:migrate`
- `pnpm db:migrate:down`
- `pnpm db:migrate:status`
- `pnpm db:seed:administrative-regions`

### Recommended Additions

- `pnpm check` to aggregate the minimum validation path
- `pnpm lint`
- `pnpm format`
- optionally `pnpm test` as a stable alias if the suite grows beyond unit tests

### Script-Specific Notes

- `scripts/db-migrate.mjs` is practical and already follows a forward-oriented migration workflow.
- `scripts/healthcheck.mjs` currently validates database reachability only. Keep it minimal, but pair it with a richer documented smoke test for auth/admin readiness.
- `scripts/create_github_issues_from_backlog.mjs` is backlog-specific and should remain distinct from new planning-derived issues.

## Recommended Documentation Updates After Implementation

When the issues below are completed, update:

- `docs/architecture/runtime-config.md`
- `docs/architecture/overview.md`
- `docs/security/operations.md`
- `docs/security/emergency-recovery-runbook.md`
- `docs/security/rate-limit-storage-strategy.md`
- `docs/process/migration-deployment-checklist.md`
- plugin docs under `docs/plugins/`

## Proposed Issue Breakdown

The recommended execution order is:

1. Fix trusted admin/session context and centralize step-up enforcement.
2. Persist security policy and rollout state.
3. Replace in-memory rate limiting and add trusted-proxy client IP handling.
4. Expand runtime/deployment configuration and Cloudflare guidance.
5. Harden password-reset exposure and recovery behavior.
6. Add tooling and validation parity with current EmDash conventions.
7. Refresh plugin and architecture docs after the implementation changes land.

## Issue Set Created From This Plan

This plan is intended to back the GitHub issues created from the same review.

Use this document as the canonical planning reference for those issues.

## External Guidance References

- OWASP Authentication Cheat Sheet
- OWASP Session Management Cheat Sheet
- Cloudflare origin protection guidance
