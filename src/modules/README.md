# Modules

AWCMS Mini follows the modular monolith structure defined in `docs/awcms-mini/10_template_kode_coding_standard.md` and `docs/awcms-mini/11_implementation_blueprint.md`.

Current foundation descriptors are registered in `src/modules/index.ts`.

Target module folders:

- `_shared`
- `tenant-admin`
- `identity-access`
- `profile-identity`
- `catalog-inventory`
- `sales-pos`
- `shared-stock-routing`
- `warehouse-management`
- `accounting-tax`
- `crm-communication`
- `sync-storage`
- `ai-analyst`
- `localization-ui`
- `observability-logging`
- `database-connectivity`
- `workflow-approval`
- `management-reporting`
- `ui-experience`
- `production-security-readiness`

Each implementation module should use:

```text
module.ts
domain/
application/
infrastructure/
api/
README.md
```
