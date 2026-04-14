# AWCMS Mini — EmDash-First Implementation Planning Prompt

## Project Title

AWCMS Mini: EmDash-First, Single-Tenant CMS Foundation with AWCMS Governance Overlays

---

## Purpose

Create a production-oriented implementation plan for **AWCMS Mini** based on **EmDash architecture** as the canonical foundation.

emdash local repository : `/home/data/dev_react/emdash-awcms/`

awcms local repository : `/home/data/dev_react/awcms-dev/`

The plan must keep AWCMS Mini **strictly aligned with EmDash core architecture, modules, and plugin model**, while selectively adopting **non-conflicting AWCMS governance concepts** such as:

- ABAC authorization style
- roles hierarchy and staff levels
- user job levels and job titles
- dual-region governance (logical/detail regions and administrative regions)
- permission matrix
- user management
- 2FA
- audit/security discipline

The output must be a **complete and detailed implementation plan**, not code.

---

## Core Architectural Rule

AWCMS Mini is **EmDash-first**.

This means:

1. **EmDash is the host architecture and source of truth for CMS structure**.
2. **Do not port AWCMS modules/resources into Mini unless they already exist in EmDash core or can be implemented naturally as EmDash-compatible plugins/extensions**.
3. **Any AWCMS concept may be used only if it does not conflict with EmDash architecture**.
4. **If there is any conflict, EmDash architecture wins**.

---

## High-Level Definition of AWCMS Mini

AWCMS Mini is a:

- single-tenant system
- EmDash-based CMS foundation
- PostgreSQL-backed application
- Kysely-based SQL/query/migration architecture
- plugin-extensible system
- non-Supabase implementation
- no visual editor in v1
- governance-enhanced CMS using selected AWCMS concepts without bringing over multi-tenant complexity

---

## Canonical Technical Direction

The implementation plan must assume the following target stack and constraints:

### Foundation

- **Host Architecture:** EmDash
- **Database:** PostgreSQL
- **Query / DB Layer:** Kysely
- **Runtime:** follow EmDash architecture and preferred supported runtime
- **System Type:** single-tenant only
- **Version 1 Scope:** no visual editor

### Core Direction

- Follow EmDash content, admin, auth, plugin, and collection architecture
- Use EmDash-native or EmDash-compatible extension points
- Keep Kysely as the canonical SQL/migration/query layer
- Do not recreate AWCMS as a parallel core framework

---

## Main Objective

Produce a **complete implementation planning document** for building AWCMS Mini so that the result is:

- clean
- maintainable
- secure
- scalable enough for moderate plugin growth and transactions
- architecturally consistent
- easy to implement in phases
- safe from AWCMS/EmDash architectural conflict

---

## Required Planning Output Structure

The planning output must contain the following sections in detail.

## 1. Executive Summary

Explain:

- what AWCMS Mini is
- why EmDash is the foundation
- why AWCMS concepts are only overlays
- why multi-tenant AWCMS features are excluded
- why no visual editor is included in v1
- why PostgreSQL + Kysely is used

## 2. Scope and Boundaries

Clearly define:

### In scope

Only what is allowed in v1, including:

- EmDash core foundation
- EmDash-compatible plugin architecture
- auth/user management enhancements
- ABAC overlay
- roles and staff levels
- user jobs hierarchy
- dual regions hierarchy
- permission matrix
- 2FA
- audit and security controls

### Out of scope

Must explicitly exclude:

- multi-tenant logic
- tenant-scoped modules/resources
- Supabase
- visual editor
- AWCMS module porting outside EmDash model
- competing admin architecture
- marketplace-grade untrusted plugin sandboxing in v1
- broad ERP scope that exceeds CMS-first architecture

## 3. Architectural Principles

Define principles such as:

- EmDash-first architecture
- single-tenant simplicity
- governance overlays only
- SQL transparency through Kysely
- backend-enforced authorization
- plugin compatibility over platform sprawl
- minimal conflict with upstream EmDash
- fixed operational scope before dynamic expansion

## 4. Allowed vs Forbidden Design Rules

Create a strict rules table with columns:

- Rule Area
- Allowed
- Forbidden
- Rationale

Cover at least:

- modules
- resources
- auth
- permissions
- plugins
- admin screens
- region handling
- schema design
- transaction logic
- reporting
- job hierarchy
- role hierarchy

## 5. Foundation Architecture Map

Describe the architecture layers:

### Host Layer

EmDash core

### Database Layer

PostgreSQL + Kysely

### Governance Layer

AWCMS-derived non-conflicting concepts:

- ABAC
- roles hierarchy
- job hierarchy
- dual regions
- audit/security

### Extension Layer

EmDash-compatible internal plugins

### Admin Layer

EmDash admin extended carefully

