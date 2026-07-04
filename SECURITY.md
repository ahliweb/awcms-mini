# Security Policy

AWCMS-Mini is the Bun + Astro 7 + PostgreSQL baseline for AhliWeb application development. Security reports should be handled privately and must not include production secrets, customer data, database dumps, access tokens, or screenshots that expose restricted information.

## Supported Versions

| Version | Supported |
|---|---|
| `main` | Yes, planning baseline and active development |
| Tagged releases before `0.1.0` | No |

The first production-support target is `0.1.0` after the foundation scaffold is implemented.

## Reporting A Vulnerability

Use GitHub private vulnerability reporting from the repository Security tab whenever possible:

<https://github.com/ahliweb/awcms-mini/security/advisories/new>

Include:

- affected file, workflow, dependency, or documented control
- reproduction steps or proof of concept using synthetic data only
- impact and affected security property
- suggested fix, if known

Do not open public issues for exploitable vulnerabilities. Public issues are acceptable only for non-sensitive hardening work that does not reveal an exploit path.

## Baseline Security Controls

- Runtime and package manager: Bun.
- Backend platform: Bun-only; Node.js is not allowed unless a maintainer-approved, documented exception exists.
- Database target: PostgreSQL with RLS.
- Security automation: GitHub secret scanning, push protection, Dependabot alerts/security updates, and CodeQL code scanning.
- Repository policy: no real secrets, credentials, customer data, database dumps, or raw production logs in Git, issues, pull requests, or documentation.

## Response Process

1. Triage privately and confirm the affected scope.
2. Patch in the smallest safe scope.
3. Add or update tests, docs, and audit notes when the issue changes behavior or operating procedure.
4. Verify with available Bun commands and GitHub security checks.
5. Publish an advisory only after the fix is available or an agreed disclosure window is reached.
