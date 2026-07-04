import { defineModule } from "./_shared/module-contract.mjs";

export const modules = Object.freeze([
  defineModule({
    key: "identity_access",
    name: "Identity & Access",
    version: "0.1.0",
    status: "active",
    description: "User lifecycle, login/session controls, RBAC, ABAC, and protected role governance.",
    dependencies: ["audit_observability"],
    capabilities: ["auth", "sessions", "rbac", "abac", "step_up", "two_factor"],
    api: { basePath: "/api/v1/auth" },
    events: {
      publishes: ["identity.login_succeeded", "identity.login_failed", "identity.session_revoked"],
      subscribes: [],
    },
    security: {
      scopeModel: "single_tenant",
      authorization: "rbac_abac",
      audit: "required",
    },
  }),
  defineModule({
    key: "governance_catalog",
    name: "Governance Catalog",
    version: "0.1.0",
    status: "active",
    description: "Roles, permissions, jobs, logical regions, and administrative regions.",
    dependencies: ["identity_access", "audit_observability"],
    capabilities: ["roles", "permissions", "jobs", "logical_regions", "administrative_regions"],
    api: { basePath: "/api/v1" },
    events: {
      publishes: ["governance.role_assigned", "governance.region_assignment_changed"],
      subscribes: [],
    },
    security: {
      scopeModel: "single_tenant",
      authorization: "rbac_abac",
      audit: "required",
    },
  }),
  defineModule({
    key: "audit_observability",
    name: "Audit & Observability",
    version: "0.1.0",
    status: "active",
    description: "Structured logging, audit logs, security events, request IDs, and operator diagnostics.",
    dependencies: [],
    capabilities: ["audit_logs", "security_events", "structured_logging", "request_correlation"],
    api: { basePath: "/api/v1/security" },
    events: {
      publishes: ["audit.log_recorded", "security.event_recorded"],
      subscribes: [],
    },
    security: {
      scopeModel: "single_tenant",
      authorization: "rbac_abac",
      audit: "required",
    },
  }),
  defineModule({
    key: "storage_delivery",
    name: "Storage & Delivery",
    version: "0.1.0",
    status: "active",
    description: "R2-backed file metadata, safe access tokens, notifications, message templates, and webhooks.",
    dependencies: ["identity_access", "audit_observability"],
    capabilities: ["file_objects", "signed_access", "notifications", "message_templates", "webhooks"],
    api: { basePath: "/api/v1" },
    events: {
      publishes: ["storage.file_registered", "notification.delivery_requested"],
      subscribes: [],
    },
    security: {
      scopeModel: "single_tenant",
      authorization: "rbac_abac",
      audit: "required",
    },
  }),
  defineModule({
    key: "plugin_runtime",
    name: "Plugin Runtime",
    version: "0.1.0",
    status: "active",
    description: "Native internal plugin manifest contract, registration, route authorization, audit, and RLS helpers.",
    dependencies: ["identity_access", "governance_catalog", "audit_observability"],
    capabilities: ["plugin_manifest", "permission_registration", "route_authorization", "service_authorization"],
    events: {
      publishes: ["plugin.registered", "plugin.permission_registered"],
      subscribes: [],
    },
    security: {
      scopeModel: "single_tenant",
      authorization: "rbac_abac",
      audit: "required",
    },
  }),
  defineModule({
    key: "search_query",
    name: "Search Query",
    version: "0.1.0",
    status: "active",
    description: "CQRS read-only search contracts and safe projection builders.",
    dependencies: ["identity_access", "audit_observability"],
    capabilities: ["read_projection", "sort_whitelist", "sensitive_field_exclusion"],
    api: { basePath: "/api/v1/search" },
    events: {
      publishes: [],
      subscribes: [],
    },
    security: {
      scopeModel: "single_tenant",
      authorization: "rbac_abac",
      audit: "required",
    },
  }),
]);

export function listModules() {
  return [...modules];
}

export function getModuleByKey(moduleKey) {
  return modules.find((module) => module.key === moduleKey);
}
