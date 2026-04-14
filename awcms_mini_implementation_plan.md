# AWCMS Mini Implementation Plan

## 1. Executive Summary

AWCMS Mini is a single-tenant CMS foundation built on EmDash as the canonical host architecture. It should inherit EmDash's core shape: Astro-native integration, database-backed content model, admin UI, auth boundary, Kysely-based data access, and plugin extension model. It should not become a partial fork of AWCMS and it should not introduce a competing application core.

EmDash is the foundation because it already provides the structural CMS primitives that AWCMS Mini needs: content collections, admin workflows, media handling, settings, menus, taxonomies, widgets, sections, auth, API surfaces, and plugin hooks/routes. EmDash also already uses portable architectural boundaries around storage and database access, with Kysely as the canonical SQL abstraction. That makes it the correct host for a PostgreSQL-backed implementation without needing to redesign the platform.

Selected AWCMS concepts should be used only as governance overlays. That means Mini may add policy, hierarchy, assignment, and security-control layers around EmDash's existing architecture, but it must not import AWCMS's multi-tenant structure, Supabase-centered data plane, tenant isolation model, or RLS-centric enforcement approach. In Mini, AWCMS contributes governance semantics, not platform ownership.

Multi-tenant AWCMS features are excluded because they directly increase architectural complexity, schema scope, operational burden, and authorization surface area. Mini is intentionally a smaller system: one site, one tenant, one operational domain. That keeps user management, permissions, regions, jobs, and plugin integration implementable without tenant scoping across every table and service.

The visual editor is excluded from v1 even though EmDash already has visual editing capabilities. For Mini v1, the plan should treat schema/content/admin governance as the priority and postpone visual editing because it expands UX scope, policy edge cases, publish-state handling, and testing complexity. The base content editor and admin screens are sufficient for the first production-oriented governance release.

PostgreSQL plus Kysely is the correct data foundation because it preserves SQL transparency, transactional integrity, migration discipline, and portability with EmDash's architecture. PostgreSQL gives durable relational features for hierarchy, audit, and policy-support data. Kysely keeps the implementation explicit, typed, and aligned with EmDash's existing runtime patterns.

## 2. Scope and Boundaries

### In Scope

- EmDash core as the host CMS framework.
- PostgreSQL as the single system-of-record database.
- Kysely for schema migrations, query composition, and transaction control.
- EmDash-compatible internal plugin architecture.
- EmDash content collections, media, settings, menus, taxonomies, widgets, and sections where needed.
- EmDash auth foundation extended for Mini governance requirements.
- User lifecycle management for a single tenant.
- RBAC baseline with AWCMS-style permission naming and management.
- ABAC refinement layer implemented in the backend service layer.
- A 10-level staff hierarchy attached to roles as metadata and evaluation context.
- Separate job hierarchy with job levels, job titles, user job assignments, supervisors, and history.
- Dual-region governance overlay: logical/detail regions plus Indonesian administrative regions.
- Permission matrix management and auditability.
- TOTP-based 2FA and recovery controls.
- Security events, audit logs, login history, lockouts, and step-up authentication.
- Admin screens implemented as careful EmDash admin extensions.
- Plugin registration and enforcement patterns for governance-aware internal plugins.

### Out of Scope

- Multi-tenant logic of any kind.
- `tenant_id` scoping, tenant-level catalogs, or tenant inheritance trees.
- Supabase Auth, Supabase database APIs, and Supabase migration workflow.
- Visual editor support in v1.
- Porting arbitrary AWCMS modules or resources into Mini.
- Building a separate admin shell outside EmDash.
- Marketplace-grade untrusted plugin sandboxing as a Mini-specific project goal.
- ERP-style domain expansion such as procurement, inventory, finance, or full HRIS.
- Universal PostgreSQL RLS as the primary authorization system.
- Conflating job hierarchy with role hierarchy.
- Collapsing logical/detail regions into administrative regions.

## 3. Architectural Principles

- EmDash-first: EmDash owns the CMS structure, extension model, and admin baseline.
- Single-tenant simplicity: all governance design assumes one installation serving one organizational tenant.
- Overlay, not fork: AWCMS concepts are additive governance layers only.
- Kysely-first data access: migrations, queries, and transactions remain explicit in application code.
- Backend-enforced authorization: policy decisions happen in services and route guards, not only in UI.
- Plugin compatibility over platform sprawl: new features prefer hooks, services, and admin extensions over new cores.
- Minimal upstream conflict: choose shapes that can live next to upstream EmDash rather than replace it.
- Fixed scope before dynamic expansion: secure users, permissions, jobs, regions, and audit before optional features.
- Data model clarity: separate identity, authorization, governance, content, and audit concerns.
- Additive rollout safety: schema and enforcement changes should land incrementally with reversibility.
- Retention-aware deletes: mutable entities should prefer soft delete; append-only and effective-dated records should not.

## 4. Soft Delete Strategy

Mini should use a selective soft delete model rather than universal hard delete or universal soft delete.

Use soft delete for:

- mutable identity records such as users,
- mutable profile/catalog records where audit context should be preserved,
- future governance entities such as non-system roles, job catalogs, and region catalogs when removal should remain reversible.

Do not use soft delete for:

- append-only security and audit records,
- sessions and token history,
- recovery codes and password reset tokens,
- relationship/history tables that already use `expires_at`, `ends_at`, or equivalent effective dating.

Implementation rules:

- the canonical soft delete marker is `deleted_at`,
- when operator attribution matters, add `deleted_by_user_id` and `delete_reason`,
- repositories should exclude soft-deleted rows by default,
- services should expose explicit soft delete and restore flows,
- normal application behavior should avoid hard delete.

## 5. Allowed vs Forbidden Design Rules

