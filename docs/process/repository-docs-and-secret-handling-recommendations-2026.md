# Repository Docs And Secret Handling Recommendations 2026

## Purpose

This document records the current recommendations for refreshing core repository guidance, AI workflow planning guidance, local skills, and secret-handling documentation in AWCMS Mini.

It follows the authority order in `REQUIREMENTS.md`, `AGENTS.md`, `README.md`, `DOCS_INDEX.md`, and the focused process/security/runtime docs.

It also follows the issue-driven planning rules in `docs/process/ai-workflow-planning-templates.md`.

## Current Confirmed Baseline

- EmDash `0.5.0` remains the canonical host architecture.
- AWCMS Mini remains single-tenant, PostgreSQL-backed, and Kysely-based.
- The supported runtime baseline is a Cloudflare-hosted Worker.
- PostgreSQL runs on a VPS managed through Coolify.
- The current reviewed production database transport is Cloudflare Hyperdrive.
- Media/file storage is expected to use the private R2 bucket bound as `MEDIA_BUCKET` with bucket name `awcms-mini-s3`.
- The reviewed admin browser entry remains `https://awcms-mini.ahlikoding.com/_emdash/`, which redirects into EmDash's `/_emdash/admin` surface.
- Turnstile still protects the public login, password-reset request, and invite-activation flows when configured.
- The private-database Cloudflare Tunnel path is active again, and the tunnel token is now stored in root-only VPS-managed storage with a weekly rotation timer.
- The reviewed Coolify-managed VPS now uses key-only root SSH recovery; password-based root SSH login is disabled and the root password is locked.

## Confirmed Documentation Drift

### Core Docs And Skills

- `README.md` still emphasizes older rollout caveats more than the now-restored live Hyperdrive path and current setup-status stability posture.
- `AGENTS.md` still says the live Hyperdrive rollout is blocked, which is no longer accurate.
- `docs/README.md` still references stale active rollout issues and older milestone context.
- local skills still refer to the older split between repository-side Hyperdrive prep and blocked operator rollout work.

### Planning Guidance

- `docs/process/ai-workflow-planning-templates.md` still describes the Hyperdrive path as mainly operator-blocked rather than as the current reviewed live baseline.
- the planning template baseline should now include the restored tunnel/connectivity posture, weekly tunnel-token rotation, and key-only VPS recovery.

### Secret Handling And Env Guidance

- `.env.example` still carries superseded `VPS_ROOT_PASSWORD` guidance even though the reviewed recovery posture is now key-only SSH.
- `docs/process/secret-hygiene-audit.md` still treats `VPS_ROOT_PASSWORD` as an active operator-managed env-style variable class instead of a retired recovery path.
- security and operator docs should consistently distinguish:
  - local operator secrets in `.env.local`
  - deployment/runtime secrets in Cloudflare-managed or CI/CD-managed storage
  - VPS connector secrets in root-only server-managed storage

## Script Audit Finding

The current maintained `scripts/**` entrypoints reviewed in this pass do not confirm embedded live credentials in tracked repository code.

That means the current task should be framed as:

- documentation and env-guidance alignment
- secret-handling prevention and hardening
- issue-driven follow-up planning

It should not be framed as a confirmed committed-secret incident.

## Recommended Workstreams

### 1. Refresh Core Repository Docs And Skills

Issue: `#199`

Recommended changes:

- refresh `README.md`, `AGENTS.md`, `DOCS_INDEX.md`, and `docs/README.md`
- update local skills so they describe the current live/runtime posture accurately
- keep the docs explicit about the current Cloudflare Worker, Hyperdrive, R2, Turnstile, and key-only VPS recovery posture
- keep rollout-only controls such as staged 2FA enforcement and ABAC audit-only mode documented carefully

### 2. Update AI Workflow Planning Templates

Issue: `#200`

Recommended changes:

- update the current repository baseline section
- remove stale blocked-rollout language
- add current operator guardrails for root-only VPS-managed tunnel token storage, weekly tunnel rotation, and key-only SSH recovery
- keep the templates atomic, token-efficient, and issue-driven

### 3. Align Secret-Handling Docs And Env Examples

Issue: `#201`

Recommended changes:

- update `.env.example` so it no longer normalizes `VPS_ROOT_PASSWORD` as an active operator variable for this environment
- refresh `docs/process/secret-hygiene-audit.md` and related docs to match the current storage classes
- document the VPS-managed Cloudflare tunnel-token rotation posture accurately
- keep the current script audit statement explicit: no confirmed embedded live credentials in maintained tracked scripts

## Security Recommendations

### OWASP-Aligned

- keep secrets out of source control, stdout, and issue bodies
- prefer least privilege for Cloudflare, Coolify, PostgreSQL, and automation credentials
- keep runtime secrets separate from operator automation secrets
- rotate secrets when exposure is suspected or when a secret remains duplicated longer than necessary
- keep security-sensitive recovery paths auditable and operationally simple

### Cloudflare-Aligned

- keep production runtime secrets in Cloudflare-managed secrets or CI/CD-managed storage
- keep tunnel tokens out of local operator env files once the reviewed VPS-managed path exists
- keep R2 private by default and use Worker bindings instead of embedded object-store credentials in scripts

### Coolify/VPS-Aligned

- use the Coolify-managed SSH key as the reviewed recovery path
- keep password-based root SSH recovery disabled unless a separately reviewed incident explicitly reintroduces it
- keep root-only server-managed files for tunnel runtime and rotation material protected with restrictive permissions

## Validation Guidance

- `pnpm check:secret-hygiene`
- `pnpm lint`

Use broader validation only if a follow-on issue changes runtime behavior rather than docs, env examples, or maintained guidance.

## Resulting Issue Set

- `#199` docs: refresh core repository guidance and skills for the current Cloudflare/Coolify runtime posture
- `#200` docs: update AI workflow planning templates for the current live runtime and operator posture
- `#201` security: align env examples and secret-handling docs with current VPS-managed tunnel rotation and key-only SSH recovery
