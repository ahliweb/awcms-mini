import { defineModule } from "../_shared/module-contract";

export const moduleManagementModule = defineModule({
  key: "module_management",
  name: "Module Management",
  version: "0.1.0",
  status: "active",
  description:
    "Database-backed, tenant-aware module registry (epic #510): syncs trusted code descriptors (`listModules()`) into the database, tracks per-tenant module enablement, dependency validation, non-secret settings, permission sync/status, admin navigation, job/command registry, and health/readiness. Generic infrastructure for managing every other registered module — not a domain-specific feature. Module catalog API (`GET /api/v1/modules[/{moduleKey}]`, `POST /api/v1/modules/sync`) added Issue #514.",
  dependencies: ["tenant_admin", "identity_access"],
  type: "system",
  isCore: true,
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1/modules"
  },
  navigation: [
    {
      labelKey: "admin.layout.nav_modules",
      path: "/admin/modules",
      order: 50,
      requiredPermission: "module_management.modules.read"
    }
  ],
  permissions: [
    {
      activityCode: "modules",
      action: "read",
      description: "Read the module registry"
    },
    {
      activityCode: "modules",
      action: "sync",
      description: "Sync trusted code descriptors into the database registry"
    },
    {
      activityCode: "tenant_modules",
      action: "read",
      description: "Read tenant module enablement state"
    },
    {
      activityCode: "tenant_modules",
      action: "enable",
      description: "Enable a module for a tenant"
    },
    {
      activityCode: "tenant_modules",
      action: "disable",
      description: "Disable a module for a tenant"
    },
    {
      activityCode: "settings",
      action: "read",
      description: "Read effective tenant module settings"
    },
    {
      activityCode: "settings",
      action: "update",
      description: "Update tenant module settings"
    },
    {
      activityCode: "permissions",
      action: "read",
      description: "Read module permission sync/status"
    },
    {
      activityCode: "navigation",
      action: "read",
      description: "Read the module admin navigation registry"
    },
    {
      activityCode: "jobs",
      action: "read",
      description: "Read the module job/command registry"
    },
    {
      activityCode: "health",
      action: "read",
      description: "Read module health/readiness status"
    },
    {
      activityCode: "health",
      action: "check",
      description: "Trigger a module health check"
    }
  ],
  jobs: [
    {
      command: "bun run security:readiness",
      purpose:
        "Run the go-live security readiness checklist (RLS, RBAC/ABAC, secrets, env) against the real codebase/database/environment. Any critical failure blocks go-live.",
      recommendedSchedule:
        "On-demand — before go-live, and periodically (e.g. weekly) in staging/production to catch drift.",
      environmentNotes: "Requires DATABASE_URL to be reachable.",
      safeInOfflineLan: true
    },
    {
      command: "bun run config:validate",
      purpose:
        "Validate required/conditional environment variables at boot time before anything attempts to connect to a database or run migrations.",
      recommendedSchedule:
        "On-demand — run before every deploy, first stage of `production:preflight`.",
      environmentNotes: "No database connection required.",
      safeInOfflineLan: true
    },
    {
      command: "bun run production:preflight",
      purpose:
        "Orchestrate the full go-live checklist in order (config:validate, db:migrate, api:spec:check, bun test, build, db:pool:health, security:readiness) and print an aggregated go/no-go verdict.",
      recommendedSchedule:
        "On-demand — before every production deploy/go-live.",
      environmentNotes:
        "db:pool:health is skipped (not failed) when no server is reachable, e.g. in a CI preflight run.",
      safeInOfflineLan: true
    }
  ]
});
