# AWCMS Mini Atomic Implementation Backlog

## Purpose

This backlog converts `awcms_mini_implementation_plan.md` into issue-sized implementation tasks. Each item is intentionally atomic, dependency-aware, and scoped so an implementation agent can execute it with minimal ambiguity.

## Usage Rules

- Execute tasks in dependency order.
- Keep each issue small enough to complete, review, and validate in one focused change.
- Do not expand scope inside an issue unless the dependency graph requires it.
- Preserve EmDash-first architecture in every implementation decision.
- Do not introduce Supabase, multi-tenant logic, or a competing admin shell.
- Treat AWCMS concepts as overlays only.
- Apply the repository-wide soft delete strategy: mutable entities use soft delete by default, append-only/history tables do not.

## Status Legend

- `todo`: not started
- `blocked`: cannot begin because dependencies are incomplete
- `in_progress`: currently being implemented
- `done`: implemented and validated

## Epic Overview

| Epic | Name | Goal |
| --- | --- | --- |
| E0 | Foundation Decisions | Freeze architecture and repository conventions |
| E1 | Runtime and Database Bootstrap | Stand up EmDash host integration with PostgreSQL and Kysely |
| E2 | Identity and Session Core | Implement users, profiles, sessions, and auth event tracking |
| E3 | RBAC Core | Implement roles, permissions, assignments, and matrix support |
| E4 | ABAC Core | Add service-layer contextual authorization |
| E5 | Jobs Hierarchy | Add organizational structure and reporting lines |
| E6 | Logical Regions | Add 10-level operational region hierarchy |
| E7 | Administrative Regions | Add Indonesian legal region hierarchy |
| E8 | Security Hardening | Add TOTP, recovery, step-up, lockouts, and rate limits |
| E9 | Audit and Observability | Add append-only audit and security event visibility |
| E10 | Admin Surfaces | Deliver governance admin screens on EmDash admin |
| E11 | Plugin Governance Contract | Extend governance into EmDash-compatible plugins |
| E12 | Rollout Safety and Docs | Add flags, rollout controls, and operator docs |

## Task Template

Each issue below includes:

- ID
- Title
- Goal
- Scope
- Deliverables
- Dependencies
- Acceptance Criteria
- Suggested Validation

## E0. Foundation Decisions

### AWM-001: Freeze Mini Architecture Constraints

- Goal: create a canonical architecture constraints document for Mini implementation.
- Scope: translate the implementation plan into repository-local execution constraints.
- Deliverables:
  - `docs/architecture/constraints.md`
  - explicit exclusions for Supabase, multi-tenancy, visual editor v1, and AWCMS module porting
- Dependencies: none
- Acceptance Criteria:
  - document defines EmDash-first rule clearly
  - document defines overlay-only rule for AWCMS concepts
  - document defines PostgreSQL + Kysely as canonical data layer
- Suggested Validation:
  - manual review against `awcms_mini_implementation_plan.md`

### AWM-002: Define Repository Module Layout

- Goal: establish a stable code layout before implementation starts.
- Scope: define where runtime, db, services, admin extensions, and docs live.
- Deliverables:
  - `docs/architecture/repository-layout.md`
  - top-level folder map for runtime, migrations, services, policy, admin, plugins, docs
- Dependencies: AWM-001
- Acceptance Criteria:
  - layout is consistent with EmDash host integration
  - no competing app shells are introduced
- Suggested Validation:
  - manual review against EmDash package boundaries

### AWM-003: Define Naming Conventions and Core Domain Vocabulary

- Goal: avoid drift in permission, service, table, and route naming.
- Scope: define naming conventions for permissions, services, tables, events, and feature flags.
- Deliverables:
  - `docs/architecture/naming-conventions.md`
- Dependencies: AWM-001
- Acceptance Criteria:
  - permission format `scope.resource.action` is standardized
  - role, job, logical region, and administrative region terms are distinguished
- Suggested Validation:
  - terminology spot-check across plan and docs

## E1. Runtime and Database Bootstrap

### AWM-004: Scaffold EmDash Host Runtime for Mini

- Goal: create the initial application scaffold on EmDash.
- Scope: add base runtime and configuration files without governance features yet.
- Deliverables:
  - application scaffold wired to EmDash
  - base environment configuration contract
- Dependencies: AWM-001, AWM-002
- Acceptance Criteria:
  - app boots with EmDash integration enabled
  - no Supabase dependencies appear in the scaffold
- Suggested Validation:
  - local boot smoke test

### AWM-005: Add PostgreSQL Database Adapter Wiring

- Goal: connect Mini to PostgreSQL through EmDash-compatible runtime wiring.
- Scope: runtime configuration only.
- Deliverables:
  - PostgreSQL dialect configuration
  - environment variable usage docs
- Dependencies: AWM-004
- Acceptance Criteria:
  - runtime initializes against PostgreSQL successfully
  - connection settings are documented and isolated
- Suggested Validation:
  - local connection smoke test

### AWM-006: Create Kysely Migration Runner Integration

- Goal: establish canonical migration execution.
- Scope: migration bootstrap only, no business tables yet.
- Deliverables:
  - migration runner module
  - migration command documentation
- Dependencies: AWM-005
- Acceptance Criteria:
  - migrations can run on empty database
  - rollback/check status commands are documented
- Suggested Validation:
  - run empty or baseline migration cycle locally

### AWM-007: Add Baseline Database Utilities and Transaction Wrapper

- Goal: standardize db access and transaction entry points.
- Scope: shared db helper layer for services.
- Deliverables:
  - db access module
  - transaction wrapper helper
  - error classification conventions