| Rule Area | Allowed | Forbidden | Rationale |
| --- | --- | --- | --- |
| Modules | Use EmDash core modules and small EmDash-compatible governance modules | Port AWCMS modules wholesale | Prevents a parallel framework from appearing inside Mini |
| Resources | Add support tables for governance data | Recreate AWCMS resource catalogs unrelated to EmDash | Mini needs support data, not a second product model |
| Auth | Extend EmDash auth flows with stronger policy and 2FA | Replace EmDash auth with Supabase-style auth architecture | Keeps one coherent auth boundary |
| Permissions | RBAC baseline plus ABAC refinement in services | ABAC-only UI with no explicit permission catalog | Operators need clarity and auditable permission assignment |
| Plugins | Internal plugins using EmDash hooks, routes, settings, and service guards | Plugin APIs that bypass governance services or write DB state arbitrarily | Governance must remain enforceable |
| Admin Screens | Extend EmDash admin navigation and pages | Build a second standalone admin app | Avoids split UX and duplicated enforcement |
| Region Handling | Maintain separate logical and administrative hierarchies | Collapse both hierarchies into a single table or semantics layer | They solve different governance problems |
| Schema Design | PostgreSQL tables modeled around EmDash data plus governance overlays, with selective soft delete for mutable entities | Multi-tenant columns, platform catalogs, or universal soft-delete for append-only/history tables | Keep schema lean and single-tenant |
| Transaction Logic | Use Kysely transactions for multi-step writes and sensitive state changes | Ad hoc partial writes across users, roles, jobs, regions, and sessions | Prevents inconsistent policy state |
| Reporting | Read from audit and support tables through explicit queries/views | Add warehouse-grade analytics subsystems in v1 | Reporting should remain operational, not enterprise BI |
| Job Hierarchy | Separate job levels/titles/assignments from roles | Use job titles as permission grants | Prevents organizational metadata from becoming hidden auth truth |
| Role Hierarchy | Use explicit role levels and protected role rules | Infer authority from job seniority or region placement alone | Keeps authorization predictable |

## 6. Foundation Architecture Map

### Host Layer

EmDash core is the host layer. This includes:

- Astro integration and runtime bootstrapping.
- EmDash content collections and admin shell.
- EmDash media, settings, taxonomy, menu, widget, and section support.
- EmDash auth/session boundary.
- EmDash route and plugin infrastructure.

### Database Layer

PostgreSQL plus Kysely provides:

- all application tables,
- all migrations,
- all typed query access,
- all transaction boundaries,
- future-compatible views/materialized views for reporting,
- durable relational support for hierarchy and audit concerns.

### Governance Layer

AWCMS-derived overlays should live here:

- ABAC evaluation engine,
- role hierarchy metadata,
- job hierarchy,
- logical/detail regions,
- administrative regions,
- security and audit enforcement.

This layer must depend on EmDash primitives rather than replace them.

### Extension Layer

Internal plugins should use EmDash-compatible extension points:

- plugin permission registration,
- plugin settings,
- plugin admin pages,
- plugin routes,
- plugin hooks,
- plugin-aware authorization helpers.

### Admin Layer

The admin layer should be the EmDash admin extended carefully with governance screens for users, roles, permissions, jobs, regions, security, and audit.

### Public Layer

The public layer should continue to follow EmDash's content rendering model. Governance overlays may affect who can manage or publish content, but should not redefine the public rendering architecture.

## 7. Module and Capability Inventory

| Capability | Type | Mandatory v1 | Governance Overlay | Implementation Boundaries |
| --- | --- | --- | --- | --- |
| Users | EmDash core extended | Yes | Partial | Keep EmDash identity base, add governance profile and assignment support |
| Auth | EmDash core extended | Yes | Partial | Retain EmDash auth flow, add 2FA, step-up, session controls |
| Roles | Extension over EmDash role model | Yes | Yes | Replace flat role assumptions with catalog plus `staff_level` metadata |
| Permissions | Extension | Yes | Yes | Explicit permission catalog and role mapping; no hidden grants |
| ABAC engine | Extension | Yes | Yes | Service-layer evaluation on top of RBAC, not a DB-first engine |
| Pages / Posts / Collections | EmDash core | Yes | No | Use EmDash collection architecture only |
| Media | EmDash core | Yes | No | Governance may restrict actions; media model remains EmDash |
| Settings | EmDash core extended | Yes | Partial | Add security/governance settings through supported extension paths |
| Menus / Taxonomies / Widgets / Sections | EmDash core | Optional | No | Only include if needed by chosen site template |
| Plugins | EmDash core | Yes | Partial | Add governance-aware registration and checks; keep plugin model intact |
| Audit Logs | Extension or internal plugin | Yes | Yes | Central append-only operational trail |
| Region Governance | Extension | Yes | Yes | Two separate hierarchies, both supporting ABAC context |
| Job Hierarchy | Extension | Yes | Yes | Separate organizational structure with history |
| Security Events | Extension | Yes | Yes | Auth, 2FA, lockouts, resets, privileged changes |
| Permission Matrix | Extension | Yes | Yes | Admin management surface over permission catalog |

## 8. Data Model Planning

The data model should be split into core identity/auth, authorization, governance, and supporting controls. EmDash-native tables should remain authoritative for content and core CMS data. Mini-specific tables should be additive.

### 8.1 Core Identity and Auth Tables

#### `users`

- Purpose: canonical user identity account.
- Key columns: `id`, `email`, `username`, `display_name`, `password_hash`, `status`, `last_login_at`, `must_reset_password`, `is_protected`, `deleted_at`, `deleted_by_user_id`, `delete_reason`, `created_at`, `updated_at`.
- Relationships: one-to-many to sessions, login events, user roles, user jobs, region assignments, 2FA credentials, audit events.
- Constraints: unique `email`; allowed `status` enum such as `invited`, `active`, `disabled`, `locked`, `deleted`.
- Indexes: unique on `email`; index on `status`; index on `last_login_at`.
- Soft delete: yes; use `deleted_at` with optional `deleted_by_user_id` and `delete_reason`. Soft-deleted identities should be excluded from normal reads by default.
- Classification: EmDash-native support table if upstream-compatible, otherwise Mini overlay extension.

#### `user_profiles`

- Purpose: non-auth profile attributes for admin and self-service.
- Key columns: `user_id`, `phone`, `avatar_media_id`, `timezone`, `locale`, `notes`, `deleted_at`, `created_at`, `updated_at`.
- Relationships: one-to-one with users.
- Constraints: foreign key to users; if hard delete exists for maintenance-only paths, `ON DELETE CASCADE` is acceptable.
- Indexes: primary key on `user_id`.
- Soft delete: yes; use `deleted_at` to mirror the user lifecycle without physically removing profile data during normal operations.
- Classification: governance support overlay.

#### `sessions`

- Purpose: active and historical authenticated session tracking.
- Key columns: `id`, `user_id`, `session_token_hash`, `ip_address`, `user_agent`, `trusted_device`, `last_seen_at`, `expires_at`, `revoked_at`, `created_at`.
- Relationships: many-to-one to users.
- Constraints: token stored only as hash; revoked sessions retained.
- Indexes: unique on `session_token_hash`; indexes on `user_id`, `expires_at`, `revoked_at`.
- Soft delete: no; sessions are retained history and should use `revoked_at` plus expiry rather than logical deletion.
- Classification: EmDash auth support extended.

