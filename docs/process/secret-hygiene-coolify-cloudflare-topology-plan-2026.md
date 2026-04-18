# Secret Hygiene, Coolify MCP, And Cloudflare Topology Plan 2026

## Purpose

This document captures the next planning pass for AWCMS Mini around operator secret hygiene, external MCP configuration, and Cloudflare deployment topology.

It uses `docs/process/ai-workflow-planning-templates.md` as a primary process reference and keeps the recommendations aligned with the current repository baseline:

- EmDash `0.5.0` remains the host architecture
- AWCMS Mini remains single-tenant
- Cloudflare-hosted Worker runtime remains the supported app-hosting baseline
- PostgreSQL remains the system of record on a protected VPS managed through Coolify
- public/admin hostname separation must not introduce a second admin platform or separate auth core

It also reflects current OWASP, Cloudflare, and operator-hygiene guidance for secret handling, deployment seams, and rollback-safe infrastructure changes.

## Current Baseline

### Confirmed Repository State

- The current repository already routes operational secrets through environment variables and runtime config rather than hardcoding them in application services.
- The current maintained scripts under `scripts/` load `.env` and `.env.local` when needed and do not currently embed confirmed live credentials in the checked-in code paths that were reviewed during this planning pass.
- `.env.example` already documents the main runtime secrets and bindings used by the current Cloudflare-hosted baseline.
- `wrangler.jsonc` currently declares Worker custom domains for:
  - `awcms-mini.ahlikoding.com`
  - `awcms-mini-admin.ahlikoding.com`
- `wrangler.jsonc` currently declares the `MEDIA_BUCKET` binding for `awcms-mini-s3`.
- The current admin-domain split is hostname-aware but still points at the same EmDash admin surface under `/_emdash/admin`.
- Turnstile hostname allowlists and JWT edge auth already exist in the current runtime baseline.

### Confirmed Gaps

- The repository does not yet have a dedicated operator runbook for auditing scripts and automation helpers for secret leakage or unsafe credential handling.
- The repository does not currently document an explicit Coolify MCP configuration pattern, secret-storage expectation, or local operator workflow for using an operator-provided Coolify token safely.
- The repository does not yet document whether a Cloudflare Pages plus Cloudflare Workers split is recommended, unsupported, or conditionally feasible for the current EmDash-first architecture.
- The current Cloudflare recommendations focus on Worker-hosted runtime automation, not on the architectural trade-offs of splitting public and admin surfaces across Pages and Workers.

### Important Evidence From This Pass

- The script review performed for this planning pass did not confirm checked-in live credentials embedded in the maintained `scripts/**` entrypoints.
- That means the planning target should be framed as a prevention and audit hardening pass, not as a claim that the current repo definitely contains committed secrets in scripts.
- The Coolify token supplied for this request should be treated as sensitive operator input and must not be written into repository files, committed scripts, or GitHub issue bodies.
- The current tool session does not expose a Coolify MCP configuration surface, so this plan can only recommend the correct secret-handling and configuration path rather than applying that MCP configuration directly.

## Planning Goals

Add or improve the following capabilities without breaking EmDash-first rules:

1. ensure credentials are not embedded in maintained scripts and are instead sourced from `.env`, `.env.local`, deployment environment variables, or external secret stores as appropriate
2. define a safe, non-repository workflow for configuring Coolify MCP access with an operator-provided token
3. keep the admin domain separate from the public domain using the previously adopted hostnames while preserving the same EmDash admin surface
4. determine whether Cloudflare Pages for public and Cloudflare Workers for admin is feasible and whether it should be recommended for the current architecture

## Recommended Workstreams

### 1. Secret Hygiene Audit For Scripts And Operator Helpers

Recommended direction:

- treat secret hygiene as an explicit operator and repository concern even if no current embedded credentials are confirmed
- audit maintained scripts, local automation helpers, and setup docs for:
  - hardcoded credentials
  - inline tokens in command examples
  - secrets echoed to stdout or captured in logs
  - scripts that bypass existing `.env` loading patterns
