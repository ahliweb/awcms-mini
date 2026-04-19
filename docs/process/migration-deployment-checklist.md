# Migration And Deployment Validation Checklist

This checklist standardizes pre-deploy and post-deploy validation for AWCMS Mini.

Use it for any deployment that changes schema, authentication, authorization, governance data, admin behavior, or plugin contract behavior.

## Pre-Deploy

Complete these checks before applying migrations or releasing a new build.

### Code Validation

- [ ] `pnpm check` passes for the current branch when the scoped change fits the baseline validation path
- [ ] `pnpm typecheck` passes
- [ ] `pnpm test:unit` passes
- [ ] `pnpm lint` passes for the maintained docs/config surface when documentation or workflow files changed
- [ ] Any issue-specific validation commands for the current release are complete

### Runtime Validation

- [ ] `pnpm build` passes
- [ ] `pnpm healthcheck` passes against the target environment or an equivalent pre-production environment
- [ ] `MINI_RUNTIME_TARGET=cloudflare` is set for the supported production path
- [ ] `DATABASE_URL` points to the intended PostgreSQL instance
- [ ] The configured public origin matches the Cloudflare-hosted URL
- [ ] Required security secrets are present for the target environment

### Schema Readiness

- [ ] Review pending migrations with `pnpm db:migrate:status`
- [ ] Confirm the release does not rely on ad hoc schema edits outside Kysely migrations
- [ ] Confirm rollback impact for the newest migration is understood before deployment

### Rollout Safety

- [ ] Record the currently deployed git commit
- [ ] Record whether ABAC audit-only flags are enabled
- [ ] Record the current mandatory 2FA rollout mode: `none`, `protected_roles`, or `custom`
- [ ] Record the effective mandatory 2FA role ids before the release

### Incident Preparedness

- [ ] Keep `docs/security/emergency-recovery-runbook.md` available during the deploy window
- [ ] Confirm at least one operator performing the deploy can complete admin step-up authentication if rollback or recovery actions are required

### Edge And Origin Readiness

- [ ] Cloudflare DNS for the public hostname is configured for the Cloudflare-hosted application path
- [ ] If a dedicated admin hostname is used, Cloudflare DNS/custom-domain config points it at the same Worker deployment
- [ ] `wrangler.jsonc` or equivalent deployment config matches the intended Worker name, assets, and bindings
- [ ] Non-interactive Cloudflare rollout automation has `CLOUDFLARE_API_TOKEN` available if Wrangler-managed binding changes are part of the release
- [ ] The `MEDIA_BUCKET` Worker binding points at the intended R2 bucket `awcms-mini-s3`
- [ ] `TRUSTED_PROXY_MODE=cloudflare` is configured for the supported production path
- [ ] The adapter's default `SESSION` binding or an explicit equivalent binding is available for the target environment

### PostgreSQL Readiness

- [ ] PostgreSQL access is restricted to the intended application host or private network path
- [ ] PostgreSQL transport security expectations are confirmed for the target environment
- [ ] `id1.ahlikoding.com` resolves to the reviewed PostgreSQL VPS and the certificate covers that hostname when `sslmode=verify-full` is expected
- [ ] If Hyperdrive is used, its binding/configuration points to the intended PostgreSQL target
- [ ] If Hyperdrive is used, the reviewed Hyperdrive configuration ID is available for the target Cloudflare account before the release window
- [ ] If Hyperdrive is used, the reviewed Cloudflare-to-origin connection path is allowed by PostgreSQL and host firewall policy before `wrangler hyperdrive create` or deployment rollout
- [ ] The remote PostgreSQL access rule uses the narrowest practical source range for the app host or private subnet
- [ ] `pg_hba.conf` and server config require the intended remote authentication and TLS posture
- [ ] The application user does not rely on superuser credentials

## Migration Window

Perform these steps during the release window.

1. Run `pnpm db:migrate`
2. Run `pnpm db:migrate:status`
3. Confirm no unexpected pending migrations remain
4. Deploy the application build
5. Run `pnpm healthcheck`

If a migration fails:

- Stop the release
- Capture the failing migration name and error output
- Use the recovery runbook before attempting manual intervention
- Only run `pnpm db:migrate:down` if the migration and operational impact have been reviewed for safe rollback

## Post-Deploy Validation

Validate the live system in this order.

### Schema

- [ ] `pnpm db:migrate:status` shows the expected applied migration state
- [ ] No unexpected migration drift is present between environments

### Auth

- [ ] Standard password login still succeeds for a known valid account
- [ ] Invalid password attempts still fail correctly
- [ ] Lockout behavior still returns the expected blocked response after repeated failures where applicable
- [ ] Password reset request and consume flows still behave correctly for test users
- [ ] Client IP logging and lockout behavior reflect the intended proxied request path
- [ ] When Turnstile is enabled, valid solves succeed and invalid or missing tokens fail for the protected public flows
- [ ] When split hostnames are enabled, Turnstile hostname validation accepts only the reviewed public/admin hostname set

