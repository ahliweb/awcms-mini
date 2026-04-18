# AWCMS Mini Naming Conventions

## Purpose

This document standardizes naming across AWCMS Mini so runtime code, database schema, policy logic, admin screens, plugins, and documentation use one shared vocabulary.

This document is governed by:

- `docs/architecture/constraints.md`
- `docs/architecture/repository-layout.md`
- `awcms_mini_implementation_plan.md`

## Core Rule

Use explicit, stable, domain-specific names.

Avoid vague, overloaded, or product-drifting names. If a name could mean different things in auth, governance, content, or geography, choose a more specific term.

## General Naming Rules

- prefer ASCII, lowercase, and literal naming in paths, flags, and identifiers
- prefer full domain words over unclear abbreviations
- prefer consistency over cleverness
- prefer names that match the architecture documents and issue backlog
- do not introduce AWCMS multi-tenant vocabulary into Mini
- do not invent synonyms for already-established domain concepts

Examples:

- use `administrative-region` instead of `geo-unit`
- use `staff_level` instead of `rank` when referring to role hierarchy metadata
- use `job_level` instead of `grade` unless a future issue explicitly defines a separate concept

## Domain Vocabulary

### User

- Meaning: a canonical authenticated identity in the system
- Use for:
  - login identity
  - profile ownership
  - session ownership
  - role assignment target
  - job assignment target
  - region assignment target
- Do not substitute with:
  - member
  - account
  - actor

`actor` may be used only in policy and audit contexts when a user performs an action.

### Role

- Meaning: an authorization construct that grants permissions
- Use for:
  - RBAC assignment
  - protected role rules
  - `staff_level` metadata
- Do not use interchangeably with:
  - job
  - title
  - position

### Permission

- Meaning: an explicit grantable capability code
- Use for:
  - RBAC catalog entries
  - route/service guard checks
  - plugin capability registration
- Do not describe permissions as:
  - rights bundle
  - access mode
  - role rule

### Job

- Meaning: an organizational assignment, not an authorization grant
- Use for:
  - reporting structure
  - titles
  - levels
  - supervisor relationships
- Do not conflate with:
  - role
  - permission
  - region scope

### Logical Region

- Meaning: an internal operational hierarchy used for business scope
- Use for:
  - editorial or operational ownership
  - internal scope evaluation
  - management boundaries
- Preferred terms:
  - `logical region`
  - `detail region` only if a later issue specifically needs that synonym in UI copy
- Do not conflate with:
  - administrative region
  - office location
  - legal geography

### Administrative Region

- Meaning: an Indonesian legal/geographic hierarchy
- Use for:
  - province
  - regency/city
  - district
  - village
- Do not shorten to:
  - geo
  - territory
  - area
    when the legal hierarchy is intended

### Policy

- Meaning: centralized authorization logic that evaluates whether an action is allowed
- Use for:
  - RBAC resolution
  - ABAC evaluation
  - allow/deny decisions
- Do not scatter policy naming across unrelated helper folders such as `guards`, `rules`, `checks`, and `permissions` unless the ownership split is explicit

## Permission Naming

Permission codes must use:

`scope.resource.action`

This format is mandatory.

### Permission Segment Rules

- `scope`: top-level area such as `admin`, `content`, `security`, `audit`, `plugins`, `governance`
- `resource`: concrete target such as `users`, `roles`, `jobs`, `regions`, `administrative_regions`, `sessions`
- `action`: operation such as `read`, `create`, `update`, `delete`, `assign`, `publish`, `revoke`, `reset`

### Permission Examples

- `admin.users.read`
- `admin.users.update`
- `admin.roles.assign`
- `admin.permissions.update`
- `governance.jobs.assign`
- `governance.regions.read`
- `governance.administrative_regions.assign`
- `security.sessions.revoke`
- `security.2fa.reset`
- `audit.logs.read`
- `plugins.manage.update`

### Permission Rules

- permission codes should be lowercase with dot separators
- resource names should generally be plural nouns
- action names should be verbs
- do not encode role names inside permission codes
- do not encode region names inside permission codes
- do not create permission codes that mix multiple unrelated resources

Forbidden examples:

- `canEditUsers`
- `users.admin.update`
- `admin.user_management_and_roles.update`
- `super_admin.override`

## Table Naming

Database tables should use `snake_case` plural nouns unless a future migration issue requires a strong exception.

Examples:

- `users`
- `user_profiles`
- `sessions`
- `login_security_events`
- `roles`
- `permissions`
- `role_permissions`
- `user_roles`
- `job_levels`
- `job_titles`
- `user_jobs`
- `regions`
- `administrative_regions`
- `user_region_assignments`
- `user_administrative_region_assignments`
- `audit_logs`
- `security_events`

### Table Rules

- use join-table names that clearly state both sides of the relationship
- use assignment-table names when the record carries business meaning beyond pure many-to-many linkage
- do not shorten names to opaque forms such as `usr_roles` or `adm_regions`

