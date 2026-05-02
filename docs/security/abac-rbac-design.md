# ABAC/RBAC Design

Authorization model:

- RBAC permission catalog and role grants in PostgreSQL
- ABAC service evaluation at route/service boundaries
- denial events logged for auditability

Core components:

- `src/services/authorization/`
- `server/middleware/abac.mjs`
- `src/plugins/*authorization*.mjs`