#### `login_security_events`

- Purpose: login attempts and auth event trace.
- Key columns: `id`, `user_id`, `email_attempted`, `event_type`, `outcome`, `reason`, `ip_address`, `user_agent`, `occurred_at`.
- Relationships: optional many-to-one to users.
- Constraints: immutable append-only rows.
- Indexes: `user_id, occurred_at desc`; `email_attempted`; `event_type, occurred_at desc`.
- Soft delete: no; the table is append-only.
- Classification: governance security overlay.

#### `totp_credentials`

- Purpose: active 2FA TOTP enrollment records.
- Key columns: `id`, `user_id`, `secret_encrypted`, `issuer`, `label`, `verified_at`, `last_used_at`, `created_at`, `disabled_at`.
- Relationships: many-to-one to users, but v1 should enforce one active record per user.
- Constraints: partial unique index for one active credential per user.
- Indexes: `user_id`; partial unique on `user_id where disabled_at is null`.
- Soft delete: no; disable timestamp is enough.
- Classification: governance security overlay.

#### `recovery_codes`

- Purpose: hashed one-time 2FA recovery codes.
- Key columns: `id`, `user_id`, `code_hash`, `used_at`, `created_at`, `replaced_at`.
- Relationships: many-to-one to users.
- Constraints: codes stored hashed only.
- Indexes: `user_id`, partial on unused codes.
- Soft delete: no.
- Classification: governance security overlay.

#### `password_reset_tokens`

- Purpose: password reset and forced-reset flow support.
- Key columns: `id`, `user_id`, `token_hash`, `expires_at`, `used_at`, `created_at`, `issued_by_user_id`.
- Relationships: many-to-one to users; optional issuer link for admin-forced reset.
- Constraints: hash tokens only.
- Indexes: `user_id`, `expires_at`.
- Soft delete: no.
- Classification: governance security overlay.

### 8.2 Authorization Tables

#### `roles`

- Purpose: role catalog and authority metadata.
- Key columns: `id`, `slug`, `name`, `description`, `staff_level`, `is_system`, `is_assignable`, `is_protected`, `created_at`, `updated_at`.
- Relationships: one-to-many to user_roles and role_permissions.
- Constraints: unique `slug`; `staff_level` constrained to 1-10 or mapped authority scale.
- Indexes: unique `slug`; index on `staff_level`.
- Soft delete: yes for non-system roles; prefer `deleted_at` and default filtering over physical removal.
- Classification: governance overlay.

#### `permissions`

- Purpose: permission catalog.
- Key columns: `id`, `code`, `domain`, `resource`, `action`, `description`, `is_protected`, `created_at`.
- Relationships: one-to-many to role_permissions.
- Constraints: unique `code`; `code` format `scope.resource.action`.
- Indexes: unique `code`; index on `domain`.
- Soft delete: no; permission codes are a stable catalog and should not disappear from historical mappings.
- Classification: governance overlay.

#### `role_permissions`

- Purpose: mapping of roles to permissions.
- Key columns: `role_id`, `permission_id`, `granted_by_user_id`, `granted_at`.
- Relationships: many-to-one to roles and permissions.
- Constraints: composite primary key `(role_id, permission_id)`.
- Indexes: `permission_id`; `role_id` primary coverage.
- Soft delete: no.
- Classification: governance overlay.

#### `user_roles`

- Purpose: role assignment to users.
- Key columns: `user_id`, `role_id`, `assigned_by_user_id`, `assigned_at`, `expires_at`.
- Relationships: many-to-one to users and roles.
- Constraints: in v1 prefer one primary role per user plus optional future support for multiple roles. If only one role is allowed initially, store `is_primary` and enforce one active primary role.
- Indexes: `user_id`, `role_id`, partial on active assignments.
- Soft delete: no; use `expires_at` for history.
- Classification: governance overlay.

#### `authorization_policy_cache`

- Purpose: optional derived cache for effective permissions and ABAC context versioning.
- Key columns: `user_id`, `policy_hash`, `effective_permissions_json`, `context_version`, `computed_at`, `expires_at`.
- Relationships: one-to-one or one-to-many by version with users.
- Constraints: cache only, safe to rebuild.
- Indexes: `user_id`; `expires_at`.
- Soft delete: no.
- Classification: governance overlay support.

### 8.3 Governance Tables

#### `job_levels`

- Purpose: organizational seniority ladder.
- Key columns: `id`, `code`, `name`, `rank_order`, `description`, `is_system`, `created_at`, `updated_at`.
- Relationships: one-to-many to job_titles and user_jobs.
- Constraints: unique `code`; unique `rank_order`.
- Indexes: unique `code`; unique `rank_order`.
- Soft delete: soft delete or deactivate is acceptable, but the preferred default is `deleted_at` for operator-managed catalogs that should remain reversible.
- Classification: governance overlay.

#### `job_titles`

- Purpose: concrete titles associated with job levels.
- Key columns: `id`, `job_level_id`, `code`, `name`, `description`, `is_active`, `created_at`, `updated_at`.
- Relationships: many-to-one to job_levels; one-to-many to user_jobs.
- Constraints: unique `code`.
- Indexes: `job_level_id`; unique `code`.
- Soft delete: yes; use `deleted_at` if titles should be retired without losing historical references.
- Classification: governance overlay.

#### `user_jobs`

- Purpose: user organizational assignment history.
- Key columns: `id`, `user_id`, `job_level_id`, `job_title_id`, `supervisor_user_id`, `employment_status`, `starts_at`, `ends_at`, `is_primary`, `assigned_by_user_id`, `notes`, `created_at`.
- Relationships: many-to-one to users, job_levels, job_titles, optional supervisor user.
- Constraints: one active primary job per user.
- Indexes: `user_id`, `job_level_id`, `job_title_id`, `supervisor_user_id`, partial active primary.
- Soft delete: no; history handled with dates.
- Classification: governance overlay.

#### `regions`

- Purpose: logical/detail operational region hierarchy.
- Key columns: `id`, `code`, `name`, `parent_id`, `level`, `path`, `sort_order`, `is_active`, `created_at`, `updated_at`.
- Relationships: self-referential tree; one-to-many to user_region_assignments.
- Constraints: unique `code`; max depth 10.
- Indexes: unique `code`; `parent_id`; `path`; `level`.
- Soft delete: yes for catalog rows; prefer `deleted_at` plus reassignment rules instead of hard delete.
- Classification: governance overlay.

