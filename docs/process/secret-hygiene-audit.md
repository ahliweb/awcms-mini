# Secret Hygiene Audit

## Purpose

This runbook standardizes how AWCMS Mini operators and maintainers audit maintained scripts, docs, and helper commands for unsafe secret handling.

Use it when:

- reviewing new scripts or automation helpers
- refreshing operator docs that mention tokens, secrets, or passwords
- checking whether tracked examples still normalize unsafe credential patterns
- validating that local-only secrets stay outside the repository

## Current Repository Finding

The current maintained `scripts/**` entrypoints reviewed in this pass did not confirm embedded live credentials in checked-in code.

The current maintained Node entrypoints now use the shared `scripts/_local-env.mjs` helper so local env loading stays auditable and consistent across script entrypoints.

The current repository posture should therefore be described as:

- no confirmed committed live credentials in the reviewed maintained scripts
- ongoing need for prevention and audit hardening
- local-only and deployment-managed secret handling should remain explicit in docs and examples

This runbook should not be used to overstate a leak that has not been confirmed.

## Secret Storage Rules

- keep production and operator secrets out of source control
- keep local-only secrets in `.env.local` or an equivalent local secret store
- keep production runtime secrets in deployment-managed environment variables, Cloudflare-managed secrets, or equivalent server-only storage
- keep operator automation secrets separate from runtime application secrets
- do not place live tokens, passwords, or keys in issue bodies, tracked scripts, or committed examples

## Audit Targets

Review these surfaces in order:

1. maintained scripts under `scripts/**`
2. `.env.example` and other tracked configuration examples
3. deployment and operator docs under `docs/process/**` and `docs/security/**`
4. repository entry docs such as `README.md`

## Audit Checklist

- check for hardcoded passwords, tokens, API keys, or credential-bearing URLs
- check for inline command examples that encourage replacing placeholders directly in tracked files
- check for scripts that print secrets to stdout, stderr, or thrown error messages
- check for scripts that bypass the documented `.env` and `.env.local` loading pattern
- check for production-like default values in tracked examples where placeholders would be safer
- check that docs distinguish local-only secrets from deployment-managed secrets
- check that secret examples use placeholders such as `<password>` or `replace-with-...`, not realistic reusable values

## Expected Patterns

Preferred repository patterns:

- `.env.example` contains placeholder values only
- `.env.local` is local-only and untracked
- scripts use the shared local env loading pattern rather than reimplementing it ad hoc
- scripts fail clearly when required env vars are missing
- docs describe variable names and storage locations without including live values
- Coolify, Cloudflare, and database credentials remain separate by purpose and scope

## Cleanup Rules

If the audit finds a confirmed issue:

1. replace the tracked secret or unsafe example with a placeholder or env-based lookup
2. update the nearest operator or runtime doc so the supported storage location is explicit
3. rotate the affected credential if there is any chance it was live
4. capture the cleanup in an issue-scoped change rather than bundling unrelated script cleanup into the same fix

If the audit does not find confirmed live secrets:

- document the finding accurately
- tighten any examples that still normalize unsafe patterns
- avoid overstating the result as a confirmed credential leak

## Current Example Guidance

- use placeholder database passwords in `.env.example` instead of literal local defaults
- keep Coolify MCP tokens out of tracked files and issue bodies
- keep `CLOUDFLARE_API_TOKEN` out of tracked files and issue bodies
- keep Cloudflare Turnstile and JWT secrets in server-only configuration
- keep production database credentials distinct from local development placeholders

## Validation

- `pnpm lint` for docs and config-example updates
- focused review of changed examples for residual secret exposure
- `pnpm check` only if the audit changes runtime or script behavior

## Cross-References

- `docs/process/secret-hygiene-coolify-cloudflare-topology-plan-2026.md`
- `docs/process/ai-workflow-planning-templates.md`
- `docs/process/cloudflare-hosted-runtime.md`
- `docs/process/postgresql-vps-hardening.md`
- `docs/security/operations.md`
