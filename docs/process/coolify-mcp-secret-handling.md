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
- do not source `.env` files as shell code when a parser-based env loader is available

## Supported Storage Pattern

Use one of these local-only secret locations:

1. `.env.local` for the live token and any other local-only operator secrets
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

For direct Coolify API and MCP clients, this repo now uses the live API naming from Coolify tooling:

```text
COOLIFY_BASE_URL=https://app.coolify.io
COOLIFY_ACCESS_TOKEN=<local-only-secret>
```

`https://app.coolify.io` is the Coolify Cloud API base URL.

If you want a tracked example for non-secret local defaults, keep only `COOLIFY_BASE_URL` in `.env.example` and keep `COOLIFY_ACCESS_TOKEN` in `.env.local`.

The local wrapper now loads `.env.local` and `.env` through the shared Node env loader rather than sourcing them as shell code, which keeps local operator secrets aligned with the safer script pattern already used elsewhere in the repository.

## Local CLI And MCP Workflow

For Coolify Cloud:

1. keep `COOLIFY_BASE_URL` in `.env` or `.env.local` as needed, and keep `COOLIFY_ACCESS_TOKEN` in `.env.local`
2. run `coolify context set-token cloud "$COOLIFY_ACCESS_TOKEN"` to configure the CLI locally
3. run `pnpm coolify:mcp` when an MCP client should launch the local wrapper in this repository

The tracked wrapper script reads `.env.local` first and then `.env` through the shared Node loader, so operator-local secrets win without executing the files as shell code, and passes the credentials to the MCP server without storing the token in the script itself.

For Cloudflare-hosted deployment secrets, keep Worker runtime secrets in Wrangler-managed secrets or CI/CD-managed environment storage rather than tracked files. Use tracked `.env.example` values only for placeholders and non-secret defaults.

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

## Security Baseline

- prefer parser-based environment loading over shell evaluation for local secret files
- keep Cloudflare deployment secrets server-only, using `wrangler secret put` or reviewed CI/CD secret storage for deployed Worker secrets
- keep operator tokens least-privileged and scoped only to the Cloudflare or Coolify surfaces needed for the reviewed task
- rotate tokens after suspected exposure and document the rotation owner and reason
- keep PostgreSQL credentials distinct from Coolify and Cloudflare administrative credentials

This baseline aligns with the current AWCMS Mini posture:

- EmDash-first application hosted on Cloudflare Workers
- PostgreSQL hosted on a Coolify-managed VPS
- Hyperdrive and Tunnel rollout work separated from normal application runtime secrets

## Validation

- `pnpm lint` for docs-only changes
- focused review that no live token value appears in tracked files, issue bodies, or operator examples

## Cross-References

- `docs/process/secret-hygiene-audit.md`
- `docs/process/secret-hygiene-coolify-cloudflare-topology-plan-2026.md`
- `docs/process/cloudflare-hosted-runtime.md`
- `docs/process/postgresql-vps-hardening.md`
- `docs/security/operations.md`
