import type { ModuleDescriptor } from "../_shared/module-contract";

export const databaseConnectivityModule: ModuleDescriptor = {
  key: "database_connectivity",
  name: "Database Connectivity",
  version: "0.1.0",
  status: "experimental",
  description: "Pooling work-class, antrean + backpressure, circuit breaker, PgBouncer profile, pool health.",
  dependencies: ["observability_logging"],
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1"
  },
  events: {
    asyncApiPath: "asyncapi/awcms-mini-domain-events.asyncapi.yaml",
    publishes: [
        "database.pool.saturated"
    ],
    subscribes: []
  }
};