- Dependencies: AWM-006
- Acceptance Criteria:
  - services have a single way to acquire db/transactions
  - transaction helper supports nesting or savepoint strategy definition
- Suggested Validation:
  - unit tests for helper behavior

### AWM-008: Create Baseline Healthcheck and Runtime Smoke Validation

- Goal: verify the scaffold is runnable before domain work begins.
- Scope: simple startup and db health validation.
- Deliverables:
  - healthcheck route or equivalent runtime validation path
  - smoke-test instructions
- Dependencies: AWM-004, AWM-005, AWM-007
- Acceptance Criteria:
  - startup failure modes are visible
  - db connectivity can be verified quickly
- Suggested Validation:
  - local smoke test

## E2. Identity and Session Core

### AWM-009: Create `users` Table Migration

- Goal: define the canonical user identity table.
- Scope: schema only.
- Deliverables:
  - migration for `users`
- Dependencies: AWM-006
- Acceptance Criteria:
  - unique email constraint exists
  - status and protection fields exist
  - soft delete columns exist for user lifecycle retention
  - indexes align with the plan
- Suggested Validation:
  - migration test on empty db

### AWM-010: Create `user_profiles` Table Migration

- Goal: separate non-auth profile data from identity core.
- Scope: schema only.
- Deliverables:
  - migration for `user_profiles`
- Dependencies: AWM-009
- Acceptance Criteria:
  - one-to-one profile relationship is enforced
  - profile data excludes auth secrets
  - profile soft delete marker aligns with the user lifecycle model
- Suggested Validation:
  - migration test and schema inspection

### AWM-011: Create `sessions` Table Migration

- Goal: track active and historical sessions.
- Scope: schema only.
- Deliverables:
  - migration for `sessions`
- Dependencies: AWM-009
- Acceptance Criteria:
  - token hash storage is used instead of raw token storage
  - revoke/expiry columns exist
- Suggested Validation:
  - migration test and index check

### AWM-012: Create `login_security_events` Table Migration

- Goal: persist login and auth attempt history.
- Scope: schema only.
- Deliverables:
  - migration for `login_security_events`
- Dependencies: AWM-009
- Acceptance Criteria:
  - event type and outcome fields exist
  - append-only shape is clear
- Suggested Validation:
  - migration test

### AWM-013: Implement User Repository

- Goal: create the canonical persistence layer for user identity data.
- Scope: repository methods only.
- Deliverables:
  - create/get/list/update/status-change/soft-delete/restore repository methods
- Dependencies: AWM-009, AWM-010
- Acceptance Criteria:
  - repository does not embed authorization logic
  - repository is transaction-compatible
  - soft-deleted users are excluded from normal reads by default
- Suggested Validation:
  - repository unit tests

### AWM-014: Implement Session Repository

- Goal: create the persistence layer for sessions.
- Scope: repository methods only.
- Deliverables:
  - create/revoke/list/revoke-all/update-last-seen methods
- Dependencies: AWM-011
- Acceptance Criteria:
  - session hashes are handled safely
  - revoke operations support per-session and all-session flows
- Suggested Validation:
  - repository unit tests

### AWM-015: Implement Login Security Event Repository

- Goal: make auth events persistable from login flows.
- Scope: repository only.
- Deliverables:
  - append/list methods for login events
- Dependencies: AWM-012
- Acceptance Criteria:
  - repository is append-only
  - supports user-linked and anonymous attempts
- Suggested Validation:
  - unit tests

### AWM-016: Implement User Service Core Flows

- Goal: provide user lifecycle orchestration.
- Scope: create, invite, activate, disable, lock, soft delete, restore, update profile.
- Deliverables:
  - user service methods
  - transaction boundaries for lifecycle operations
- Dependencies: AWM-013, AWM-014, AWM-015
- Acceptance Criteria:
  - lifecycle state changes are explicit
  - no role/job/region logic is mixed in yet beyond extension hooks
  - soft delete and restore flows are explicit and revoke sessions where appropriate
- Suggested Validation:
  - service tests for each lifecycle flow

### AWM-017: Implement Session Service Core Flows

- Goal: provide session lifecycle orchestration.
- Scope: issue, refresh, revoke, revoke-all, list-active.
- Deliverables:
  - session service methods
- Dependencies: AWM-014
- Acceptance Criteria:
  - per-user session revocation is supported
  - trusted session flags are represented even if unused initially
- Suggested Validation:
  - service tests

### AWM-018: Wire EmDash Auth Entry Points to Mini Identity Layer

- Goal: connect Mini identity/session behavior into the EmDash auth boundary.
- Scope: auth integration only.
- Deliverables:
  - runtime auth wiring
  - login/logout integration points
- Dependencies: AWM-016, AWM-017
- Acceptance Criteria:
  - authentication flows use Mini persistence model
  - auth events are emitted to login security logging
- Suggested Validation:
  - end-to-end login smoke test

### AWM-019: Add Base Users Admin List Screen

- Goal: provide initial admin visibility into users.
- Scope: read-only list/detail basics.
- Deliverables:
  - users list page
  - basic user detail page
- Dependencies: AWM-016, AWM-018
- Acceptance Criteria:
  - user list displays status and core profile metadata
  - page is implemented inside EmDash admin extension path
- Suggested Validation:
  - manual UI smoke test

### AWM-020: Add Invite and Activation UI Flow

- Goal: allow operators to create invited users and activate accounts.
- Scope: admin create/invite plus user activation.
- Deliverables:
  - invite UI flow
  - activation handler/page
