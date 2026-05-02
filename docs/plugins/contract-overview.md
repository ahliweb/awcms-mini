# Plugin Governance Contract Overview

## EmDash Core Vs Mini Overlay

### EmDash Core

EmDash owns the plugin host model and runtime extension surface.

### Mini Overlay

Mini adds governance-aware contract helpers so plugins can participate in the same permission, authorization, audit, and region-scoping model as first-party governance features.

## Contract Pieces

Mini currently provides:

- EmDash plugin definitions created with `definePlugin(...)`
- first-party plugin descriptors that register `id`, `entrypoint`, `format`, `capabilities`, and permissions with the host
- plugin permission registration helper
- plugin route authorization helper
- plugin service authorization helper
- plugin audit helper
- plugin region-awareness helper

## Supported Boundaries

Mini keeps setup, runtime bootstrap, database ledgers, and route authorization aligned with EmDash by using supported seams first.

- add behavior through `definePlugin(...)`, adapters, or shared helpers when EmDash exposes a plugin or service seam
- keep host-routing, runtime-init, and setup-bootstrap overrides out of Mini-local forks unless a compatibility issue explicitly tracks them
- treat patch drift as a release concern and verify it before changing the EmDash compatibility baseline

## Current Terminology

- A plugin definition is the runtime object returned from `definePlugin(...)`.
- A plugin descriptor is the registration object Mini exposes for EmDash to discover and load a plugin entrypoint, capability list, and permission catalog.
- Plugin routes are the handler entries declared inside the plugin definition.
- First-party admin experience currently ships through the `awcms-users-admin` plugin rather than a separate admin shell.

## Design Goal

Plugins should consume shared governance services instead of bypassing them with ad hoc route logic or direct database policy assumptions.

## Sample Adoption

The internal governance sample plugin demonstrates the contract end to end:

- runtime definition and registration descriptor
- capabilities and permission catalog
- protected route declaration
- service-level authorization
- scoped resource resolution
- plugin-tagged audit entry

The `awcms-users-admin` plugin demonstrates the same model for first-party governance and admin routes.

## Cross-References

- `docs/admin/operations-guide.md`
- `docs/plugins/permission-registration.md`
- `src/plugins/awcms-users-admin/index.mjs`
- `src/plugins/internal-governance-sample/index.mjs`
