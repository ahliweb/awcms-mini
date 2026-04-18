# Security Operations

## EmDash Core Vs Mini Overlay

### EmDash Core

EmDash provides the host runtime and baseline auth boundary.

### Mini Overlay

Mini owns the security-hardening layer:

- login security events
- runtime-backed lockout handling
- TOTP enrollment and verification
- recovery codes
- forced password reset flows
- step-up requirements for high-risk admin actions
- security settings for staged mandatory 2FA rollout
- audit and security-event coverage for privileged recovery paths

## Current Controls

- password login with failure tracking
- lockout response for repeated failures
- mandatory password reset support
- TOTP-based 2FA and recovery codes
- admin-triggered 2FA reset with step-up enforcement
- active session inspection and revocation
- staged mandatory 2FA rollout modes: `none`, `protected_roles`, `custom`

## Operator Surfaces

Operators currently use:

- user `Security` tab
- user `Sessions` tab
- `Security Settings`
- `Audit Logs`

## Rollout Safety

Mini now supports:

- staged mandatory 2FA rollout controls
- ABAC audit-only rollout flags for selected authorization deny paths

These are rollout tools, not permanent substitutes for full enforcement.

## Cross-References

- `docs/security/emergency-recovery-runbook.md`
- `docs/process/migration-deployment-checklist.md`