- Dependencies: AWM-016, AWM-019
- Acceptance Criteria:
  - invited users cannot log in before activation
  - activation completes user state transition correctly
- Suggested Validation:
  - manual flow test

### AWM-021: Add Disable, Lock, and Session Revocation UI Actions

- Goal: expose core lifecycle controls.
- Scope: admin UI actions only.
- Deliverables:
  - disable/lock actions
  - revoke sessions action
- Dependencies: AWM-017, AWM-019
- Acceptance Criteria:
  - controls update status correctly
  - revoked sessions lose access promptly
- Suggested Validation:
  - manual and integration tests

## E3. RBAC Core

### AWM-022: Create `roles` Table Migration

- Goal: define role catalog storage.
- Scope: schema only.
- Deliverables:
  - migration for `roles`
- Dependencies: AWM-006
- Acceptance Criteria:
  - `staff_level` and protection metadata exist
  - role slug is unique
- Suggested Validation:
  - migration test

### AWM-023: Create `permissions` Table Migration

- Goal: define permission catalog storage.
- Scope: schema only.
- Deliverables:
  - migration for `permissions`
- Dependencies: AWM-006, AWM-003
- Acceptance Criteria:
  - permission code uniqueness is enforced
  - protected permission marker exists
- Suggested Validation:
  - migration test

### AWM-024: Create `role_permissions` Table Migration

- Goal: define role-to-permission mapping.
- Scope: schema only.
- Deliverables:
  - migration for `role_permissions`
- Dependencies: AWM-022, AWM-023
- Acceptance Criteria:
  - composite uniqueness is enforced
  - grant metadata exists
- Suggested Validation:
  - migration test

### AWM-025: Create `user_roles` Table Migration

- Goal: define user-to-role assignment storage.
- Scope: schema only.
- Deliverables:
  - migration for `user_roles`
- Dependencies: AWM-009, AWM-022
- Acceptance Criteria:
  - supports active assignment history
  - future single-primary or multi-role rules can be enforced cleanly
- Suggested Validation:
  - migration test

### AWM-026: Seed Default Permission Catalog

- Goal: establish initial explicit permission inventory.
- Scope: seed data only.
- Deliverables:
  - permission seed file or migration seed logic
- Dependencies: AWM-023
- Acceptance Criteria:
  - permissions are grouped by domain
  - protected permissions are marked explicitly
- Suggested Validation:
  - seed verification query

### AWM-027: Seed Default Role Catalog and Staff Levels

- Goal: establish initial role hierarchy.
- Scope: seed data only.
- Deliverables:
  - role seed definitions
  - default role-to-level mapping
- Dependencies: AWM-022
- Acceptance Criteria:
  - Owner/Super Admin/Admin/Security Admin/etc. are seeded as planned
  - protected roles are marked correctly
- Suggested Validation:
  - seed verification query

### AWM-028: Seed Default Role-Permission Assignments

- Goal: create the baseline RBAC model.
- Scope: seed data only.
- Deliverables:
  - role-permission assignment seed
- Dependencies: AWM-024, AWM-026, AWM-027
- Acceptance Criteria:
  - each default role has explicit permissions
  - protected permissions are limited to correct roles
- Suggested Validation:
  - effective permission verification test

### AWM-029: Implement Role Repository and Permission Repository

- Goal: provide persistence access for roles and permissions.
- Scope: repositories only.
- Deliverables:
  - role repository
  - permission repository
  - mapping repository methods
- Dependencies: AWM-022, AWM-023, AWM-024, AWM-025
- Acceptance Criteria:
  - repositories stay free of ABAC business rules
  - repositories support diffing for matrix updates
- Suggested Validation:
  - unit tests

### AWM-030: Implement Role Assignment Service

- Goal: orchestrate user-role assignment safely.
- Scope: service logic only.
- Deliverables:
  - assign/revoke/list-active role service methods
- Dependencies: AWM-029, AWM-016
- Acceptance Criteria:
  - assignment history is preserved
  - actor-target protection hooks are pluggable for ABAC phase
- Suggested Validation:
  - service tests

### AWM-031: Implement Permission Resolution Service

- Goal: resolve effective permissions from role assignments.
- Scope: RBAC resolution only, no ABAC yet.
- Deliverables:
  - effective permission read service
- Dependencies: AWM-029, AWM-030, AWM-028
- Acceptance Criteria:
  - returns explicit effective permissions per user
  - supports caching hook points
- Suggested Validation:
  - service tests across default roles

### AWM-032: Add Roles Admin Screen

- Goal: expose role catalog visibility and edits.
- Scope: list/detail/edit metadata basics.
- Deliverables:
  - roles admin page
- Dependencies: AWM-029
- Acceptance Criteria:
  - role level and protection state are visible
  - protected roles are visually differentiated
- Suggested Validation:
  - manual UI test

### AWM-033: Add Permission Matrix Admin Screen

- Goal: expose editable role-permission mappings.
- Scope: matrix UI and supporting API.
- Deliverables:
  - permission matrix page
  - matrix read/update endpoint or action
- Dependencies: AWM-029, AWM-031, AWM-032
- Acceptance Criteria:
  - roles are columns and permissions are rows
  - protected permissions are marked
  - updates are staged before apply
- Suggested Validation:
  - manual matrix edit smoke test

### AWM-034: Add Protected Role and Protected Permission Guardrails

- Goal: prevent unsafe RBAC modifications.
- Scope: service and UI guardrails.
- Deliverables:
  - protected role constraints
  - protected permission constraints
- Dependencies: AWM-030, AWM-033
- Acceptance Criteria:
  - protected roles cannot be deleted or dangerously downgraded
  - protected permissions require explicit elevated flow
