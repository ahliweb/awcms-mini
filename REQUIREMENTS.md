# AWCMS Mini Requirements

Requirements reference for AWCMS Mini, structured to mirror the concise repository-level documentation style used in EmDash.

## Purpose

Define the current product and implementation requirements for AWCMS Mini as an EmDash-first, single-tenant governance overlay.

## Core Requirements

- EmDash must remain the canonical host architecture.
- Mini must stay single-tenant.
- PostgreSQL must remain the single system-of-record database.
- Kysely must remain the canonical migration and query layer.
- Mini-specific features must be additive governance overlays rather than a second platform core.

## Required System Capabilities

- User lifecycle management with protected-user handling
- Active session tracking and revocation
- Login security event history
- RBAC permission catalog and role assignment model
- ABAC refinement in backend services and route guards
- Role hierarchy with `staff_level` and protected-role rules
- Job hierarchy with job levels, titles, user assignments, and history
- Logical region governance
- Indonesian administrative region governance
- TOTP-based 2FA with recovery codes
- Forced password reset and account recovery flows
- Audit logs and security events for privileged actions
- EmDash-compatible internal plugin governance contract
- EmDash admin extensions for governance operations

## Admin Requirements

Mini must keep governance operations inside the EmDash admin experience.

Required admin capabilities:

- user list and user detail surface
- role and permission matrix management
- job catalog and user job assignment management
- logical region and administrative region management
- session and login history review
- security settings and 2FA recovery operations
- audit log visibility

## Security Requirements

- Password-based login must remain supported.
- TOTP must remain the v1 two-factor mechanism.
- Protected actions must support step-up authentication.
- Lockout behavior must be tracked and auditable.
- Forced password reset must revoke prior sessions.
- Mandatory 2FA rollout controls must support staged activation.
- Audit and security-event coverage must exist for privileged recovery paths.

## Authorization Requirements

- RBAC is the explicit baseline permission model.
- ABAC refines access using subject, target, hierarchy, region, and session context.
- Authorization must be enforced in backend services and route guards.
- Audit-only rollout behavior may be used only as a controlled rollout tool.

## Plugin Requirements

Plugins must remain EmDash-compatible and consume shared governance helpers.

Required plugin contract pieces:

- permission registration
- route authorization helper
- service authorization helper
- audit helper
- region-awareness helper

Plugins must not bypass shared governance services or write arbitrary policy state without shared validation.

## Documentation Requirements

The repository must keep operator and architecture guidance for:

- architecture overview
- auth and authorization
- roles, jobs, and regions
- security operations and recovery
- plugin contract guidance
- admin operations
- deployment validation

## Non-Requirements

The following remain out of scope for Mini v1:

- multi-tenant logic
- Supabase-managed auth or migration architecture
- a second standalone admin shell
- visual editor work as a core v1 requirement
- marketplace-grade untrusted plugin product scope
- ERP-style expansion beyond governance overlays

## Related Documents

- `awcms_mini_implementation_plan.md`
- `awcms_mini_atomic_backlog.md`
- `docs/architecture/constraints.md`
- `docs/architecture/overview.md`
- `docs/security/emergency-recovery-runbook.md`
- `docs/process/migration-deployment-checklist.md`
