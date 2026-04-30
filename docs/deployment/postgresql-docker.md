# PostgreSQL Docker Topology

Current deployment baseline:

- PostgreSQL runs as a private Docker service on the Coolify-managed host.
- backend connects through internal host networking (reviewed hostname pattern: `postgres`).
- no public PostgreSQL exposure is part of the active path.

See canonical runbooks:

- `docs/process/coolify-deployment.md`
- `docs/process/postgresql-vps-hardening.md`