- Suggested Validation:
  - service tests and manual negative testing

## E4. ABAC Core

### AWM-035: Define Authorization Context Types and Evaluation Inputs

- Goal: normalize inputs to policy evaluation.
- Scope: types and interfaces only.
- Deliverables:
  - subject/resource/context type definitions
  - evaluation result type
- Dependencies: AWM-003, AWM-031
- Acceptance Criteria:
  - roles, jobs, regions, ownership, and session strength are representable
  - deny reason structure is explicit
- Suggested Validation:
  - type-level review and unit tests

### AWM-036: Implement Authorization Service Skeleton

- Goal: create the central policy service entry point.
- Scope: service shell and wiring only.
- Deliverables:
  - authorization service module
  - `hasPermission` and `evaluate` skeleton methods
- Dependencies: AWM-035, AWM-031
- Acceptance Criteria:
  - all future policy checks route through one service
  - RBAC baseline is integrated
- Suggested Validation:
  - unit tests for permission-missing denies

### AWM-037: Implement Self-Service and Ownership Rules

- Goal: add first contextual allow rules.
- Scope: self-profile, self-password, self-2FA, own-session, own-content patterns.
- Deliverables:
  - self-service rule module
  - ownership rule module
- Dependencies: AWM-036
- Acceptance Criteria:
  - self-actions are allowed only when scoped correctly
  - own-content rules do not elevate beyond baseline permissions
- Suggested Validation:
  - ABAC unit tests

### AWM-038: Implement Actor-Target Staff Level Rules

- Goal: restrict administrative actions across hierarchy levels.
- Scope: user and role management comparisons.
- Deliverables:
  - staff-level comparison rule module
- Dependencies: AWM-036, AWM-027
- Acceptance Criteria:
  - peer or higher protected targets are denied by default
  - override path is explicit, not implicit
- Suggested Validation:
  - ABAC unit tests across level combinations

### AWM-039: Add Structured Allow/Deny Reason Reporting

- Goal: make policy outcomes explainable and testable.
- Scope: policy result formatting.
- Deliverables:
  - standardized reason codes/messages
- Dependencies: AWM-036
- Acceptance Criteria:
  - all policy outcomes return machine-readable reason codes
  - high-risk denies can be surfaced in audit/security logs later
- Suggested Validation:
  - unit tests

### AWM-040: Implement Authorization Cache and Invalidation Hooks

- Goal: reduce repeated policy recomputation safely.
- Scope: cache model only.
- Deliverables:
  - cache interface
  - invalidation triggers for role/user changes
- Dependencies: AWM-036, AWM-039
- Acceptance Criteria:
  - invalidation events are defined for role, job, region, status, and 2FA changes
  - stale cache cannot outlive safety TTL
- Suggested Validation:
  - cache tests

### AWM-041: Integrate Authorization Service into Admin Route Guards

- Goal: make service-layer auth the canonical admin enforcement path.
- Scope: route/handler integration.
- Deliverables:
  - guard helper usage in admin endpoints/actions
- Dependencies: AWM-037, AWM-038, AWM-039
- Acceptance Criteria:
  - admin endpoints do not rely on UI-only checks
  - unauthorized admin requests fail consistently
- Suggested Validation:
  - integration tests

## E5. Jobs Hierarchy

### AWM-042: Create `job_levels` Table Migration

- Goal: store organizational level ladder.
- Scope: schema only.
- Deliverables:
  - migration for `job_levels`
- Dependencies: AWM-006
- Acceptance Criteria:
  - rank order uniqueness is enforced
- Suggested Validation:
  - migration test

### AWM-043: Create `job_titles` Table Migration

- Goal: store job titles mapped to levels.
- Scope: schema only.
- Deliverables:
  - migration for `job_titles`
- Dependencies: AWM-042
- Acceptance Criteria:
  - titles link to levels cleanly
- Suggested Validation:
  - migration test

### AWM-044: Create `user_jobs` Table Migration

- Goal: store job assignments and history.
- Scope: schema only.
- Deliverables:
  - migration for `user_jobs`
- Dependencies: AWM-009, AWM-042, AWM-043
- Acceptance Criteria:
  - supports active primary assignment and supervisor link
  - effective dating columns exist
- Suggested Validation:
  - migration test

### AWM-045: Seed Default Job Level Ladder

- Goal: define the initial organizational ladder.
- Scope: seed data only.
- Deliverables:
  - job level seed definitions
- Dependencies: AWM-042
- Acceptance Criteria:
  - ranks are ordered and documented
- Suggested Validation:
  - seed verification query

### AWM-046: Implement Jobs Repository Layer

- Goal: provide persistence access for levels, titles, and assignments.
- Scope: repositories only.
- Deliverables:
  - job levels repo
  - job titles repo
  - user jobs repo
- Dependencies: AWM-042, AWM-043, AWM-044
- Acceptance Criteria:
  - assignment history queries are supported
  - repositories remain authorization-free
- Suggested Validation:
  - unit tests

### AWM-047: Implement Jobs Service and Supervisor Validation

- Goal: orchestrate job assignment changes safely.
- Scope: service logic only.
- Deliverables:
  - assign/change/end job methods
  - supervisor cycle validation
- Dependencies: AWM-046, AWM-016
- Acceptance Criteria:
  - one active primary job per user is enforced
  - circular supervisor chains are denied
- Suggested Validation:
  - service tests

### AWM-048: Expose Job Context to Authorization Service

- Goal: make job context available for ABAC without making it primary auth.
- Scope: context hydration only.
- Deliverables:
  - authorization context integration for current job
