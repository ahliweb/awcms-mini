# Coolify MCP Secret Handling

## Purpose

This runbook defines the supported pattern for configuring Coolify MCP access without committing tokens to the AWCMS Mini repository.

It is aligned with the current baseline:

- AWCMS Mini is hosted on the Cloudflare Worker runtime
- PostgreSQL runs on a protected VPS managed through Coolify
- Coolify administrative automation is an operator workflow, not an in-app runtime feature

## Core Rule

Treat Coolify MCP credentials as operator-local or environment-managed secrets, not repository configuration.

That means:

- do not commit Coolify tokens to tracked files
- do not paste Coolify tokens into GitHub issues, PR bodies, or docs examples
- do not embed Coolify tokens in maintained scripts under `scripts/**`
- do not reuse Coolify administrative tokens as application runtime credentials

## Supported Storage Pattern

Use one of these local-only secret locations:

1. `.env.local`
2. a shell secret manager or password-manager CLI integration
3. the MCP client's local secret or environment-variable configuration if supported

Preferred pattern:

- store the live Coolify token in a local-only secret location
- expose it to the MCP client through an environment variable or client-managed secret reference
- keep the repository limited to documentation of the variable name and workflow, not the token value

## Recommended Variable Pattern

If an operator needs a documented local variable name, prefer a neutral local-only name such as:

```text
COOLIFY_MCP_TOKEN=<local-only-secret>
```

This variable name is documentation guidance only. The live value must stay outside tracked files.

## Operator Workflow

1. Generate or obtain the smallest-scope Coolify token available for the intended operator task.
2. Store the token in a local-only secret location such as `.env.local` or an external secret manager.
3. Configure the MCP client to read that token from the local environment or secret store.
4. Verify the token is not echoed in wrapper scripts, shell history helpers, or captured command logs.
5. Keep Coolify administrative credentials separate from:
   - `DATABASE_URL`
   - Cloudflare runtime secrets
   - Turnstile secrets
   - edge API JWT secrets

## Explicitly Avoid

- committing a live Coolify token to `.env.example`
- adding a live Coolify token to shell scripts or repository config files
- placing a Coolify token in issue bodies, issue comments, or PR descriptions
- documenting copy-paste examples that encourage replacing placeholders directly inside tracked files
- using Coolify credentials for runtime application access to PostgreSQL or Cloudflare

## Rotation Guidance

Rotate the Coolify token if it may have been exposed through:

- shell history
- terminal transcripts
- issue comments or PR bodies
- pasted examples in tracked docs
- CI logs or command output

After rotation:

1. update the local-only secret store
2. confirm the MCP client still authenticates correctly
3. verify the old token is no longer usable

## Separation Of Concerns

Keep these credentials separate by purpose:

- Coolify MCP token: operator automation credential
- `DATABASE_URL`: application runtime database credential
- Cloudflare runtime secrets: deployment/runtime secrets for the Worker
- Turnstile and JWT secrets: server-only application security secrets

This separation reduces blast radius and keeps least-privilege boundaries clearer.

## Validation

- `pnpm lint` for docs-only changes
- focused review that no live token value appears in tracked files, issue bodies, or operator examples

## Cross-References

- `docs/process/secret-hygiene-audit.md`
- `docs/process/secret-hygiene-coolify-cloudflare-topology-plan-2026.md`
- `docs/process/cloudflare-hosted-runtime.md`
- `docs/process/postgresql-vps-hardening.md`
- `docs/security/operations.md`