#### `administrative_regions`

- Purpose: Indonesian legal administrative hierarchy.
- Key columns: `id`, `code`, `name`, `type`, `parent_id`, `path`, `province_code`, `regency_code`, `district_code`, `village_code`, `is_active`, `created_at`, `updated_at`.
- Relationships: self-referential tree; one-to-many to user_administrative_region_assignments.
- Constraints: `type` in `province`, `regency_city`, `district`, `village`; unique code per node.
- Indexes: `parent_id`; `path`; `type`; unique `code`.
- Soft delete: yes for catalog rows; preserve legal hierarchy history if records are retired or superseded.
- Classification: governance overlay.

#### `user_region_assignments`

- Purpose: assign users to logical regions.
- Key columns: `id`, `user_id`, `region_id`, `assignment_type`, `is_primary`, `starts_at`, `ends_at`, `assigned_by_user_id`, `created_at`.
- Relationships: many-to-one to users and regions.
- Constraints: one active primary logical region per user if required.
- Indexes: `user_id`, `region_id`, partial active assignments.
- Soft delete: no.
- Classification: governance overlay.

#### `user_administrative_region_assignments`

- Purpose: assign users to administrative regions.
- Key columns: `id`, `user_id`, `administrative_region_id`, `assignment_type`, `is_primary`, `starts_at`, `ends_at`, `assigned_by_user_id`, `created_at`.
- Relationships: many-to-one to users and administrative regions.
- Constraints: one active primary administrative region per user if required.
- Indexes: `user_id`, `administrative_region_id`, partial active assignments.
- Soft delete: no.
- Classification: governance overlay.

#### `approval_rules`

- Purpose: optional future workflow conditions for high-risk actions.
- Key columns: `id`, `action_code`, `min_staff_level`, `requires_step_up_auth`, `region_scope_type`, `created_at`, `updated_at`.
- Relationships: none initially.
- Constraints: unique `action_code`.
- Indexes: unique `action_code`.
- Soft delete: no.
- Classification: governance overlay, optional v1 if workflow gating is needed.

### 8.4 Supporting Controls

#### `audit_logs`

- Purpose: append-only record of sensitive and administrative actions.
- Key columns: `id`, `actor_user_id`, `action_code`, `entity_type`, `entity_id`, `summary`, `before_json`, `after_json`, `request_id`, `ip_address`, `user_agent`, `occurred_at`.
- Relationships: optional actor user.
- Constraints: immutable append-only.
- Indexes: `actor_user_id, occurred_at desc`; `entity_type, entity_id`; `action_code, occurred_at desc`.
- Soft delete: no; append-only.
- Classification: governance overlay.

#### `security_events`

- Purpose: specialized audit stream for auth and security posture changes.
- Key columns: `id`, `user_id`, `event_type`, `severity`, `details_json`, `ip_address`, `occurred_at`.
- Relationships: optional many-to-one to users.
- Constraints: immutable append-only.
- Indexes: `user_id`; `event_type, occurred_at desc`; `severity, occurred_at desc`.
- Soft delete: no; append-only.
- Classification: governance overlay.

#### `rate_limit_counters`

- Purpose: account or IP-based rate limiting support if not delegated to runtime middleware.
- Key columns: `scope_key`, `counter`, `window_starts_at`, `updated_at`.
- Relationships: none.
- Constraints: unique `scope_key`.
- Indexes: unique `scope_key`; `window_starts_at`.
- Soft delete: no.
- Classification: security support overlay.

## 8. Roles Hierarchy Planning

Mini should implement an AWCMS-style 10-level staff hierarchy while keeping roles as the explicit authorization source. `staff_level` should be stored as role metadata, not inferred from naming. Higher levels represent broader authority and stronger protected-action eligibility.

Recommended rule set:

- Levels 1-10 exist as a stable conceptual authority ladder.
- Each role maps to exactly one `staff_level`.
- Effective authority comparisons use `staff_level` only for cross-role safeguards and workflow constraints, not as a substitute for explicit permissions.
- Role level should influence who can assign, revoke, disable, reset, or modify lower-level users.
- Users must not be able to alter peers or superiors unless they hold a specific protected override permission.

Protected role rules:

- `owner` and `super_admin` style roles are protected.
- Protected roles cannot be deleted.
- Protected roles cannot lose mandatory baseline permissions without explicit break-glass flow.
- Assignment of protected roles requires step-up auth.
- Protected role changes require audit logs with before/after state.

Example default role catalog:

| Role | Staff Level | Purpose |
| --- | --- | --- |
| Owner | 10 | Emergency control, system bootstrap, protected recovery |
| Super Admin | 9 | Full site administration and governance control |
| Admin | 8 | User, role, settings, and content administration |
| Security Admin | 8 | 2FA, sessions, locks, audit, and security operations |
| Region Manager | 7 | Region-scoped administrative control |
| Editor | 6 | Editorial management and publishing |
| Auditor | 5 | Read-only governance, audit, and security review |
| Author | 4 | Authoring and self/assigned content management |
| Contributor | 3 | Draft contribution only |
| Member | 2 | Authenticated limited backoffice access |
| Viewer | 1 | Minimal internal read access |

Implementation notes:

- v1 should keep the default catalog small and opinionated.
- Custom roles may be allowed later, but v1 should first stabilize system roles.
- UI should display both role name and staff level for transparency.

## 9. User Jobs Hierarchy Planning

Jobs must remain separate from roles because roles answer "what may this user do" while jobs answer "where does this user sit in the organization." A Director may have a lower app role than an Admin. An Editor may have a senior job title but still lack security permissions. Mixing the two makes authorization opaque and error-prone.

Design:

- `job_levels` stores the abstract seniority ladder.
- `job_titles` stores named positions mapped to a level.
- `user_jobs` stores assignments, effective dates, optional supervisor, and history.
- A user may have historical jobs, but only one active primary job in v1.
- Supervisory relationships are advisory context for workflow and filtering, not direct permission grants.

Supervisor and reporting logic:

- `supervisor_user_id` links to another user's active identity.
- Prevent self-reference and circular chains through service validation.
- Precompute reporting paths only if needed; otherwise derive on query.

Effective-date support:

- all assignments should use `starts_at` and `ends_at`.
- current job = active row where current time falls within range and `is_primary = true`.

ABAC influence:

- job level may be used as a context attribute for approval thresholds or read visibility.
- job title may help route workflow ownership.
- job data must never directly bypass explicit permissions.

## 10. Dual Regions Planning

