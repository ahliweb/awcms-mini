import type { ModuleDescriptor } from "../_shared/module-contract";

export const syncStorageModule: ModuleDescriptor = {
  key: "sync_storage",
  name: "Sync Storage",
  version: "0.1.0",
  status: "experimental",
  description: "Offline-first sync: node, outbox/inbox HMAC-signed, conflict manual, object queue R2 opsional.",
  dependencies: ["tenant_admin","observability_logging"],
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1"
  },
  events: {
    asyncApiPath: "asyncapi/awcms-mini-domain-events.asyncapi.yaml",
    publishes: [
        "sync.conflict.detected"
    ],
    subscribes: []
  }
};