- standardize on:
  - `.env.example` for safe documented variable names and placeholders
  - `.env.local` for local operator secrets that must never be committed
  - deployment-managed environment variables or Cloudflare-managed secrets for production values

Recommended repository rules:

- do not commit actual credentials, tokens, or API keys to scripts, docs, examples, issue bodies, or config files
- do not place production credentials in `.env.example`
- keep scripts generic and make them fail clearly when required env vars are missing
- prefer explicit variable names over positional secret arguments when scripting sensitive operations

Recommended follow-up deliverables:

- a focused audit checklist for operator-managed scripts and helper commands
- doc updates clarifying where local-only secrets belong versus deployment secrets
- focused cleanup only if the audit finds real embedded secret values or unsafe examples

### 2. Coolify MCP Token Handling And Configuration

Recommended direction:

- treat Coolify MCP configuration as operator-local or environment-managed configuration, not repository configuration
- do not store the operator-provided Coolify token in source control, docs examples, GitHub issues, or tracked shell scripts
- if Coolify MCP is configured in an external MCP client file or local tool config, source the token from a local-only env var or OS secret store where the client supports it

Recommended security posture:

- keep the Coolify token server-only and operator-scoped
- prefer the smallest token scope available from Coolify
- rotate the token if it was ever pasted into a location that may be retained in logs, shell history, or issue trackers
- keep Coolify administrative credentials separate from runtime application credentials

Recommended operator workflow:

1. store the Coolify token in a local-only secret location such as `.env.local`, shell secret manager, password manager CLI integration, or MCP client secret storage
2. reference that secret indirectly from the MCP client configuration if the client supports env interpolation
3. verify the token is not printed by wrapper scripts or shell history helpers
4. document the presence of the MCP integration in operator docs without documenting the live token value itself

Recommended repository stance:

- document the expected variable name and storage location pattern if needed
- do not add the live token to repo files
- do not add a fake hardcoded token placeholder to executable scripts if that encourages copy-paste replacement in tracked files

### 3. Public And Admin Domain Separation

Recommended direction:

- keep `awcms-mini.ahlikoding.com` as the canonical public hostname
- keep `awcms-mini-admin.ahlikoding.com` as the dedicated admin entry hostname
- continue using the admin hostname only as an entry host for the same EmDash admin surface under `/_emdash/admin`
- preserve the existing host-aware redirect behavior instead of creating a second admin app or parallel identity flow

This remains the recommended baseline because it improves operator clarity and policy targeting without creating a second platform core.

Recommended security posture:

- prefer host-only cookies unless a reviewed operator workflow requires cross-host sharing
- keep origin, redirect, and CSRF validation aligned with the reviewed hostname set
- keep Turnstile hostname allowlists and login protections aligned with both hostnames
- keep admin and public WAF/rate-limit posture independently reviewable even if both hostnames hit the same Worker deployment

### 4. Cloudflare Pages For Public And Workers For Admin

### Short Answer

Yes, it is technically possible to separate the deployment so that the public site uses Cloudflare Pages while the admin surface uses Cloudflare Workers.

### Recommended Architectural Answer For Current AWCMS Mini

This is not the recommended baseline for the current repository state.

### Why It Is Technically Possible

- Cloudflare Pages supports custom domains, environment variables, and resource bindings for Pages Functions.
- Cloudflare Workers supports the current custom-domain, secret, and binding model already used by AWCMS Mini.
- In principle, the public website could be split into a separate Pages project while the authenticated admin and dynamic governance runtime remain on Workers.

### Why It Is Not The Recommended Current Baseline

- AWCMS Mini is currently a single EmDash-hosted application, not a cleanly separated public-static app plus standalone admin runtime.
- The current public/auth/admin flows share runtime assumptions, hostname handling, security controls, and deployment validation.
- Splitting public Pages from admin Workers would introduce extra deployment surfaces for:
  - auth and cookie behavior
  - Turnstile integration and hostname management
  - runtime config duplication
  - asset, route, and healthcheck coordination
  - rollback complexity
