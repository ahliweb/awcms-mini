import { defineModule } from "../_shared/module-contract";

export const syncStorageModule = defineModule({
  key: "sync_storage",
  name: "Sync Storage",
  version: "1.0.0",
  status: "active",
  description:
    "Offline-first sync nodes, outbox/inbox event exchange, and HMAC-signed push/pull with anti-replay.",
  dependencies: ["tenant_admin"],
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1/sync"
  }
});
