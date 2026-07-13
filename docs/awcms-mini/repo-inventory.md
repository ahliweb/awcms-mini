# AWCMS-Mini Repository Inventory (generated)

> **GENERATED FILE — do not edit by hand.** Produced by `bun run repo:inventory:generate` (`scripts/repo-inventory-generate.ts`, Issue #688, epic #679) from the repository's own module registry, `sql/*.sql` migrations, `tests/`, and the bundled OpenAPI contract — never edit it directly. `bun run repo:inventory:check` (part of `bun run check`) fails the build if this file is stale relative to a fresh regeneration.

**Freshness.** This document has no embedded generation timestamp on purpose (a wall-clock stamp would make every regeneration diff even when nothing meaningful changed). It always describes the repository state **at the commit it is committed in** — check out any tag/commit and this file (or a fresh `bun run repo:inventory:generate`) describes that state, never a different one. GitHub issue/label/milestone state is tracked separately in [`docs/awcms-mini/github/`](github/README.md) (refreshed on demand via `bun run github:snapshot:refresh` — a live network call, deliberately kept out of `bun run check`, doc 20 §Batasan).

## Modules

17 modules registered in `src/modules/index.ts` `listModules()`.

| Key                    | Version | Status         | Type     | Dependencies                                               |
| ---------------------- | ------- | -------------- | -------- | ---------------------------------------------------------- |
| `blog_content`         | `0.9.0` | `active`       | `domain` | `tenant_admin`, `identity_access`                          |
| `domain_event_runtime` | `0.1.0` | `active`       | `system` | `tenant_admin`, `identity_access`, `logging`               |
| `email`                | `0.5.0` | `active`       | `-`      | `tenant_admin`, `profile_identity`, `identity_access`      |
| `form_drafts`          | `1.0.0` | `active`       | `-`      | `identity_access`                                          |
| `identity_access`      | `1.0.0` | `active`       | `-`      | `tenant_admin`, `profile_identity`                         |
| `idn_admin_regions`    | `0.1.0` | `experimental` | `base`   | `identity_access`, `logging`, `module_management`          |
| `logging`              | `1.0.0` | `active`       | `-`      | `tenant_admin`                                             |
| `module_management`    | `0.1.0` | `active`       | `system` | `tenant_admin`, `identity_access`                          |
| `news_portal`          | `0.4.0` | `active`       | `domain` | `tenant_admin`, `identity_access`                          |
| `profile_identity`     | `1.0.0` | `active`       | `-`      | `tenant_admin`                                             |
| `reporting`            | `1.1.0` | `active`       | `-`      | `tenant_admin`, `identity_access`, `sync_storage`, `email` |
| `social_publishing`    | `0.1.0` | `active`       | `domain` | `tenant_admin`, `identity_access`                          |
| `sync_storage`         | `1.0.0` | `active`       | `-`      | `tenant_admin`                                             |
| `tenant_admin`         | `1.0.0` | `active`       | `-`      | -                                                          |
| `tenant_domain`        | `0.1.0` | `active`       | `system` | `tenant_admin`, `identity_access`                          |
| `visitor_analytics`    | `0.1.0` | `active`       | `system` | `tenant_admin`, `identity_access`, `logging`, `reporting`  |
| `workflow`             | `1.0.0` | `active`       | `-`      | `tenant_admin`, `identity_access`                          |

## Migrations

56 migration files in `sql/` (`001_awcms_mini_foundation_schema.sql` .. `056_awcms_mini_domain_event_runtime_schema.sql`). Reserved base migration namespace (Issue #740, ADR-0014): `1-899` — a derived repository's own migrations start numbering at `900` or above.

| #   | File                                                              |
| --- | ----------------------------------------------------------------- |
| 001 | `001_awcms_mini_foundation_schema.sql`                            |
| 002 | `002_awcms_mini_tenant_office_schema.sql`                         |
| 003 | `003_awcms_mini_central_profile_management_schema.sql`            |
| 004 | `004_awcms_mini_identity_login_schema.sql`                        |
| 005 | `005_awcms_mini_abac_access_control_schema.sql`                   |
| 006 | `006_awcms_mini_setup_wizard_schema.sql`                          |
| 007 | `007_awcms_mini_sync_storage_outbox_inbox_schema.sql`             |
| 008 | `008_awcms_mini_sync_storage_conflict_schema.sql`                 |
| 009 | `009_awcms_mini_object_sync_queue_schema.sql`                     |
| 010 | `010_awcms_mini_management_reporting_permission_schema.sql`       |
| 011 | `011_awcms_mini_audit_logging_schema.sql`                         |
| 012 | `012_awcms_mini_workflow_approval_schema.sql`                     |
| 013 | `013_awcms_mini_enforce_rls_least_privilege.sql`                  |
| 014 | `014_awcms_mini_sync_node_management_permission_schema.sql`       |
| 015 | `015_awcms_mini_tenant_settings_management_permission_schema.sql` |
| 016 | `016_awcms_mini_tenant_default_locale_english_schema.sql`         |
| 017 | `017_awcms_mini_sync_queue_conflict_performance_indexes.sql`      |
| 018 | `018_awcms_mini_object_sync_queue_dispatcher_schema.sql`          |
| 019 | `019_awcms_mini_form_drafts_schema.sql`                           |
| 020 | `020_awcms_mini_email_schema.sql`                                 |
| 021 | `021_awcms_mini_email_template_i18n_schema.sql`                   |
| 022 | `022_awcms_mini_password_reset_schema.sql`                        |
| 023 | `023_awcms_mini_email_announcement_permission_schema.sql`         |
| 024 | `024_awcms_mini_email_message_cancel_permission_schema.sql`       |
| 025 | `025_awcms_mini_module_management_schema.sql`                     |
| 026 | `026_awcms_mini_blog_content_schema.sql`                          |
| 027 | `027_awcms_mini_blog_content_permissions.sql`                     |
| 028 | `028_awcms_mini_blog_content_search_vector.sql`                   |
| 029 | `029_awcms_mini_blog_content_presentation_schema.sql`             |
| 030 | `030_awcms_mini_blog_content_presentation_permissions.sql`        |
| 031 | `031_awcms_mini_tenant_domain_schema.sql`                         |
| 032 | `032_awcms_mini_tenant_domain_permissions.sql`                    |
| 033 | `033_awcms_mini_tenant_domain_lookup_function.sql`                |
| 034 | `034_awcms_mini_mfa_totp_schema.sql`                              |
| 035 | `035_awcms_mini_google_oidc_schema.sql`                           |
| 036 | `036_awcms_mini_tenant_oidc_sso_schema.sql`                       |
| 037 | `037_awcms_mini_tenant_oidc_sso_permissions.sql`                  |
| 038 | `038_awcms_mini_visitor_analytics_permissions.sql`                |
| 039 | `039_awcms_mini_visitor_analytics_schema.sql`                     |
| 040 | `040_awcms_mini_visitor_analytics_session_lookup_index.sql`       |
| 041 | `041_awcms_mini_news_media_object_registry_schema.sql`            |
| 042 | `042_awcms_mini_news_media_permissions.sql`                       |
| 043 | `043_awcms_mini_news_portal_tenant_state_schema.sql`              |
| 044 | `044_awcms_mini_news_portal_homepage_sections_schema.sql`         |
| 045 | `045_awcms_mini_db_role_separation.sql`                           |
| 046 | `046_awcms_mini_news_media_orphan_lifecycle.sql`                  |
| 047 | `047_awcms_mini_observability_metrics_permission.sql`             |
| 048 | `048_awcms_mini_idn_admin_regions_permissions.sql`                |
| 049 | `049_awcms_mini_news_portal_ad_placements_schema.sql`             |
| 050 | `050_awcms_mini_blog_posts_seo_image.sql`                         |
| 051 | `051_awcms_mini_blog_content_internal_tag_links_schema.sql`       |
| 052 | `052_awcms_mini_blog_content_internal_tag_links_permissions.sql`  |
| 053 | `053_awcms_mini_social_publishing_schema.sql`                     |
| 054 | `054_awcms_mini_idn_admin_regions_schema.sql`                     |
| 055 | `055_awcms_mini_social_publishing_verify_permission.sql`          |
| 056 | `056_awcms_mini_domain_event_runtime_schema.sql`                  |

## Tables & Row-Level Security

92 tables created across all migrations; 82 carry a `tenant_id` column; 81 have an `ENABLE ROW LEVEL SECURITY` statement; 11 are on the reviewed RLS-exempt allow-list.

No gap found: every tenant-scoped table has an `ENABLE ROW LEVEL SECURITY` statement, or is on the reviewed exempt allow-list below.

**Reviewed RLS-exempt allow-list** (see also doc 16 §Registry global, RLS-free):

| Table                             | Reason                                                                                                                                                                                        |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `awcms_mini_schema_migrations`    | Migration ledger — infra bookkeeping, not tenant data.                                                                                                                                        |
| `awcms_mini_tenants`              | The tenant registry itself — root table other tables' tenant_id references; endpoints scope with an explicit WHERE id = <tenantId> instead (doc note: CHANGELOG 0.23.5 §Settings management). |
| `awcms_mini_setup_state`          | Singleton (id boolean PRIMARY KEY) setup-wizard state — one row for the whole deployment, not per-tenant data, despite an optional tenant_id FK kept for provenance.                          |
| `awcms_mini_permissions`          | Permission catalog — global, RLS-free (doc 16 §Registry global, RLS-free).                                                                                                                    |
| `awcms_mini_modules`              | Module registry — global catalog synced from listModules(), same for every tenant (doc 16 §Registry global, RLS-free).                                                                        |
| `awcms_mini_module_dependencies`  | Module registry — global catalog (doc 16 §Registry global, RLS-free).                                                                                                                         |
| `awcms_mini_module_navigation`    | Module registry — global catalog (doc 16 §Registry global, RLS-free).                                                                                                                         |
| `awcms_mini_module_jobs`          | Module registry — global catalog (doc 16 §Registry global, RLS-free).                                                                                                                         |
| `awcms_mini_module_health_checks` | Module registry — global catalog (doc 16 §Registry global, RLS-free).                                                                                                                         |
| `awcms_mini_idn_region_datasets`  | Indonesia administrative region dataset metadata (cahyadsn/wilayah) — global reference data, identical for every tenant (doc 04 §Master Data — Indonesia Administrative Regions, Issue #657). |
| `awcms_mini_idn_admin_regions`    | Indonesia administrative region records (cahyadsn/wilayah) — global reference data, identical for every tenant (doc 04 §Master Data — Indonesia Administrative Regions, Issue #657).          |

## Tests

262 test files under `tests/` (`*.test.ts`, `*.test.mjs`, `*.e2e.ts`).

| Directory     | Test files |
| ------------- | ---------- |
| `(root)`      | 46         |
| `e2e`         | 9          |
| `integration` | 79         |
| `modules`     | 5          |
| `unit`        | 123        |

## Routes / Operations (summary)

156 OpenAPI paths, 207 operations, contract `info.version` `1.0.0` — sourced from the bundled contract (`bun run openapi:bundle`). Route<->contract parity itself is already enforced by `bun run api:spec:check`'s route-parity check (Issue #685/#695); this is a read-only summary, not a separate enforcement.

## GitHub issue/label/milestone snapshot

Tracked separately at [`docs/awcms-mini/github/`](github/README.md) — refreshed on demand via `bun run github:snapshot:refresh` (live `gh` API calls, not part of `bun run check`; see that script's own header comment for why). Regenerate it before every release/audit, not on a fixed schedule.