### Public Layer

Follow EmDash public/content rendering architecture

## 6. Module and Capability Inventory

List only capabilities that are valid because they already exist in EmDash core or are reasonable EmDash-compatible extensions.

For each capability include:

- capability name
- whether it is EmDash core or plugin extension
- whether it is mandatory for v1
- whether it is governance-only overlay
- notes on implementation boundaries

Must include at least:

- users
- auth
- roles
- permissions
- pages/posts/collections if aligned with EmDash
- media
- settings
- plugins
- audit logs
- region governance
- jobs hierarchy

## 7. Data Model Planning

Provide a detailed database planning section for PostgreSQL + Kysely.

The plan must cover:

### Core identity/auth tables

Examples:

- users
- sessions
- login/security events
- 2FA credentials
- recovery codes

### Authorization tables

Examples:

- roles
- permissions
- user_roles
- role_permissions

### Governance tables

Examples:

- job_levels
- job_titles
- user_jobs
- regions
- administrative_regions
- user_region_assignments
- user_administrative_region_assignments

### Supporting controls

Examples:

- audit_logs
- approval rules if needed
- security_events

For each table, the planning must include:

- purpose
- key columns
- relationships
- constraints
- indexes
- notes on soft delete if relevant
- whether it is EmDash-native support data or AWCMS governance overlay

## 8. Roles Hierarchy Planning

Plan the implementation of AWCMS-style role staff levels.

Requirements:

- keep the 10-level staff hierarchy concept
- explain role metadata such as `staff_level`
- explain how role levels affect authority and workflow
- separate role hierarchy from job hierarchy
- define protected role rules
- define default roles for v1

Also include an example default role catalog for AWCMS Mini.

## 9. User Jobs Hierarchy Planning

Plan a separate organizational structure for users.

Must include:

- why job hierarchy is separate from roles
- job_levels design
- job_titles design
- user_jobs design
- supervisor/reporting line logic
- effective date/history support
- how job data can influence ABAC context without becoming the primary authorization source

## 10. Dual Regions Planning

Plan both region systems exactly as governance overlays.

### Logical / detail regions

- 10-level operational hierarchy
- used for business/organizational scope

### Administrative regions

- Indonesian legal hierarchy
- province / regency-city / district / village

Must include:

- recommended tables
- hierarchy logic
- parent-child relationship model
- path strategy
- inheritance rules
- assignment model to users
- practical examples
- when to use logical regions vs administrative regions

## 11. ABAC Planning

Design a hybrid **RBAC + ABAC** authorization model.

Must include:

- permission naming convention using `scope.resource.action`
- RBAC baseline
- ABAC refinement
- subject attributes
- resource attributes
- context attributes
- region-based constraints
- role-level constraints
- job-level contextual constraints
- ownership rules
- sensitive action rules
- step-up auth rules

Must also include:

- evaluation flow
- allow/deny reasoning model
- caching and invalidation recommendations
- backend/service-layer enforcement strategy
- optional selective PostgreSQL RLS later, but not as the core v1 model

## 12. Permission Matrix Planning

Create a detailed plan for a permission matrix system.

Must include:

- role columns
- permission rows grouped by domain/module
- protected permissions
- inheritance/effective permission view
- admin UX behavior
- safe update flows
- audit log integration
- examples of permission groups

## 13. User Management Planning

Provide a full plan for user management.

Must include:

- create user
- invite user
- disable/lock user
- activate user
- assign role
- assign job
- assign logical region
- assign administrative region
- reset password
- force password reset
- force or reset 2FA
- revoke sessions
- user self-service profile management
- login history and security logs

## 14. 2FA and Security Planning

Design a production-friendly v1 plan for 2FA.

Must include:

- TOTP-first approach
- enrollment flow
- verification flow
- recovery codes
- trusted device/session strategy
- admin recovery/reset flow
- when 2FA is mandatory
- step-up auth for sensitive actions
- WebAuthn/passkeys as phase 2 only

Also include broader security planning:

- password hashing expectations
- rate limiting
- lockout strategy
- audit logging
- brute force protection
- admin action confirmation rules

## 15. Plugin Compatibility Planning

Since Mini must follow EmDash plugin architecture, provide a section describing how governance overlays integrate into plugins without conflicting with EmDash.

Must include:

- plugin permission registration
- plugin route guards
- plugin service authorization hooks
- plugin region awareness
- plugin transaction rules
- plugin security expectations
- distinction between safe internal plugins and broader plugin ambitions

## 16. Transactions and Data Integrity Planning

Explain how transactional features should be handled in AWCMS Mini.

Must include:

- when to use Kysely transactions
- multi-step admin actions
- consistency for security-sensitive changes
- approval and reassignment flows
- audit-safe transaction boundaries
- savepoints if needed
- what types of transactional modules are still safe inside Mini v1
- what transaction-heavy business domains should be deferred or isolated