- It would also require a sharper decision on which routes belong to the public Pages project versus the Worker-hosted app.

### Recommended Conclusion

- keep the current baseline as a single Cloudflare-hosted Worker deployment for both public and admin hostnames
- only explore a Pages-plus-Workers split if there is a concrete product requirement for a static-first public site with independently deployable release cadence
- if that exploration is needed later, treat it as a separate architecture decision issue rather than an incremental deployment tweak

## Security Standards And Recommendations

### OWASP-Aligned Recommendations

- keep secrets out of source control and out of operator-visible logs wherever possible
- apply least privilege to Coolify, Cloudflare, database, and automation credentials
- separate runtime secrets from operator automation secrets
- rotate credentials when exposure is suspected rather than relying on obscurity or prompt-history cleanup
- keep generic error handling for auth and recovery flows
- keep audit coverage for privileged recovery and configuration changes

### Cloudflare-Aligned Recommendations

- keep production application hosting on the reviewed Worker baseline unless an explicit architecture issue approves a split
- keep custom domains, Turnstile config, Worker bindings, and runtime secrets declarative or environment-managed where practical
- use Cloudflare-managed secrets or equivalent server-only configuration for Turnstile and edge auth secrets
- keep custom domains attached through the Worker custom-domain path when the Worker is the origin

### Coolify And PostgreSQL Recommendations

- keep Coolify administrative tokens separate from app runtime env vars
- do not reuse the same credential for Coolify automation and database access
- keep PostgreSQL credentials application-scoped and non-superuser
- keep remote database traffic protected with TLS and restricted ingress rules

## Proposed Execution Order

1. perform a focused secret-hygiene audit of maintained scripts, docs, and helper commands
2. document the non-repository Coolify MCP configuration and token-handling pattern
3. tighten any script/config/document examples that still encourage embedded credentials
4. keep the public/admin hostname split on the current Worker baseline and update docs if gaps remain
5. open a separate architecture-decision issue only if a Pages-plus-Workers split still has a concrete product driver after the audit

## Proposed Issue Breakdown

### Issue A: Audit Scripts And Docs For Secret Hygiene

Recommended follow-up issue: `#137`

- audit maintained scripts and docs for embedded secrets or unsafe secret-handling examples
- move any confirmed embedded credentials into env-based or secret-store-based configuration
- update examples so they use placeholders and documented env vars only

### Issue B: Document Coolify MCP Secret Handling

Recommended follow-up issue: `#138`

- document how operators should configure Coolify MCP access without committing tokens
- define the expected local-only env or secret-store pattern
- add warnings about shell history, issue bodies, and log leakage

### Issue C: Evaluate Pages-Plus-Workers As A Separate Architecture Decision

Recommended follow-up issue: `#139`

- evaluate whether a static-first public site on Cloudflare Pages has a concrete product need
- map route ownership, auth implications, deployment complexity, and rollback impact
- explicitly decide whether this architecture remains out of scope for the current baseline

## Validation Expectations

For this planning and documentation pass:

- review docs against the current repository state
- `pnpm lint`

For follow-up implementation or audit issues:

- `pnpm lint` for docs/config-only cleanup
- `pnpm check` for runtime or script behavior changes
- focused secret-hygiene review of changed scripts and examples

## Cross-References

- `docs/process/ai-workflow-planning-templates.md`
- `docs/process/cloudflare-hosted-runtime.md`
- `docs/process/cloudflare-hostname-turnstile-r2-automation-plan-2026.md`
- `docs/process/runtime-smoke-test.md`
- `docs/process/migration-deployment-checklist.md`
- `docs/process/postgresql-vps-hardening.md`
- `docs/security/operations.md`

## External Guidance References

- OWASP guidance on secret management, least privilege, and secure configuration
- Cloudflare Workers custom-domain guidance
- Cloudflare Pages bindings and custom-domain guidance
- Cloudflare guidance on keeping production traffic on reviewed custom-domain routes rather than ad hoc preview paths