Mini should carry two fully separate region systems.

### Logical / Detail Regions

- Purpose: internal operational and organizational scoping.
- Depth: fixed support for up to 10 levels.
- Example: `National > Division > Area > Cluster > Branch > Unit`.
- Use cases: editorial ownership, manager scope, approval routing, operational filtering.

### Administrative Regions

- Purpose: real-world Indonesian legal/geographic hierarchy.
- Depth: `province > regency_city > district > village`.
- Use cases: compliance, public-service alignment, geo reporting, administrative authority mapping.

Recommended modeling:

- use adjacency list (`parent_id`) plus materialized path (`path`).
- `path` should encode the lineage for fast ancestor/descendant queries.
- maintain level/type columns explicitly.
- enforce separate services and separate assignment tables.

Inheritance rules:

- assignment to a parent may optionally imply visibility into descendants.
- write authority should not automatically inherit unless the permission definition says so.
- inheritance should be part of ABAC evaluation, not hidden SQL behavior.

User assignment model:

- a user may have one primary logical region and one primary administrative region.
- secondary assignments are allowed for matrix organizations.
- each assignment should carry start/end dates and assignment type.

Practical examples:

- A Region Manager may edit content only within their logical region subtree.
- A compliance user may view reports for a province and all child districts/villages.
- An editor may be assigned to a logical region for operational scope while their administrative region reflects legal coverage.

When to use which:

- use logical regions for business workflow and internal ownership.
- use administrative regions for legal/geo classification and statutory boundaries.
- never use administrative regions as a substitute for operational org design.

## 11. ABAC Planning

Mini should use hybrid RBAC plus ABAC.

### Permission Naming Convention

Use `scope.resource.action`, for example:

- `admin.users.read`
- `admin.users.update`
- `admin.roles.assign`
- `content.posts.publish`
- `security.sessions.revoke`

### RBAC Baseline

- Roles grant the baseline set of permissions.
- Every protected action begins with a permission existence check.
- No ABAC rule should grant an action the user does not hold permission for.

### ABAC Refinement

ABAC narrows or conditions the allowed action using:

- subject attributes: role, staff level, active job level, user status, 2FA status, protected status.
- resource attributes: owner user, region linkage, sensitivity flag, target role level, target region.
- context attributes: request type, session strength, time, IP reputation, step-up authentication freshness.

### Region-Based Constraints

- read/write rights may be limited to a logical region subtree or administrative region subtree.
- actions on users may require actor and target region compatibility.

### Role-Level Constraints

- actor staff level must exceed target staff level for some administrative actions.
- certain actions require minimum staff level regardless of permission.

### Job-Level Contextual Constraints

- high-risk workflows may require actor job level above a threshold.
- job context informs approvals and scope, but does not substitute for RBAC.

### Ownership Rules

- allow self-service actions on own profile, password, 2FA, and sessions.
- allow content authorship actions on owned content if the role grants own-scope permission.

### Sensitive Action Rules

- protected role changes,
- disabling users,
- resetting 2FA,
- revoking all sessions,
- editing permission mappings,
- changing security settings.

These should require step-up auth and audit logging.

### Evaluation Flow

1. Authenticate request and resolve session.
2. Load effective role assignments and baseline permissions.
3. Fail fast if required permission is missing.
4. Resolve ABAC context: user, job, region, resource, session, and security posture.
5. Evaluate explicit deny conditions first.
6. Evaluate scoped allow rules.
7. Produce allow or deny plus structured reason.
8. Log high-risk decisions where appropriate.

### Allow / Deny Reasoning Model

- Deny if unauthenticated.
- Deny if permission missing.
- Deny if actor targets equal-or-higher protected staff level without override.
- Deny if region scope mismatch.
- Deny if step-up auth required and not fresh.
- Allow only when all relevant conditions pass.

### Caching and Invalidation

- cache effective permission and hierarchy context per user/session.
- invalidate on role change, permission change, job assignment change, region assignment change, user status change, or 2FA state change.
- use short TTL plus event-driven busting where possible.

### Enforcement Strategy

- enforce in route handlers and service layer helpers.
- keep UI checks as convenience only.
- keep PostgreSQL RLS optional for later selective hardening, not as v1 core.

## 12. Permission Matrix Planning

The permission matrix should be the operator-facing management view over the permission catalog.

Structure:

- columns are roles.
- rows are permissions grouped by domain: users, roles, permissions, content, media, settings, jobs, logical regions, administrative regions, security, audit, plugins.
- protected permissions are visibly marked and require stronger confirmation.

Required behaviors:

- show inherited or effective permission states clearly.
- distinguish immutable system grants from editable grants.
- allow draft review before applying bulk changes.
- require step-up auth for protected permission changes.
- emit audit logs for every applied matrix update.

Safe update flow:

1. load matrix snapshot,
2. edit in a staged form,
3. validate protected permission constraints,
4. compute diff,
5. require confirmation and possibly step-up auth,
6. apply in one transaction,
7. invalidate auth caches,
8. write audit records.

Example permission groups:

- `admin.users.*`
- `admin.roles.*`
- `admin.permissions.*`
- `governance.jobs.*`
- `governance.regions.*`
- `security.2fa.*`
- `security.sessions.*`
- `audit.logs.read`
- `plugins.manage.*`

## 13. User Management Planning

User management should cover both admin-controlled lifecycle and self-service.

Admin operations:

- create user,
- invite user,
- activate user,
- disable user,
- lock/unlock user,
- assign role,
- assign job,
- assign logical region,
- assign administrative region,
- reset password,
- force password reset,
- force 2FA enrollment,
- reset 2FA,
- revoke single or all sessions.

Self-service operations:

- update display/profile fields,
- change password,
- enroll/reset own 2FA,
- view active sessions,
- revoke own sessions,
- view recent login/security history.

Rules:

- creation and invite flows should create inactive or invited accounts with tokenized activation.
- disabling should block login but preserve history.
- locking should be used for security-triggered temporary access suspension.
- protected users require higher-level authorization and step-up auth for critical changes.

Operational requirements:

- every lifecycle change must be audited.
- bulk changes should be limited in v1.
- role, job, and region assignments should be separate operations internally even if the UI batches them.

## 14. 2FA and Security Planning

### 2FA Approach

Use TOTP first.

Enrollment flow:

1. user authenticates with password/session,
2. system generates encrypted shared secret,
3. system shows QR and manual key,
4. user confirms with current TOTP code,
5. system marks credential verified,
6. system issues hashed recovery codes.

Verification flow:

