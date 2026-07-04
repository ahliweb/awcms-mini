# AWCMS Mini Requirements

AWCMS Mini follows the adapted AWPOS planning package in `docs/awcms-mini/` and is the base standard for future applications.

## Core Requirements

- Runtime is Bun.
- Web framework is Astro 7.
- Database is PostgreSQL.
- Architecture is modular monolith, microservice-ready.
- API contract is OpenAPI.
- Event contract is AsyncAPI.
- Database changes use ordered SQL migrations.
- High-risk mutations require idempotency.
- High-risk actions require audit logging.
- Sensitive data must be masked or redacted before response, log, audit, and event payloads.
- External providers must not run inside critical database transactions.

## Initial Foundation

The foundation includes:

- module registry and module descriptor contract
- standard API response helper
- domain event envelope helper
- health endpoint
- baseline SQL migration
- spec check script
- tests for foundation contracts

## Source Documents

- `docs/awcms-mini/02_prd_detail_per_modul.md`
- `docs/awcms-mini/03_srs_detail_per_modul.md`
- `docs/awcms-mini/04_erd_data_dictionary.md`
- `docs/awcms-mini/05_openapi_asyncapi_detail.md`
- `docs/awcms-mini/10_template_kode_coding_standard.md`
- `docs/awcms-mini/11_implementation_blueprint.md`
- `docs/awcms-mini/16_backend_data_access_integration.md`
- `docs/awcms-mini/17_default_seed_rbac_abac.md`
- `docs/awcms-mini/18_configuration_env_reference.md`
