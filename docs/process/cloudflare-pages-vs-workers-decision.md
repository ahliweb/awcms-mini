# Cloudflare Pages Vs Workers Decision

## Purpose

This document records the current architecture decision for how Cloudflare Pages and Workers relate to the maintained Hono backend baseline.

## Decision

For the current AWCMS Mini baseline, Cloudflare Pages may serve frontend traffic, but PostgreSQL must stay behind the Hono backend API.

Do not adopt a deployment shape where Cloudflare Workers, Pages Functions, or other edge runtime code connects to PostgreSQL directly.

Keep the reviewed baseline as frontend delivery through Cloudflare plus Hono on Coolify as the only backend surface that accesses PostgreSQL.

## Short Answer

Yes, Cloudflare Pages plus Workers or other edge components is technically possible.

Direct database access from those edge surfaces is not the recommended baseline for the current repository state.

## Current Repository Context

- AWCMS Mini is still one EmDash-first application.
- Public, auth, admin, Turnstile, and runtime configuration assumptions are still part of one reviewed application boundary.
- The current maintained runtime baseline is Cloudflare-delivered frontend traffic plus Hono on Coolify for backend API and PostgreSQL access.
- The current single-host baseline uses `/_emdash/` as the reviewed browser entry alias into the existing EmDash admin surface.

## Why A Split Is Technically Possible

- Cloudflare Pages supports custom domains, environment variables, and Pages Functions.
- Cloudflare Pages can serve public or app frontend traffic.
- Cloudflare Workers or Pages Functions can call backend APIs when needed.
- A public-facing static-first website could, in principle, live on Pages while authenticated governance behavior remains behind Hono.

## Why It Is Not The Recommended Baseline

### 1. PostgreSQL Must Stay Behind Hono

AWCMS Mini is not currently structured for safe direct database access from multiple runtime surfaces.

- The reviewed backend boundary is Hono.
- Service, auth, audit, and governance logic already concentrate there.
- Letting Workers or other edge runtimes connect to PostgreSQL would widen the trusted database-access surface without a matching requirement.

### 2. It Would Increase Auth And Session Complexity

Adding an edge runtime as another stateful backend surface would force a clearer boundary for:

- which hostname handles login
- how cookies are scoped across public and admin hosts
- where Turnstile is enforced and validated
- how redirects and origin checks behave across two deployment products

That raises complexity without a current product requirement that justifies it.

### 3. It Would Duplicate Sensitive Runtime Configuration

Direct database access from multiple runtime surfaces would require separate management for:

- database credentials or transport configuration across multiple execution surfaces
- posture validation across backend and edge layers
- release coordination and rollback handling across more than one database-capable runtime

The current Hono backend baseline keeps those seams more unified and easier to review.

### 4. It Would Complicate Smoke Tests And Rollback

The current runbooks assume one reviewed backend path for:

- public hostname checks
- admin entry alias checks
- Turnstile validation
- backend storage checks
- PostgreSQL reachability checks

Adding direct Worker or edge database access would require separate deployment health, rollback, and coordination procedures.

### 5. It Does Not Match The Current Primary Need

The current need is secure, reviewable frontend delivery with PostgreSQL protected behind Hono.

That need is already met by the current Pages plus Hono baseline without introducing another database-access surface.

## Route And Capability Mapping If Revisited Later

If this architecture is revisited later, these boundaries would need explicit review.

Potential Pages candidates:

- static-first marketing or public content pages
- public asset delivery that does not require app-authenticated governance logic

Backend-only candidates:

- EmDash admin surface under `/_emdash/admin`
- the reviewed admin entry alias at `/_emdash/`
- auth and session flows
- Turnstile-protected login and recovery flows
- `/api/v1/*` backend APIs
- governance-aware uploads and any route depending on backend storage credentials
- any route depending on the current app runtime and PostgreSQL-backed dynamic state

## Security Implications

- keep secrets and database credentials scoped to the backend surface that actually needs them
- avoid broad cookie sharing across Pages and Workers unless a reviewed workflow requires it
- keep Turnstile hostname and action validation explicit across any split deployment
- keep rollback-safe boundaries clear so partial deployment changes do not strand auth or admin traffic
- keep least-privilege boundaries between public content delivery and admin/runtime operations

## Decision Trigger For Reopening

Reopen this decision only if there is a concrete requirement for one of the following:

- independently deployable static-first public content
- materially different release cadence for public site versus admin/runtime
- measurable operational or performance gain that cannot be achieved within the current Hono backend baseline

Absent one of those drivers, the default remains Cloudflare frontend delivery with PostgreSQL access only through Hono.

## Validation

- docs review against the current repository state
- `pnpm lint`

## Cross-References

- `docs/process/coolify-deployment.md`
- `docs/process/secret-hygiene-coolify-cloudflare-topology-plan-2026.md`
- `docs/process/runtime-smoke-test.md`
- `README.md`