1. validate primary auth,
2. require TOTP for enrolled users or required roles,
3. support recovery code fallback,
4. mark session as 2FA-satisfied.

Trusted device/session strategy:

- trusted session flag should be short-lived and device-bound.
- do not use indefinite trust in v1.

Admin recovery/reset flow:

- protected action,
- requires step-up auth,
- revokes outstanding sessions,
- logs security event and audit record.

When 2FA is mandatory:

- Owner, Super Admin, Admin, Security Admin by default.
- any user with protected permissions.
- optional later policy for all backoffice users.

Step-up auth:

- required for role assignment changes,
- permission matrix updates,
- 2FA resets,
- session mass revocation,
- security settings changes,
- protected user management.

Phase 2 security features only:

- WebAuthn/passkeys,
- stronger device attestation,
- adaptive auth scoring.

Broader security expectations:

- password hashing with Argon2id or strong equivalent,
- IP and account rate limiting,
- short lockout escalation policy,
- brute-force detection,
- admin confirmation prompts for high-risk actions,
- complete audit logging for security-relevant changes.

## 15. Plugin Compatibility Planning

Governance overlays must integrate into plugins through EmDash-compatible contracts.

Required patterns:

- plugins register permissions through a permission-registration API or manifest extension.
- plugin routes must declare required permissions and optionally region-awareness flags.
- plugin service operations must call shared authorization helpers.
- plugin writes must occur inside Kysely transactions for multi-step changes.
- plugins may observe user/job/region context, but should not query unrelated governance tables directly when service helpers exist.
- plugin settings changes should be auditable if they affect security or authorization.

Distinctions:

- safe internal plugins are first-party or trusted plugins built against Mini contracts.
- broader plugin ambitions such as arbitrary third-party marketplace plugins should be deferred.
- Mini should design for compatibility, not for v1 open-market plugin trust.

## 16. Transactions and Data Integrity Planning

Use Kysely transactions whenever a change spans more than one table or must produce all-or-nothing security state.

Mandatory transaction cases:

- user creation plus initial role/job/region assignment,
- role changes plus cache invalidation markers and audit entries,
- permission matrix updates,
- 2FA reset plus session revocation,
- disable/lock user plus session revocation,
- invite acceptance and account activation,
- protected settings changes.

Guidance:

- one transaction should cover the business change and its audit row creation.
- if side effects such as email sending exist, persist change first then dispatch asynchronously from durable event/outbox or post-commit hook.
- use savepoints only for contained optional sub-steps, not as a substitute for correct service design.

Safe transactional modules in v1:

- user governance,
- security operations,
- content publishing with governance checks,
- plugin configuration updates.

Deferred or isolated domains:

- finance,
- procurement,
- inventory,
- high-volume workflow engines,
- cross-domain ERP-style operations.

## 17. Admin UI Planning

Each screen should be implemented as an EmDash admin extension, not a new admin app.

### Users Screen

- Purpose: search, inspect, create, invite, activate, disable, lock, and manage users.
- Primary actions: create, invite, assign role, assign job, assign regions, reset password, revoke sessions, reset 2FA.
- Critical constraints: protected users guarded by level and step-up auth.
- Classification: EmDash admin extension plus governance overlay.

### Roles Screen

- Purpose: view role catalog, levels, descriptions, protected flags.
- Primary actions: create non-system role later, edit metadata, inspect assignments.
- Critical constraints: protected roles immutable in key areas.
- Classification: governance overlay.

### Permission Matrix Screen

- Purpose: role-permission management.
- Primary actions: grant/revoke permissions, review diffs, apply audited updates.
- Critical constraints: protected permissions and step-up auth.
- Classification: governance overlay.

### Jobs / Job Titles / Job Levels Screens

- Purpose: maintain organizational hierarchy metadata.
- Primary actions: create levels, create titles, assign user jobs, view reporting lines.
- Critical constraints: jobs do not directly grant authorization.
- Classification: governance overlay.

### Logical Regions Screen

- Purpose: manage operational region tree.
- Primary actions: create/edit/reparent regions, assign users.
- Critical constraints: max depth 10; safe reparenting rules.
- Classification: governance overlay.

### Administrative Regions Screen

- Purpose: manage Indonesian legal hierarchy.
- Primary actions: import/seed hierarchy, assign users, inspect lineage.
- Critical constraints: preserve legal type hierarchy integrity.
- Classification: governance overlay.

### Security Settings / 2FA Management Screen

- Purpose: security policy management and user 2FA administration.
- Primary actions: enforce 2FA, reset 2FA, inspect lockouts, revoke trust.
- Critical constraints: step-up auth for protected changes.
- Classification: EmDash settings extension plus governance overlay.

### Audit Logs Screen

- Purpose: review sensitive administrative and security activity.
- Primary actions: filter, inspect before/after data, export later if needed.
- Critical constraints: read-only, limited access, tamper-evident storage policy.
- Classification: governance overlay or internal plugin.

## 18. API / Service Planning

Services should be explicit, narrow, and reusable across admin routes, plugin routes, and future automation.

### Auth Service

- Responsibility: login, logout, sessions, password changes, invite acceptance.
- Key operations: authenticate, issue session, revoke session, require step-up.
- Transaction needs: session issuance, password reset acceptance, invite activation.
- ABAC responsibilities: none beyond identity resolution.
- Plugin considerations: exposes safe identity/session helpers only.

### Authorization Service

- Responsibility: permission resolution, ABAC evaluation, cache invalidation.
- Key operations: `hasPermission`, `canActOnUser`, `canManageRegionScope`, `requireStepUp`.
- Transaction needs: none for read path; writes only for cache invalidation markers.
- ABAC responsibilities: central owner.
- Plugin considerations: mandatory dependency for protected plugin actions.

### Role Service

- Responsibility: manage roles and assignments.
- Key operations: list roles, assign role, revoke role, validate protected role edits.
- Transaction needs: role assignment and protected changes.
- ABAC responsibilities: compare actor and target staff levels.
- Plugin considerations: plugin permissions bind through this service.

### User Service

- Responsibility: user CRUD-style lifecycle and profile operations.
- Key operations: create, invite, activate, disable, lock, update profile.
- Transaction needs: create/invite/disable flows.
- ABAC responsibilities: enforce actor-target management rules.
- Plugin considerations: plugins should not mutate users directly.

### Jobs Service

- Responsibility: manage job levels, titles, assignments, supervisors.
- Key operations: assign job, close assignment, list reporting line.
- Transaction needs: primary job changes and supervisor updates.
- ABAC responsibilities: provide job context, not final auth.
- Plugin considerations: read-only context access where needed.