## 17. Admin UI Planning

Create a screen-level planning section.

Must include:

- users screen
- roles screen
- permission matrix screen
- jobs/job titles/job levels screens
- logical regions screen
- administrative regions screen
- security settings / 2FA management screen
- audit logs screen

For each screen include:

- purpose
- primary actions
- critical constraints
- notes about what is EmDash extension vs governance overlay

## 18. API / Service Planning

Plan backend service boundaries.

Must include:

- auth service
- authorization service
- role service
- user service
- jobs service
- regions service
- administrative regions service
- security service
- audit service

For each service define:

- responsibility
- key operations
- transaction needs
- ABAC responsibilities
- plugin integration considerations

## 19. Migration and Implementation Phases

Provide a phase-by-phase implementation roadmap.

Must include at least:

### Phase 1

Foundation auth and users

### Phase 2

Roles, permissions, matrix

### Phase 3

ABAC core

### Phase 4

Jobs hierarchy

### Phase 5

Dual regions

### Phase 6

2FA and security hardening

### Phase 7

Plugin integration and policy propagation

For each phase include:

- objective
- tasks
- dependencies
- risks
- expected outcome

## 20. Testing and Validation Plan

Create a detailed validation checklist.

Must include:

- schema validation
- migration validation
- permission tests
- ABAC tests
- region inheritance tests
- role level tests
- job context tests
- 2FA tests
- audit log tests
- transaction rollback tests
- plugin authorization tests

Also include:

- manual QA scenarios
- regression priorities
- expected acceptance criteria

## 21. Documentation Plan

Specify which documents should exist in AWCMS Mini.

At minimum include:

- architecture overview
- auth and authorization docs
- roles hierarchy docs
- jobs hierarchy docs
- regions docs
- security docs
- plugin integration contract
- migration guide
- admin operation guide

## 22. Risks, Trade-offs, and Non-Goals

Provide a realistic section explaining:

- why AWCMS Mini should not attempt to become full AWCMS
- why multi-tenant features are excluded
- why no visual editor is included in v1
- why pure ABAC-only UI is not recommended in v1
- why universal RLS is not necessary in v1
- why role hierarchy and job hierarchy must be separate
- why EmDash architecture must remain dominant

## 23. Rollback and Safety Strategy

Explain how to deploy and roll back safely.

Must include:

- additive migrations first
- feature flags where useful
- audit-only mode for policy rollout where possible
- staged activation of 2FA enforcement
- emergency owner/admin recovery strategy
- controlled rollout of region ABAC

## 24. Final Recommended Architecture Decision

End with a clear final recommendation statement that summarizes:

- EmDash-first architecture
- PostgreSQL + Kysely
- single-tenant only
- no AWCMS module/resource porting beyond EmDash core/plugin model
- AWCMS governance overlays only where non-conflicting
- no visual editor in v1
- phased implementation strategy

---

## Specific Planning Requirements

The planning output must be:

- fully in English
- highly detailed
- implementation-oriented
- structured and easy to hand to a coding agent
- opinionated where needed
- explicit about conflicts and exclusions
- realistic about risks and scope
- consistent with EmDash-first architecture

---

## Important Constraints

The planning must obey all of the following:

1. **Do not propose importing all AWCMS modules/resources into Mini.**
2. **Do not propose multi-tenant logic.**
3. **Do not propose Supabase.**
4. **Do not propose a separate competing admin architecture outside EmDash.**
5. **Do not propose the visual editor for v1.**
6. **Do not blur the line between roles and jobs.**
7. **Do not collapse logical/detail regions into administrative regions.**
8. **Do not make PostgreSQL RLS the main v1 authorization mechanism.**
9. **Do not design Mini as a generic ERP platform.**
10. **Do not create AWCMS-specific modules unless they are expressed as EmDash-compatible plugins/extensions or purely governance support structures.**

---

## Desired Tone and Output Style

The planning document should read like a professional architecture and implementation planning brief.

It should be:

- direct
- precise
- explicit
- structured
- detailed
- realistic
- suitable for handing to an implementation agent

---

## Final Instruction to the Implementing Agent

Using all constraints above, produce a **complete, detailed, production-oriented implementation planning document** for **AWCMS Mini**, ensuring that:

- EmDash remains the canonical architecture
- PostgreSQL + Kysely remain the canonical data/query foundation
- AWCMS concepts are used only as non-conflicting overlays
- only EmDash core modules and EmDash-compatible plugins/extensions are used
- authorization, hierarchy, regions, and security are planned in enough detail to implement safely
- the plan is structured, phased, and actionable
- the plan is suitable to execute step by step in a real repository
