---
"awcms-mini": minor
---

Add the tenant domain/subdomain mapping schema (Issue #557, epic #555):
`awcms_mini_tenant_domains` (`sql/031_awcms_mini_tenant_domain_schema.sql`)
maps a public hostname to a tenant, with a separate `normalized_hostname`
column (lowercase/trimmed, kept in sync by a CHECK constraint) that is
globally unique among non-deleted rows, a partial unique index enforcing
at most one active primary domain per tenant, `domain_type`
(`subdomain`/`custom_domain`) and `route_mode` (`canonical`/`legacy_blog`)
extension points for the future resolver (#559) and `/news` routes
(#560), `verification_method`/`verification_token_hash` (hashed, never
the raw token)/`verification_record_name`/`verification_record_value` for
DNS ownership verification (no provider credential ever stored here),
soft delete, and `ENABLE`+`FORCE` row-level security with the standard
`tenant_isolation` policy. `sql/032_awcms_mini_tenant_domain_permissions.sql`
seeds six new `tenant_domain.domains.*` permissions
(`read`/`create`/`update`/`delete`/`verify`/`set_primary`). Schema only —
no module descriptor, resolver, API, or admin UI in this issue (those are
#558/#559/#562/#563). Covered by
`tests/integration/tenant-domain-schema.integration.test.ts`.