### Regions Service

- Responsibility: logical region tree and assignments.
- Key operations: create, reparent, assign user, compute subtree.
- Transaction needs: reparent and assignment changes.
- ABAC responsibilities: logical region scoping.
- Plugin considerations: expose scope-check helper.

### Administrative Regions Service

- Responsibility: administrative hierarchy and assignments.
- Key operations: import, maintain hierarchy, assign users, query descendants.
- Transaction needs: bulk imports and reparent restrictions.
- ABAC responsibilities: administrative geo scope.
- Plugin considerations: expose read helpers only unless plugin genuinely needs governance behavior.

### Security Service

- Responsibility: 2FA, recovery codes, lockouts, security events, trusted sessions.
- Key operations: enroll TOTP, verify TOTP, reset 2FA, revoke trust, lock user.
- Transaction needs: 2FA enrollment/reset and lockout state changes.
- ABAC responsibilities: step-up verification and sensitive action checks.
- Plugin considerations: plugins should consume `requireFresh2FA` style helpers.

### Audit Service

- Responsibility: immutable audit event creation and query.
- Key operations: append event, query event history, summarize high-risk operations.
- Transaction needs: usually same transaction as business change.
- ABAC responsibilities: restrict who may read audit content.
- Plugin considerations: plugin actions should emit audit events through this service.

## 19. Migration and Implementation Phases

The roadmap should be atomic. Each phase should end in a shippable, validated state.

### Phase 1: Foundation Auth and Users

- Objective: establish the single-tenant user and auth base on EmDash plus PostgreSQL/Kysely.
- Tasks:
  - bootstrap Mini on EmDash host architecture,
  - configure PostgreSQL adapter and Kysely migration runner,
  - map EmDash auth assumptions to Mini user table design,
  - implement users, profiles, sessions, login security events,
  - build base admin users screen,
  - add invite, activate, disable, lock, and session revoke flows.
- Dependencies: EmDash runtime integration, PostgreSQL connectivity.
- Risks: auth drift from upstream EmDash; session model mismatch.
- Expected outcome: working login and user lifecycle with audit-ready foundations.

### Phase 2: Roles, Permissions, Matrix

- Objective: establish explicit RBAC control plane.
- Tasks:
  - create roles, permissions, role_permissions, user_roles,
  - seed default role catalog,
  - implement protected role rules,
  - implement permission matrix screen and APIs,
  - add role-aware user management constraints.
- Dependencies: Phase 1 identity base.
- Risks: overcomplicating multi-role support too early.
- Expected outcome: stable RBAC baseline with auditable grants.

### Phase 3: ABAC Core

- Objective: add contextual authorization without changing host architecture.
- Tasks:
  - define subject/resource/context model,
  - implement authorization service evaluation flow,
  - add actor-target staff-level checks,
  - add ownership and self-service rules,
  - add policy cache and invalidation hooks.
- Dependencies: Phase 2 permission catalog and assignments.
- Risks: ABAC rules becoming implicit or too scattered.
- Expected outcome: centralized policy evaluation service used by admin and plugins.

### Phase 4: Jobs Hierarchy

- Objective: add organizational context.
- Tasks:
  - create job_levels, job_titles, user_jobs,
  - seed initial ladder,
  - build jobs admin screens,
  - implement supervisor validation,
  - expose job context to authorization service.
- Dependencies: Phase 1 users, Phase 3 auth service hooks.
- Risks: accidental coupling to permissions.
- Expected outcome: historical job structure available for governance context.

### Phase 5: Dual Regions

- Objective: add both hierarchy systems without conflating them.
- Tasks:
  - create logical regions schema,
  - create administrative regions schema,
  - build tree management tools,
  - implement assignment flows,
  - add subtree evaluation helpers,
  - integrate region scope into authorization service.
- Dependencies: Phase 3 ABAC core.
- Risks: expensive subtree queries if path/index design is weak.
- Expected outcome: region-scoped governance with clear separation of region semantics.

### Phase 6: 2FA and Security Hardening

- Objective: production-safe security controls.
- Tasks:
  - implement TOTP enroll/verify/reset,
  - generate and store recovery codes,
  - implement trusted session rules,
  - add lockout and rate-limit strategy,
  - enforce step-up for sensitive actions,
  - build security settings and audit views.
- Dependencies: Phase 1 auth base, Phase 3 authorization service.
- Risks: bad UX if mandatory 2FA is enforced too early.
- Expected outcome: hardened admin auth and security operations.

### Phase 7: Plugin Integration and Policy Propagation

- Objective: ensure governance overlays extend cleanly into plugins.
- Tasks:
  - define plugin permission registration contract,
  - implement plugin route guard helpers,
  - add plugin service auth hooks,
  - add audit helper for plugin actions,
  - verify region-aware plugin behavior,
  - document internal plugin contract.
- Dependencies: Phases 2-6.
- Risks: bypass paths if plugins skip shared helpers.
- Expected outcome: EmDash-compatible plugin model with Mini governance enforcement.

## 20. Testing and Validation Plan

### Automated Validation

- schema validation for all new tables, constraints, and indexes,
- migration validation for fresh install and incremental upgrade,
- permission tests for every role baseline,
- ABAC tests for self, subordinate, peer, superior, protected, and out-of-scope actions,
- region inheritance tests for ancestor/descendant logic,
- role-level tests for actor-target comparison rules,
- job-context tests for contextual approvals and non-authoritative behavior,
- 2FA tests for enrollment, verification, recovery, reset, and trusted session expiry,
- audit-log tests verifying append-on-sensitive-change behavior,
- transaction rollback tests for multi-step failures,
- plugin authorization tests verifying route and service enforcement.

### Manual QA Scenarios

- invite user and complete activation,
- assign role/job/regions in one admin workflow,
- attempt to modify a protected higher-level user,
- test region-scoped editor restrictions,
- reset 2FA and confirm sessions revoke,
- change permission matrix and verify effective access changes,
- confirm audit visibility for every sensitive action,
- validate admin screens on normal and protected accounts.

### Regression Priorities

- auth/session stability,
- content administration unaffected by governance overlays,
- role and permission updates invalidate caches correctly,
- plugin routes do not bypass policy service,
- hierarchy edits do not corrupt subtree queries.

### Acceptance Criteria