## Column Naming

Columns should use `snake_case`.

### Identifier Rules

- primary keys: `id`
- foreign keys: `<related>_id`
- timestamps: `<event>_at`
- booleans: `is_<state>` or `<verb>_at` depending on whether state or event timing matters

Examples:

- `user_id`
- `role_id`
- `supervisor_user_id`
- `deleted_by_user_id`
- `created_at`
- `updated_at`
- `verified_at`
- `disabled_at`
- `deleted_at`
- `is_primary`
- `is_protected`
- `staff_level`

### Column Rules

- prefer event timestamps like `revoked_at` over paired state booleans like `is_revoked` when timing matters
- prefer explicit names such as `session_token_hash` over generic names such as `token`
- use `path` for hierarchy lineage only when it represents a materialized path

## Soft Delete Naming

Use these names consistently when soft delete is supported:

- `deleted_at`: timestamp marking logical deletion
- `deleted_by_user_id`: optional actor who performed the deletion
- `delete_reason`: optional operator-visible deletion reason

Rules:

- prefer `deleted_at` over `is_deleted`
- prefer nullable timestamps over parallel boolean-plus-timestamp pairs
- repositories should use `includeDeleted` for explicit read paths that need deleted rows

## Service Naming

Services should be named by domain and responsibility.

Preferred format:

- `<Domain>Service` for domain orchestration
- `<Domain>Repository` for persistence access
- `<Domain>Policy` or `<Domain>PolicyRules` for policy-specific modules when the split is necessary

Examples:

- `UserService`
- `SessionService`
- `RoleService`
- `AuthorizationService`
- `SecurityService`
- `AuditService`
- `UserRepository`
- `AdministrativeRegionRepository`

### Service Method Naming

Prefer verb-first names that describe business intent.

Examples:

- `createUser`
- `inviteUser`
- `disableUser`
- `assignRole`
- `assignJob`
- `assignLogicalRegion`
- `assignAdministrativeRegion`
- `revokeSession`
- `requireFresh2FA`
- `evaluatePolicy`

Avoid vague names such as:

- `handle`
- `process`
- `doThing`
- `manageUserStuff`

## Route and Path Naming

Route segments should be lowercase and literal.

Examples:

- `/admin/users`
- `/admin/roles`
- `/admin/permissions`
- `/admin/jobs`
- `/admin/regions`
- `/admin/administrative-regions`
- `/admin/security`
- `/admin/audit-logs`

### Route Rules

- use hyphen-separated path segments for multi-word routes
- use `administrative-regions` consistently in routes, not mixed variants
- keep admin routes aligned with screen responsibility

## File and Directory Naming

- directories: kebab-case or lowercase literal names consistent with the repository layout
- database migrations: timestamped or sequence-prefixed descriptive names
- docs: kebab-case markdown filenames
- scripts: descriptive lowercase filenames

Examples:

- `create_users_table`
- `create_administrative_regions_table`
- `github-issue-workflow.md`
- `repository-layout.md`
- `create_github_issues_from_backlog.mjs`

## Event Naming

Event names should be explicit about domain and outcome.

Preferred patterns:

- `<domain>.<resource>.<action>` for audit or security event codes
- `<resource>_<past_tense>` for internal low-level event constants if dot notation is not suitable in code

Examples:

- `security.login.failed`
- `security.2fa.reset`
- `admin.users.disabled`
- `governance.jobs.assigned`
- `audit.logs.exported`

### Event Rules

- use past-tense semantics when the event records something that has already happened
- do not reuse permission codes as event codes without confirming the semantics match

## Feature Flag Naming

Feature flags should be explicit, stable, and scoped.

Preferred format:

- `feature_<domain>_<behavior>`
- `enforce_<domain>_<policy>`

Examples:

- `feature_abac_audit_mode`
- `enforce_security_step_up`
- `enforce_mandatory_2fa_admin_roles`

### Feature Flag Rules

- use lowercase snake_case
- encode the behavior, not the implementation detail
- avoid temporary names such as `new_auth` or `v2_regions`

## UI Labeling Guidance

UI copy should reflect the same domain vocabulary as code and schema.

Required distinctions:

- show `Role` when discussing authorization
- show `Job` when discussing organizational assignment
- show `Logical Region` when discussing operational scope
- show `Administrative Region` when discussing legal geography

Do not label a job title as a role in the UI.

## Forbidden Vocabulary

Do not introduce these terms unless a later issue creates a clearly different concept:

- tenant
- workspace
- organization tree as a synonym for both jobs and regions
- geo when administrative region is intended
- rank when staff level is intended
- permission bundle as a replacement for role

## Decision Rule

When naming alternatives exist, choose the option that:

- matches the architecture documents,
- is explicit about the domain,
- distinguishes role, job, logical region, and administrative region cleanly,
- scales cleanly across code, schema, routes, and docs.

If naming remains ambiguous, stop and resolve it through a GitHub issue before implementation continues.
