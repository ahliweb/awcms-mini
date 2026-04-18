# Plugin Governance Contract Overview

## EmDash Core Vs Mini Overlay

### EmDash Core

EmDash owns the plugin host model and runtime extension surface.

### Mini Overlay

Mini adds governance-aware contract helpers so plugins can participate in the same permission, authorization, audit, and region-scoping model as first-party governance features.

## Contract Pieces

Mini currently provides:

- plugin permission registration helper
- plugin route authorization helper
- plugin service authorization helper
- plugin audit helper
- plugin region-awareness helper

## Design Goal

Plugins should consume shared governance services instead of bypassing them with ad hoc route logic or direct database policy assumptions.

## Sample Adoption

The internal governance sample plugin demonstrates the contract end to end:

- permission manifest
- protected route declaration
- service-level authorization
- scoped resource resolution
- plugin-tagged audit entry

## Cross-References

- `docs/plugins/permission-registration.md`
- `src/plugins/internal-governance-sample/index.mjs`