- Dependencies: AWM-047, AWM-036
- Acceptance Criteria:
  - current active job can be resolved cheaply
  - no permissions are granted from job data alone
- Suggested Validation:
  - ABAC tests with job context inputs

### AWM-049: Add Job Levels and Job Titles Admin Screens

- Goal: expose organizational catalog management.
- Scope: admin UI for levels and titles.
- Deliverables:
  - job levels page
  - job titles page
- Dependencies: AWM-046
- Acceptance Criteria:
  - level ordering and title-to-level mapping are visible
- Suggested Validation:
  - manual UI test

### AWM-050: Add User Job Assignment UI

- Goal: let admins assign jobs to users.
- Scope: user detail job assignment flow.
- Deliverables:
  - job assignment form on user detail
- Dependencies: AWM-047, AWM-049, AWM-019
- Acceptance Criteria:
  - current and historical job assignments are viewable
  - supervisor selection honors validation rules
- Suggested Validation:
  - manual UI flow test

## E6. Logical Regions

### AWM-051: Create `regions` Table Migration

- Goal: store logical/detail region hierarchy.
- Scope: schema only.
- Deliverables:
  - migration for `regions`
- Dependencies: AWM-006
- Acceptance Criteria:
  - parent, level, and path columns exist
  - max-depth validation path is planned
- Suggested Validation:
  - migration test

### AWM-052: Create `user_region_assignments` Table Migration

- Goal: store user-to-logical-region assignments.
- Scope: schema only.
- Deliverables:
  - migration for `user_region_assignments`
- Dependencies: AWM-009, AWM-051
- Acceptance Criteria:
  - active assignment history is supported
- Suggested Validation:
  - migration test

### AWM-053: Implement Logical Region Repository Layer

- Goal: provide persistence access for logical region trees and assignments.
- Scope: repositories only.
- Deliverables:
  - region repo
  - user region assignment repo
- Dependencies: AWM-051, AWM-052
- Acceptance Criteria:
  - lineage and subtree reads are supported
  - repositories are transaction-safe
- Suggested Validation:
  - unit tests

### AWM-054: Implement Logical Region Path and Reparent Logic

- Goal: safely manage tree mutations.
- Scope: service logic only.
- Deliverables:
  - create/reparent/update subtree path logic
- Dependencies: AWM-053
- Acceptance Criteria:
  - parent-child integrity is preserved
  - reparenting updates descendant paths correctly
  - max depth 10 is enforced
- Suggested Validation:
  - service tests with reparent scenarios

### AWM-055: Implement Logical Region Assignment Service

- Goal: assign users to logical regions.
- Scope: service logic only.
- Deliverables:
  - assign/change/end region assignment methods
- Dependencies: AWM-053, AWM-016
- Acceptance Criteria:
  - primary assignment semantics are enforced if configured
- Suggested Validation:
  - service tests

### AWM-056: Add Logical Region Context to Authorization Service

- Goal: support logical region-aware ABAC.
- Scope: context hydration and rule hooks.
- Deliverables:
  - logical region scope evaluator inputs
- Dependencies: AWM-055, AWM-036
- Acceptance Criteria:
  - actor and target region scopes can be compared
- Suggested Validation:
  - ABAC tests for subtree scope

### AWM-057: Add Logical Regions Admin Screen

- Goal: expose logical region hierarchy management.
- Scope: tree UI.
- Deliverables:
  - logical regions page
- Dependencies: AWM-054
- Acceptance Criteria:
  - create/edit/reparent flows exist
  - tree depth is visible
- Suggested Validation:
  - manual UI test

### AWM-058: Add User Logical Region Assignment UI

- Goal: let admins assign logical regions on user detail.
- Scope: user detail region flow.
- Deliverables:
  - logical region assignment form
- Dependencies: AWM-055, AWM-057, AWM-019
- Acceptance Criteria:
  - current and historical logical region assignments are visible
- Suggested Validation:
  - manual UI flow test

## E7. Administrative Regions

### AWM-059: Create `administrative_regions` Table Migration

- Goal: store Indonesian administrative hierarchy.
- Scope: schema only.
- Deliverables:
  - migration for `administrative_regions`
- Dependencies: AWM-006
- Acceptance Criteria:
  - parent, path, and `type` columns exist
  - type set supports province/regency-city/district/village
- Suggested Validation:
  - migration test

### AWM-060: Create `user_administrative_region_assignments` Table Migration

- Goal: store user-to-administrative-region assignments.
- Scope: schema only.
- Deliverables:
  - migration for `user_administrative_region_assignments`
- Dependencies: AWM-009, AWM-059
- Acceptance Criteria:
  - active assignment history is supported
- Suggested Validation:
  - migration test

### AWM-061: Implement Administrative Region Repository Layer

- Goal: provide persistence access for legal region hierarchy and assignments.
- Scope: repositories only.
- Deliverables:
  - administrative region repo
  - user administrative assignment repo
- Dependencies: AWM-059, AWM-060
- Acceptance Criteria:
  - lineage and subtree reads are supported
- Suggested Validation:
  - unit tests

### AWM-062: Build Administrative Region Import/Seed Pipeline

- Goal: load initial Indonesian region data.
- Scope: import or seed tooling only.
- Deliverables:
  - import/seed command or script
  - source-data assumptions doc
- Dependencies: AWM-061
- Acceptance Criteria:
  - hierarchy imports cleanly
  - duplicate loads are handled safely
- Suggested Validation:
  - import smoke test on empty db

### AWM-063: Implement Administrative Region Assignment Service

