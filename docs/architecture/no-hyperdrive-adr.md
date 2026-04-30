# ADR: No Hyperdrive In Active Runtime

## Decision

AWCMS Mini does not use Cloudflare Hyperdrive in the active runtime path.

## Rationale

- PostgreSQL remains private behind backend access.
- The reviewed runtime boundary is Cloudflare-delivered frontend plus Hono backend.
- Direct edge-to-database coupling is out of scope for current Mini constraints.

## Consequences

- Frontend and edge-facing clients call backend APIs only.
- Database credentials remain backend/operator-only secrets.
- Docs and runbooks should avoid treating Hyperdrive as an active dependency.

## References

- `docs/architecture/constraints.md`
- `docs/process/coolify-deployment.md`