### RBAC

- [ ] Admin routes still require the expected permissions
- [ ] A user with baseline RBAC permission can still access intended routes
- [ ] A user without the baseline permission still receives the expected denial path

### ABAC And Rollout Flags

- [ ] Protected-target rules still deny by default when rollout flags are disabled
- [ ] If ABAC audit-only flags are enabled intentionally, verify requests return `ALLOW_ABAC_AUDIT_ONLY` instead of silently bypassing policy
- [ ] Confirm audit-only mode is limited to the intended rollout scope and not left broadly enabled by mistake

### Regions

- [ ] Logical region admin routes still load and authorize correctly
- [ ] Administrative region admin routes still load and authorize correctly
- [ ] User detail views still show logical and administrative region assignments
- [ ] Region-scoped authorization still behaves correctly for in-scope and out-of-scope targets

### Two-Factor Authentication

- [ ] Security settings page loads
- [ ] Mandatory 2FA rollout mode is the expected value after deployment
- [ ] If rollout mode is `protected_roles`, verify protected roles resolve as the effective mandatory 2FA set
- [ ] If rollout mode is `custom`, verify the selected role ids match expectation
- [ ] Admin 2FA reset still requires step-up authentication

### Audit And Security Events

- [ ] Recovery and security-sensitive actions still append audit entries
- [ ] Security event flows still append the expected security-event records for relevant paths
- [ ] Audit log admin screen still loads and filters correctly

### Plugin Contract

- [ ] Plugin permission manifests still normalize correctly
- [ ] Declarative plugin route authorization still works for protected routes
- [ ] Plugin service authorization helpers still evaluate declared permissions correctly
- [ ] Plugin audit helper still appends plugin-tagged audit entries
- [ ] Plugin region-awareness helper still resolves scope ids for user-targeted resources
- [ ] The internal governance sample plugin contract test still passes in CI or pre-release validation

## Suggested Manual Validation Targets

Use these focused checks when the release touches governance or security surfaces.

### Admin Plugin

- [ ] `/_emdash/` redirects to `/_emdash/admin`
- [ ] `/_emdash/admin` loads
- [ ] User detail tabs load: `Overview`, `Roles`, `Jobs`, `Logical Regions`, `Administrative Regions`, `Sessions`, `Security`
- [ ] Protected action confirmations still appear for high-risk user-detail actions
- [ ] Admin routes load correctly through the Cloudflare public hostname
- [ ] If `ADMIN_SITE_URL` is configured for compatibility, the admin hostname root redirects to the configured admin entry path and the admin surface still loads correctly there

### Cloudflare Automation

- [ ] `https://awcms-mini.ahlikoding.com/` responds through the current Cloudflare-hosted Worker deployment
- [ ] `https://awcms-mini.ahlikoding.com/_emdash/` redirects to `/_emdash/admin` on the same host
- [ ] If a compatibility admin hostname is still enabled, its root redirects to the configured admin entry path on the same Worker deployment
- [ ] Turnstile-protected public flows behave correctly for the reviewed hostname set
- [ ] The deployed Worker still exposes the `MEDIA_BUCKET` binding for `awcms-mini-s3`
- [ ] The deployed runtime secret for `DATABASE_URL` matches the reviewed PostgreSQL hostname and SSL mode for the environment
- [ ] Cloudflare-side hostname, Turnstile, and R2 configuration changes are reflected in the current operator notes before release signoff

### Security Settings

- [ ] `Security Settings` can switch between `none`, `protected_roles`, and `custom`
- [ ] Security policy survives an app restart or instance replacement
- [ ] Saving the security policy appends the expected audit entry
- [ ] Security-sensitive admin actions do not depend on client-supplied authorization headers

### Sessions And Recovery

- [ ] Per-session revoke still works
- [ ] Revoke-all sessions still works
- [ ] Forced password reset still revokes sessions and clears lockout counters on successful reset consumption

## Rollback Triggers

Roll back or pause the release if any of these occur:

- Migration failure or schema drift cannot be explained immediately
- Auth login breaks for known valid accounts
- Protected users can no longer be recovered with the documented flows
- RBAC or ABAC checks unexpectedly allow high-risk actions
- Audit entries stop appearing for plugin-managed or security-sensitive actions
- Mandatory 2FA rollout applies to the wrong role set
- Cloudflare automation leaves hostname routing, Turnstile validation, or R2 binding state partially applied and the smoke tests no longer pass

## Explicitly Avoid

- Manual schema edits during a standard deployment window
- Direct SQL updates to recover auth state unless an approved incident path requires it
- Disabling authorization logic in code as a deploy shortcut
- Skipping migration status checks after applying migrations
- Treating audit-only rollout mode as a permanent steady-state configuration

## Minimum Command Set

```bash
pnpm typecheck
pnpm test:unit
pnpm build
pnpm db:migrate:status
pnpm db:migrate
pnpm db:migrate:status
pnpm healthcheck
```