- all critical admin actions are permission and policy guarded,
- no direct UI-only security assumptions remain,
- user/job/region/role distinctions remain intact,
- all protected actions are audited,
- 2FA enforcement is configurable and reliable,
- plugin integrations use shared authorization APIs,
- no multi-tenant or Supabase assumptions exist in core implementation.

## 21. Documentation Plan

The repository should eventually include:

- `docs/architecture/overview.md` for EmDash-first architecture,
- `docs/security/auth-and-authorization.md`,
- `docs/governance/roles-hierarchy.md`,
- `docs/governance/jobs-hierarchy.md`,
- `docs/governance/regions.md`,
- `docs/security/2fa-and-security-controls.md`,
- `docs/plugins/governance-plugin-contract.md`,
- `docs/database/migration-guide.md`,
- `docs/admin/operations-guide.md`.

Each document should clearly mark what is EmDash core, what is Mini extension, and what is explicitly excluded.

## 22. Risks, Trade-offs, and Non-Goals

- Mini must not attempt to become full AWCMS because that would recreate multi-tenant platform complexity and drift from EmDash.
- Multi-tenant features are excluded to keep schema, policy, and operational control smaller and safer.
- The visual editor is excluded in v1 because governance and security controls are higher priority and already substantial.
- Pure ABAC-only UI is not recommended because operators need explicit, auditable permission assignments.
- Universal RLS is unnecessary in v1 because backend/service-layer enforcement is clearer, more portable, and more aligned with EmDash's application architecture.
- Role hierarchy and job hierarchy must remain separate to preserve authorization clarity.
- EmDash architecture must stay dominant to prevent long-term maintenance conflict and upstream isolation.

## 23. Rollback and Safety Strategy

- prefer additive migrations first,
- use feature flags for ABAC enforcement rollout where useful,
- support audit-only mode for some policy checks before hard enforcement,
- enable 2FA enforcement in stages by role group,
- keep emergency Owner recovery path documented and tested,
- roll out region-based ABAC after subtree logic is validated,
- keep permission matrix changes transactional and reversible through explicit follow-up migrations or seeded-state restore scripts,
- avoid destructive schema rewrites until behavior is proven in staging.

## 24. Final Recommended Architecture Decision

AWCMS Mini should be implemented as an EmDash-first, single-tenant CMS built on PostgreSQL plus Kysely, with AWCMS concepts used only as non-conflicting governance overlays. EmDash should remain the canonical architecture for content, admin, auth, and plugins. Mini should not port AWCMS modules or resources outside EmDash's core/plugin model. It should exclude multi-tenant logic, Supabase, and the visual editor from v1. The recommended delivery approach is a phased implementation that first stabilizes auth and users, then RBAC, then ABAC, then jobs, regions, security hardening, and finally plugin policy propagation.

## Atomic Implementation Strategy Appendix

This appendix breaks the roadmap into execution-ready atomic work items suitable for a coding agent.

### Track A: Foundation Bootstrapping

1. Initialize Mini repository structure on EmDash host runtime.
2. Add PostgreSQL environment/config contract.
3. Wire Kysely PostgreSQL dialect and migration runner.
4. Create baseline database package/module organization.
5. Verify fresh boot with EmDash admin reachable.

### Track B: Identity and Sessions

1. Create `users` migration.
2. Create `user_profiles` migration.
3. Create `sessions` migration.
4. Create `login_security_events` migration.
5. Build user repository/service methods.
6. Build session repository/service methods.
7. Implement auth event logging hook points.
8. Add user list/detail admin screens.
9. Add invite/activation flows.
10. Add disable/lock/session revoke actions.

### Track C: RBAC

1. Create `roles` migration.
2. Create `permissions` migration.
3. Create `role_permissions` migration.
4. Create `user_roles` migration.
5. Seed default permissions.
6. Seed default roles and staff levels.
7. Build authorization catalog read API.
8. Build role assignment service.
9. Build roles screen.
10. Build permission matrix screen.
11. Add protected-role guardrails.

### Track D: ABAC Core

1. Define central authorization context types.
2. Implement permission resolution helper.
3. Implement actor-target staff-level policy rules.
4. Implement self-service policy rules.
5. Implement ownership-based content rules.
6. Add explicit deny reason structure.
7. Add cache key and invalidation model.
8. Integrate service checks into admin routes.
9. Integrate checks into plugin route helpers.
10. Add ABAC unit/integration tests.

### Track E: Jobs

1. Create `job_levels` migration.
2. Create `job_titles` migration.
3. Create `user_jobs` migration.
4. Seed default job ladder.
5. Build jobs services.
6. Build job levels/titles screens.
7. Build user job assignment UI.
8. Add supervisor validation.
9. Expose job context to authorization layer.

### Track F: Logical Regions

1. Create `regions` migration.
2. Create `user_region_assignments` migration.
3. Implement path generation/update logic.
4. Build logical region tree screen.
5. Build user logical region assignment UI.
6. Add subtree query helpers.
7. Add logical region ABAC rules.

### Track G: Administrative Regions

1. Create `administrative_regions` migration.
2. Create `user_administrative_region_assignments` migration.
3. Build import/seed pipeline for Indonesian hierarchy.
4. Build administrative region tree screen.
5. Build user administrative region assignment UI.
6. Add subtree query helpers.
7. Add administrative region ABAC rules.

### Track H: Security Hardening

1. Create `totp_credentials` migration.
2. Create `recovery_codes` migration.
3. Create `password_reset_tokens` migration.
4. Create `security_events` migration.
5. Implement TOTP enrollment.
6. Implement TOTP challenge verification.
7. Implement recovery code generation/use.
8. Implement forced reset and admin reset flows.
9. Implement trusted session policy.
10. Implement rate limiting and lockouts.
11. Add security settings screen.

### Track I: Audit

1. Create `audit_logs` migration.
2. Add audit append service.
3. Add audit writes to user lifecycle changes.
4. Add audit writes to role and permission changes.
5. Add audit writes to region and job changes.
6. Add audit writes to security changes.
7. Build audit log screen and filters.

### Track J: Plugin Governance Contract

1. Define plugin permission registration contract.
2. Define plugin route authorization helper.
3. Define plugin service authorization helper.
4. Add plugin audit helper.
5. Add plugin region-scope helper.
6. Add plugin transaction guidance doc.
7. Validate with one internal governance-aware plugin.

### Track K: Rollout Safety

1. Add feature flags for ABAC hard enforcement.
2. Add audit-only evaluation mode where useful.
3. Stage mandatory 2FA by role.
4. Create operator recovery runbook.
5. Create migration rollback checklist.
6. Run staged validation in dev/staging.