- Goal: assign users to administrative regions.
- Scope: service logic only.
- Deliverables:
  - assign/change/end administrative region methods
- Dependencies: AWM-061, AWM-016
- Acceptance Criteria:
  - active assignment semantics are supported
- Suggested Validation:
  - service tests

### AWM-064: Add Administrative Region Context to Authorization Service

- Goal: support administrative-region-aware ABAC.
- Scope: context hydration and rule hooks.
- Deliverables:
  - admin region scope evaluator inputs
- Dependencies: AWM-063, AWM-036
- Acceptance Criteria:
  - actor and target administrative scopes can be compared
- Suggested Validation:
  - ABAC tests for geographic subtree scope

### AWM-065: Add Administrative Regions Admin Screen

- Goal: expose legal region hierarchy management/inspection.
- Scope: tree UI.
- Deliverables:
  - administrative regions page
- Dependencies: AWM-062
- Acceptance Criteria:
  - lineage and type are visible
  - import status or last sync metadata is visible if relevant
- Suggested Validation:
  - manual UI test

### AWM-066: Add User Administrative Region Assignment UI

- Goal: let admins assign administrative regions on user detail.
- Scope: user detail region flow.
- Deliverables:
  - administrative region assignment form
- Dependencies: AWM-063, AWM-065, AWM-019
- Acceptance Criteria:
  - current and historical administrative assignments are visible
- Suggested Validation:
  - manual UI flow test

## E8. Security Hardening

### AWM-067: Create `totp_credentials` Table Migration

- Goal: store TOTP enrollment records.
- Scope: schema only.
- Deliverables:
  - migration for `totp_credentials`
- Dependencies: AWM-006, AWM-009
- Acceptance Criteria:
  - one-active-credential rule is enforceable
  - secrets are stored encrypted, not plaintext
- Suggested Validation:
  - migration test

### AWM-068: Create `recovery_codes` Table Migration

- Goal: store hashed recovery codes.
- Scope: schema only.
- Deliverables:
  - migration for `recovery_codes`
- Dependencies: AWM-067
- Acceptance Criteria:
  - codes are stored hashed only
  - used state is trackable
- Suggested Validation:
  - migration test

### AWM-069: Create `password_reset_tokens` Table Migration

- Goal: support password reset flows.
- Scope: schema only.
- Deliverables:
  - migration for `password_reset_tokens`
- Dependencies: AWM-009
- Acceptance Criteria:
  - token hashes and expiry fields exist
- Suggested Validation:
  - migration test

### AWM-070: Create `security_events` Table Migration

- Goal: store non-general security events.
- Scope: schema only.
- Deliverables:
  - migration for `security_events`
- Dependencies: AWM-006, AWM-009
- Acceptance Criteria:
  - event type, severity, details, and actor linkage exist
- Suggested Validation:
  - migration test

### AWM-071: Create Optional `rate_limit_counters` Support Table or Equivalent Storage Strategy

- Goal: define how lockout/rate-limit counters are stored.
- Scope: schema or explicit runtime strategy.
- Deliverables:
  - migration if db-backed
  - design note if delegated elsewhere
- Dependencies: AWM-006
- Acceptance Criteria:
  - storage strategy is explicit and documented
- Suggested Validation:
  - design review

### AWM-072: Implement TOTP Enrollment Flow

- Goal: let users enroll TOTP securely.
- Scope: generation, provisioning, verify-before-enable.
- Deliverables:
  - enroll and verify service methods
  - enrollment UI flow
- Dependencies: AWM-067, AWM-068, AWM-018
- Acceptance Criteria:
  - unverified enrollment cannot satisfy 2FA
  - recovery codes are generated on successful verification
- Suggested Validation:
  - service and manual flow tests

### AWM-073: Implement TOTP Verification and 2FA Session Marking

- Goal: require 2FA for enrolled/required users.
- Scope: login challenge flow and session state marking.
- Deliverables:
  - TOTP challenge verification
  - session 2FA-satisfied flag handling
- Dependencies: AWM-072, AWM-017
- Acceptance Criteria:
  - enrolled users are challenged correctly
  - successful challenge upgrades session state
- Suggested Validation:
  - integration tests

### AWM-074: Implement Recovery Code Use and Rotation

- Goal: provide safe fallback access.
- Scope: code use and regeneration behavior.
- Deliverables:
  - recovery code verification flow
  - regeneration flow
- Dependencies: AWM-072
- Acceptance Criteria:
  - used codes cannot be reused
  - regeneration invalidates prior set
- Suggested Validation:
  - service tests

### AWM-075: Implement Password Reset and Forced Reset Flows

- Goal: support user and admin password reset use cases.
- Scope: token issue/consume and forced-reset state.
- Deliverables:
  - password reset service
  - forced reset path
- Dependencies: AWM-069, AWM-016
- Acceptance Criteria:
  - tokens expire and are single-use
  - forced reset blocks normal operation until completed
- Suggested Validation:
  - integration tests

### AWM-076: Implement Lockout and Rate-Limit Strategy

- Goal: protect auth endpoints and high-risk actions.
- Scope: account/IP throttling and temporary lockout behavior.
- Deliverables:
  - lockout logic
  - rate-limit enforcement hooks
- Dependencies: AWM-071, AWM-015
- Acceptance Criteria:
  - repeated failures trigger expected throttle/lockout behavior
  - reset paths are defined
- Suggested Validation:
  - security integration tests

### AWM-077: Implement Step-Up Authentication Requirement Flow

- Goal: require fresh strong auth for sensitive actions.
- Scope: recent 2FA verification check and challenge flow.
- Deliverables:
  - `requireFresh2FA` or equivalent helper
  - step-up challenge UX
- Dependencies: AWM-073, AWM-036
- Acceptance Criteria:
  - sensitive actions fail without fresh step-up state
  - freshness window is configurable
- Suggested Validation:
  - integration tests on protected operations

### AWM-078: Add Security Settings and 2FA Admin Screen

- Goal: expose security policy and user 2FA operations.
- Scope: admin UI.
- Deliverables:
  - security settings page
  - user-level 2FA reset controls
- Dependencies: AWM-072, AWM-073, AWM-077
- Acceptance Criteria:
  - mandatory 2FA role policy is configurable
  - 2FA reset requires protected flow
- Suggested Validation:
  - manual UI flow test

## E9. Audit and Observability

### AWM-079: Create `audit_logs` Table Migration

- Goal: store append-only admin and governance audit records.
- Scope: schema only.
- Deliverables:
  - migration for `audit_logs`
- Dependencies: AWM-006
- Acceptance Criteria:
  - before/after payload columns exist
  - entity and actor references are supported
- Suggested Validation:
  - migration test

### AWM-080: Implement Audit Repository and Append Service

- Goal: standardize audit writes.
- Scope: repository and service only.
- Deliverables:
  - audit repository
  - append-only audit service
- Dependencies: AWM-079
- Acceptance Criteria:
  - service supports transaction participation
  - audit payload structure is consistent
- Suggested Validation:
  - unit tests

### AWM-081: Integrate Audit Writes into User Lifecycle Flows

- Goal: audit create/invite/activate/disable/lock/session actions.
- Scope: service integration.
- Deliverables:
  - audit hooks in user and session services
- Dependencies: AWM-080, AWM-016, AWM-017
- Acceptance Criteria:
  - each sensitive lifecycle action emits an audit record
- Suggested Validation:
  - integration tests

### AWM-082: Integrate Audit Writes into RBAC Changes

- Goal: audit role assignment and permission matrix changes.
- Scope: service integration.
- Deliverables:
  - audit hooks in role and permission services
- Dependencies: AWM-080, AWM-030, AWM-033, AWM-034
- Acceptance Criteria:
  - before/after diffs are captured for matrix updates
- Suggested Validation:
  - integration tests

### AWM-083: Integrate Audit Writes into Job and Region Changes

- Goal: audit organizational assignment changes.
- Scope: service integration.
- Deliverables:
  - audit hooks in jobs and region services
- Dependencies: AWM-080, AWM-047, AWM-055, AWM-063
- Acceptance Criteria:
  - assignments and reparent operations are audited
- Suggested Validation:
  - integration tests

### AWM-084: Integrate Audit and Security Events into Security Flows

- Goal: audit security-sensitive operations.
- Scope: security service integration.
- Deliverables:
  - audit/security event writes on TOTP reset, forced reset, lockout, step-up failures
- Dependencies: AWM-070, AWM-080, AWM-072, AWM-073, AWM-076, AWM-077
- Acceptance Criteria:
  - security operations emit both the right audit and security event classes
- Suggested Validation:
  - integration tests

### AWM-085: Add Audit Logs Admin Screen

- Goal: expose governance and security history to authorized users.
- Scope: read-only admin UI.
- Deliverables:
  - audit log page with filtering
- Dependencies: AWM-080
- Acceptance Criteria:
  - actor, action, entity, and timestamp are visible
  - access is permission-guarded
- Suggested Validation:
  - manual UI test

## E10. Admin Surfaces

### AWM-086: Add User Detail Governance Tabs

- Goal: consolidate user role, job, region, sessions, and security management.
- Scope: user detail UI composition.
- Deliverables:
  - user detail subviews or tabs for governance data
- Dependencies: AWM-050, AWM-058, AWM-066, AWM-078
- Acceptance Criteria:
  - user governance operations are discoverable from one place
- Suggested Validation:
  - manual UI walkthrough

### AWM-087: Add Role Assignment UI to User Detail

- Goal: allow direct role assignment from user management.
- Scope: user detail role controls.
- Deliverables:
  - role assignment form
- Dependencies: AWM-030, AWM-032, AWM-086
- Acceptance Criteria:
  - role changes honor protected-role guardrails
- Suggested Validation:
  - manual UI flow test

### AWM-088: Add Permission Matrix Diff Preview UX

- Goal: make permission changes safer to review.
- Scope: matrix UX improvement.
- Deliverables:
  - staged diff preview before apply
- Dependencies: AWM-033, AWM-082
- Acceptance Criteria:
  - operators can see exact permission changes before commit
- Suggested Validation:
  - manual matrix edit test

### AWM-089: Add Session and Login History UI on User Detail

- Goal: expose active sessions and auth history.
- Scope: user detail read/manage UI.
- Deliverables:
  - active sessions view
  - login security events view
- Dependencies: AWM-017, AWM-015, AWM-086
- Acceptance Criteria:
  - admins can inspect and revoke sessions
  - login events are visible with timestamps and outcomes
- Suggested Validation:
  - manual UI test

### AWM-090: Add Protected Action Confirmation UX

- Goal: reduce accidental dangerous admin actions.
- Scope: confirmation UX for protected operations.
- Deliverables:
  - protected action confirmation modal/pattern
- Dependencies: AWM-034, AWM-077, AWM-086
- Acceptance Criteria:
  - destructive or high-risk actions require explicit confirmation
- Suggested Validation:
  - manual UI negative testing

## E11. Plugin Governance Contract

### AWM-091: Define Plugin Permission Registration Contract

- Goal: let plugins declare permissions consistently.
- Scope: design and implementation contract.
- Deliverables:
  - plugin permission registration API or manifest convention
  - developer documentation
- Dependencies: AWM-003, AWM-031
- Acceptance Criteria:
  - plugin permissions enter the same catalog model as core permissions
- Suggested Validation:
  - unit test with sample plugin declaration

### AWM-092: Define Plugin Route Authorization Helper

- Goal: make plugin route protection consistent with core admin routes.
- Scope: helper implementation.
- Deliverables:
  - route guard helper for plugins
- Dependencies: AWM-041, AWM-091
- Acceptance Criteria:
  - plugin routes can declare required permission and optional scope needs
- Suggested Validation:
  - integration test with sample plugin route

### AWM-093: Define Plugin Service Authorization Helper

- Goal: make plugin business logic use shared policy evaluation.
- Scope: helper implementation.
- Deliverables:
  - plugin service auth helper
- Dependencies: AWM-036, AWM-091
- Acceptance Criteria:
  - plugins can evaluate auth without querying governance tables directly
- Suggested Validation:
  - unit test with sample plugin service

### AWM-094: Define Plugin Audit Helper

- Goal: make plugin actions auditable.
- Scope: helper implementation.
- Deliverables:
  - plugin audit append helper
- Dependencies: AWM-080, AWM-091
- Acceptance Criteria:
  - plugin actions can write consistent audit events
- Suggested Validation:
  - unit test with sample plugin action

### AWM-095: Define Plugin Region-Awareness Helper

- Goal: support governance-aware plugin scoping.
- Scope: helper implementation.
- Deliverables:
  - region scope helper for plugins
- Dependencies: AWM-056, AWM-064, AWM-093
- Acceptance Criteria:
  - plugins can evaluate logical and administrative scope through supported APIs
- Suggested Validation:
  - unit test with sample plugin scope evaluation

### AWM-096: Validate Governance Contract with One Internal Sample Plugin

- Goal: prove the plugin contract works in practice.
- Scope: one small trusted internal plugin.
- Deliverables:
  - sample plugin using permission registration, route guard, service auth, and audit helper
- Dependencies: AWM-092, AWM-093, AWM-094, AWM-095
- Acceptance Criteria:
  - sample plugin can be installed/enabled and respects governance rules
- Suggested Validation:
  - integration test and manual smoke test

## E12. Rollout Safety and Docs

### AWM-097: Add ABAC Feature Flags and Audit-Only Mode

- Goal: roll out policy enforcement safely.
- Scope: runtime flags and non-blocking mode where useful.
- Deliverables:
  - feature flag definitions
  - audit-only evaluation path
- Dependencies: AWM-041, AWM-080
- Acceptance Criteria:
  - selected policy paths can log without blocking
- Suggested Validation:
  - feature flag integration tests

### AWM-098: Add Staged Mandatory 2FA Enforcement Controls

- Goal: allow gradual security rollout by role.
- Scope: security policy configuration.
- Deliverables:
  - per-role or grouped mandatory 2FA settings
- Dependencies: AWM-078
- Acceptance Criteria:
  - 2FA enforcement can be enabled for protected roles first
- Suggested Validation:
  - manual policy rollout test

### AWM-099: Create Emergency Recovery and Rollback Runbook

- Goal: document safe recovery procedures.
- Scope: operator docs only.
- Deliverables:
  - runbook for owner recovery, lockout recovery, 2FA reset recovery, rollback checkpoints
- Dependencies: AWM-077, AWM-098
- Acceptance Criteria:
  - recovery steps are explicit and ordered
  - runbook avoids destructive shortcuts
- Suggested Validation:
  - tabletop review

### AWM-100: Create Migration and Deployment Validation Checklist

- Goal: standardize pre-deploy and post-deploy validation.
- Scope: operator docs only.
- Deliverables:
  - migration/deploy checklist
- Dependencies: AWM-006, AWM-097, AWM-098
- Acceptance Criteria:
  - checklist includes schema, auth, RBAC, ABAC, regions, 2FA, audit, and plugin checks
- Suggested Validation:
  - checklist review against plan

### AWM-101: Create Governance and Admin Operations Documentation Set

- Goal: make the finished system operable.
- Scope: documentation set only.
- Deliverables:
  - architecture overview
  - auth and authorization docs
  - roles docs
  - jobs docs
  - regions docs
  - security docs
  - plugin contract docs
  - admin operations guide
- Dependencies: AWM-096, AWM-100
- Acceptance Criteria:
  - each document distinguishes EmDash core from Mini overlay
- Suggested Validation:
  - docs completeness review

## Suggested Execution Order

1. E0 Foundation Decisions
2. E1 Runtime and Database Bootstrap
3. E2 Identity and Session Core
4. E3 RBAC Core
5. E4 ABAC Core
6. E5 Jobs Hierarchy
7. E6 Logical Regions
8. E7 Administrative Regions
9. E8 Security Hardening
10. E9 Audit and Observability
11. E10 Admin Surfaces
12. E11 Plugin Governance Contract
13. E12 Rollout Safety and Docs

## Recommended First Sprint Slice

If implementation begins immediately, the first delivery slice should include:

- AWM-001
- AWM-002
- AWM-003
- AWM-004
- AWM-005
- AWM-006
- AWM-007
- AWM-008
- AWM-009
- AWM-010
- AWM-011
- AWM-012
- AWM-013
- AWM-014
- AWM-015
- AWM-016
- AWM-017
- AWM-018
- AWM-019

That slice establishes the repo contract, runtime scaffold, database baseline, identity tables, core services, and initial users admin view without prematurely pulling in the governance overlays.
